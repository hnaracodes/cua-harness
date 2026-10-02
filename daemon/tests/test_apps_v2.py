"""Native app routing v2: catalog + denylist, planner/replanner app field, store, API,
executor routing by the step's app. Fakes only: no cua-driver, no network."""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any

import pytest
from fastapi.testclient import TestClient

from oversight import api as api_module
from oversight import apps, fixtures
from oversight.api import create_app
from oversight.executor import ExecConfig, ExecStep, run_steps
from oversight.llm import CallRecord
from oversight.planner import PlannedStep, plan_task
from oversight.replanner import merge_revision, replan
from oversight.settings import Settings
from oversight.store import Store

MESSAGES = {"name": "Messages", "bundle_id": "com.apple.MobileSMS"}
NOTES = {"name": "Notes", "bundle_id": "com.apple.Notes"}
CATALOG = [MESSAGES, NOTES]

RAW = {"apps": [
    {"name": "Terminal", "bundle_id": "com.apple.Terminal"},
    {"name": "Notes", "bundle_id": "com.apple.Notes"},
    {"name": "Agent Oversight", "bundle_id": "edu.cmu.sketch-oversight.agent-oversight"},
    {"name": "Messages", "bundle_id": "com.apple.MobileSMS"},
    {"name": "Messages", "bundle_id": "com.apple.MobileSMS"},
    {"name": "cua", "bundle_id": "com.trycua.driver"},
    {"name": "", "bundle_id": "x.y"},
]}


# ------------------------------------------------------------------ catalog

def test_is_denied() -> None:
    assert apps.is_denied("com.apple.Terminal")
    assert apps.is_denied("com.googlecode.iterm2")
    assert apps.is_denied("edu.cmu.sketch-oversight")
    assert apps.is_denied("edu.cmu.sketch-oversight.agent-oversight")
    assert apps.is_denied("org.example.agent-oversight-dev")
    assert not apps.is_denied("com.apple.MobileSMS")
    assert not apps.is_denied(None)


def test_build_catalog_filters_sorts_dedupes_and_caps() -> None:
    assert apps.build_catalog(RAW) == [MESSAGES, NOTES]
    many = {"apps": [{"name": f"App {i:03}", "bundle_id": f"b.{i}"} for i in range(120, 0, -1)]}
    cat = apps.build_catalog(many)
    assert len(cat) == min(120, apps.CATALOG_MAX) and cat[0]["name"] == "App 001"
    assert apps.build_catalog({"text": "nope"}) == []


class CatDriver:
    def __init__(self, raw: Any = RAW, fail: bool = False) -> None:
        self.raw, self.fail, self.n = raw, fail, 0

    async def call(self, tool: str, args: dict) -> dict:
        assert tool == "list_apps" and args == {}
        self.n += 1
        if self.fail:
            raise RuntimeError("cua-driver down")
        return self.raw


@pytest.mark.real_catalog
def test_app_catalog_caches_and_swallows_errors() -> None:
    apps.clear_cache()
    try:
        assert asyncio.run(apps.app_catalog(CatDriver(fail=True))) == []
        d = CatDriver()
        assert asyncio.run(apps.app_catalog(d)) == [MESSAGES, NOTES]
        assert asyncio.run(apps.app_catalog(d)) == [MESSAGES, NOTES]
        assert d.n == 1
    finally:
        apps.clear_cache()


def test_resolve_app() -> None:
    assert apps.resolve_app("messages", CATALOG) == MESSAGES
    assert apps.resolve_app("COM.APPLE.NOTES", CATALOG) == NOTES
    assert apps.resolve_app("Mail", CATALOG) is None
    assert apps.resolve_app(None, CATALOG) is None
    assert apps.resolve_app("Terminal", [{"name": "Terminal", "bundle_id": "com.apple.Terminal"}]) is None


# ------------------------------------------------------------------ planner / replanner

class FakeLLM:
    def __init__(self, data: dict) -> None:
        self.data = data
        self.calls: list[dict] = []

    async def call(self, **kw: Any):
        self.calls.append(kw)
        return self.data, CallRecord(scope="plan", provider="fake", model="fake")


def _plan_data(apps_: list[Any]) -> dict:
    return {"steps": [{"title": f"Step {i}", "description": "Do it.", "glyph": "generic", "app": a}
                      for i, a in enumerate(apps_)]}


def test_planner_resolves_apps_and_lists_catalog() -> None:
    llm = FakeLLM(_plan_data(["messages", None, "Terminal", "Mail"]))
    out = asyncio.run(plan_task(llm, "text Amogh via iMessage", None, catalog=CATALOG))
    assert [s.app for s in out] == [MESSAGES, None, None, None]
    sys = llm.calls[0]["system"]
    assert "Messages, Notes" in sys and "Never pick an app that is not listed" in sys
    item = llm.calls[0]["schema"]["properties"]["steps"]["items"]
    assert item["properties"]["app"] == {"type": ["string", "null"]} and "app" in item["required"]


def test_planner_without_catalog_gives_null_apps() -> None:
    llm = FakeLLM(_plan_data(["Messages"] * 4))
    out = asyncio.run(plan_task(llm, "p", None))
    assert all(s.app is None for s in out)
    assert "Installed apps" not in llm.calls[0]["system"]


def _cur() -> list[dict]:
    return [{"id": f"s{i}", "task_id": "t", "index": i, "title": f"Step {i}", "description": "Do it.",
             "glyph": "generic", "status": "pending", "edited_from": None, "revision": 0,
             "app": MESSAGES if i == 1 else None} for i in range(1, 5)]


def test_replan_carries_apps() -> None:
    cur = _cur()
    data = {"steps": [
        {"keep_step_id": "s1", "title": "Step 1", "description": "Do it.", "glyph": "generic", "app": None},
        {"keep_step_id": "s2", "title": "Step 2 new", "description": "Do it.", "glyph": "generic",
         "app": "Notes"},
        {"keep_step_id": "s3", "title": "Step 3", "description": "Do it.", "glyph": "generic", "app": None},
        {"keep_step_id": None, "title": "Text Amogh", "description": "In Messages.", "glyph": "send",
         "app": "Messages"},
    ]}
    llm = FakeLLM(data)
    rev = asyncio.run(replan(llm, "p", cur, "use notes", catalog=CATALOG))
    assert "[app: Messages]" in llm.calls[0]["user"]
    assert "Messages, Notes" in llm.calls[0]["system"]
    m = merge_revision("t", cur, rev)
    by_title = {s["title"]: s for s in m.steps}
    assert by_title["Step 1"]["app"] == MESSAGES  # unchanged text keeps its app
    assert by_title["Step 2 new"]["app"] == NOTES
    assert by_title["Text Amogh"]["app"] == MESSAGES


# ------------------------------------------------------------------ store

def test_store_round_trips_app_and_migrates_old_db(tmp_path) -> None:
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.executescript("""CREATE TABLE steps (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        idx INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, glyph TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', edited_from TEXT, revision INTEGER NOT NULL DEFAULT 0);
        INSERT INTO steps (id, task_id, idx, title, description, glyph) VALUES ('old','t',1,'a','b','generic');""")
    con.commit()
    con.close()
    st = Store(db)
    assert st.get_steps("t")[0]["app"] is None
    tid = st.create_task("p", None, "live")
    st.replace_plan(tid, [{**s, "task_id": tid} for s in _cur()], [])
    got = st.get_steps(tid)
    assert got[0]["app"] == MESSAGES and got[1]["app"] is None
    st.update_step("s1", "New", "New desc", "Step 1")
    assert st.get_steps(tid)[0]["app"] == MESSAGES
    Store(db)  # re-opening an already migrated DB is fine


# ------------------------------------------------------------------ API

def test_api_fixtures_steps_have_null_app(tmp_path) -> None:
    with TestClient(create_app(Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path))) as c:
        tid = c.post("/task", json={"prompt": "p"}).json()["task_id"]
        r = c.post(f"/task/{tid}/plan").json()
        assert all("app" in s and s["app"] is None for s in r["steps"])


def test_api_plan_live_passes_catalog_and_returns_app(tmp_path, monkeypatch) -> None:
    seen: dict = {}

    async def fake_catalog(driver=None):
        return CATALOG

    async def fake_plan_task(llm, prompt, selected_app, on_call=None, images=(), catalog=()):
        seen["catalog"] = list(catalog)
        return [PlannedStep(f"Step {i}", "Do it.", "generic", MESSAGES if i == 0 else None)
                for i in range(4)]

    class FakeScorer:
        def __init__(self, *a, **k):
            pass

        async def score(self, task, step, context):
            return fixtures.synthetic_scores(step.id, step.title)

    monkeypatch.setattr(apps, "app_catalog", fake_catalog)
    monkeypatch.setattr(api_module, "plan_task", fake_plan_task)
    monkeypatch.setattr(api_module, "LLMScorer", FakeScorer)
    s = Settings(fixtures=False, exec_mode="simulated", data_dir=tmp_path,
                 provider="anthropic", model="claude-sonnet-5-5")
    with TestClient(create_app(s)) as c:
        tid = c.post("/task", json={"prompt": "p"}).json()["task_id"]
        r = c.post(f"/task/{tid}/plan")
        assert r.status_code == 200, r.text
        assert seen["catalog"] == CATALOG
        steps = r.json()["steps"]
        assert steps[0]["app"] == MESSAGES and steps[1]["app"] is None
        got = c.get(f"/task/{tid}").json()["steps"]
        assert got[0]["app"] == MESSAGES
        p = c.patch(f"/task/{tid}/step/{steps[0]['id']}", json={"title": "Text Amogh"})
        assert p.status_code == 200, p.text
        assert p.json()["step"]["app"] == MESSAGES


# ------------------------------------------------------------------ executor

class Rec:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def __call__(self, kind: str, payload: dict) -> None:
        self.events.append((kind, payload))


def test_denied_app_step_fails_without_running() -> None:
    rec = Rec()
    step = ExecStep(id="a", index=1, title="Open a shell", description="Run ls.",
                    app_name="Terminal", app_bundle="com.apple.Terminal")
    asyncio.run(run_steps("p", [step], frozenset({"a"}), rec, asyncio.Event(),
                          ExecConfig(mode="simulated", sim_delay_s=0)))
    started = [p for k, p in rec.events if k == "step_started"]
    assert started[0]["app"] == "Terminal"
    res = [p for k, p in rec.events if k == "step_result"][0]
    assert res["status"] == "failed" and res["summary"] == "This app is not allowed for the agent."
    assert not [k for k, _ in rec.events if k == "action"]


def test_step_started_app_is_null_for_browser_steps() -> None:
    rec = Rec()
    asyncio.run(run_steps("p", [ExecStep(id="a", index=1, title="Search", description="d")],
                          frozenset({"a"}), rec, asyncio.Event(),
                          ExecConfig(mode="simulated", sim_delay_s=0)))
    assert [p for k, p in rec.events if k == "step_started"][0]["app"] is None


def test_live_routes_by_step_app_then_falls_back_to_regex(monkeypatch) -> None:
    import oversight.executor as ex

    built: list[tuple[str, str]] = []

    class FakeAppDesk:
        def __init__(self, drv, bundle, name):
            built.append((bundle, name))

        async def ensure(self, url=None):
            raise RuntimeError("stop here")

    monkeypatch.setattr(ex, "AppDesk", FakeAppDesk)

    async def llm(req):
        raise AssertionError("no model call expected")

    def go(step: ExecStep, prompt: str = "p") -> dict:
        rec = Rec()
        asyncio.run(run_steps(prompt, [step], frozenset({step.id}), rec, asyncio.Event(),
                              ExecConfig(mode="live"), driver=object(), llm=llm))
        return [p for k, p in rec.events if k == "step_result"][0]

    r = go(ExecStep(id="a", index=1, title="Write it down", description="Jot the list.",
                    app_name="Notes", app_bundle="com.apple.Notes"))
    assert built == [("com.apple.Notes", "Notes")] and "stop here" in r["summary"]
    built.clear()
    go(ExecStep(id="b", index=1, title="Open Messages", description="Find Amogh."))
    assert built == [("com.apple.MobileSMS", "Messages")]


def test_build_catalog_keeps_running_and_recent_apps_when_over_the_cap() -> None:
    # Over the cap, alphabetical-only truncation dropped WhatsApp/Zoom on a real Mac.
    filler = [{"name": f"A{i:03d}", "bundle_id": f"com.a.{i}", "running": False,
               "last_used": "2020-01-01T00:00:00Z"} for i in range(apps.CATALOG_MAX + 20)]
    late = [{"name": "WhatsApp", "bundle_id": "net.whatsapp.WhatsApp", "running": True},
            {"name": "Zoom", "bundle_id": "us.zoom.xos", "running": False,
             "last_used": "2026-10-01T00:00:00Z"}]
    names = [a["name"] for a in apps.build_catalog(filler + late)]
    assert len(names) == apps.CATALOG_MAX
    assert "WhatsApp" in names and "Zoom" in names
    assert names == sorted(names, key=str.lower)  # still presented alphabetically
