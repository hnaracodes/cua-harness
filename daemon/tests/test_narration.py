"""Track D4: run narration. step_result counts, frames, recap-before-final."""

from __future__ import annotations

import asyncio
import io
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from oversight import executor, fixtures
from oversight.api import create_app
from oversight.settings import Settings


class Rec:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def __call__(self, kind: str, payload: dict[str, Any]) -> None:
        self.events.append((kind, payload))


def test_step_result_has_actions_and_duration_simulated():
    rec = Rec()
    steps = [executor.ExecStep(id="stp_1", index=1, title="Search for tennis rackets under $100", description="d"),
             executor.ExecStep(id="stp_2", index=2, title="Add racket to cart", description="d")]
    asyncio.run(executor.run_steps("p", steps, frozenset({"stp_1", "stp_2"}), rec, asyncio.Event(),
                                   executor.ExecConfig(mode="simulated", sim_delay_s=0.01)))
    results = [p for k, p in rec.events if k == "step_result"]
    assert [r["actions"] for r in results] == [3, 1]  # _sim_script: search = 3 actions, cart = 1
    assert all(isinstance(r["duration_ms"], int) and r["duration_ms"] >= 0 for r in results)


def test_never_run_steps_report_zero_actions():
    rec = Rec()
    stop = asyncio.Event()
    steps = [executor.ExecStep(id="stp_1", index=1, title="Search for x", description="d"),
             executor.ExecStep(id="stp_2", index=2, title="Add racket to cart", description="d")]

    async def stopping_emit(kind: str, payload: dict[str, Any]) -> None:
        await rec(kind, payload)
        if kind == "step_started" and payload["step_id"] == "stp_1":
            stop.set()

    asyncio.run(executor.run_steps("p", steps, frozenset({"stp_1", "stp_2"}), stopping_emit, stop,
                                   executor.ExecConfig(mode="simulated", sim_delay_s=0.0)))
    by_id = {p["step_id"]: p for k, p in rec.events if k == "step_result"}
    assert by_id["stp_1"]["status"] == "stopped"
    assert by_id["stp_2"] == {"step_id": "stp_2", "index": 2, "status": "skipped",
                              "summary": "Not run: the run ended early.", "actions": 0, "duration_ms": 0}


# ------------------------------------------------------------------ frames


def test_live_runner_emits_one_frame_per_observation():
    from test_executor import FakeDesk, FakeLLM, fake_driver, tool_use  # same-dir test helpers

    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM(script=[[tool_use("open_url", {"url": "https://www.google.com"})],
                          [tool_use("step_done", {"summary": "Results are showing."})]])
    rec = Rec()
    st = [executor.ExecStep(id="stp_1", index=1, title="Search", description="d")]
    asyncio.run(executor.run_steps("p", st, frozenset({"stp_1"}), rec, asyncio.Event(),
                                   executor.ExecConfig(mode="live"), driver=driver, llm=llm, desk=desk))
    frames = [p for k, p in rec.events if k == "frame"]
    assert len(frames) == 2  # two observations: before open_url, before step_done
    assert all(f["step_id"] == "stp_1" and f["png"].startswith(b"\x89PNG") for f in frames)
    (result,) = [p for k, p in rec.events if k == "step_result"]
    assert result["actions"] == 1


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _png(w: int = 2000, h: int = 1000) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (30, 60, 90)).save(buf, "PNG")
    return buf.getvalue()


def _start(client, approve_idx: tuple[int, ...] = (1, 4)) -> tuple[str, list[dict]]:
    """Plan the fixture task, approve `approve_idx` by checkbox, remove the rest, run."""
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    steps = client.post(f"/task/{tid}/plan").json()["steps"]
    keep = [s["id"] for s in steps if s["index"] in approve_idx]
    drop = [s["id"] for s in steps if s["index"] not in approve_idx]
    r = client.post(f"/task/{tid}/run", json={"approved_step_ids": keep, "checked_step_ids": keep,
                                              "removed_step_ids": drop, "boundaries": []})
    assert r.status_code == 200, r.text
    return tid, steps


def _wait(client, tid: str) -> dict:
    for _ in range(300):
        runs = client.get(f"/task/{tid}").json()["runs"]
        if runs and runs[-1]["status"] != "running":
            return runs[-1]
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def _fake_run(events: list[tuple[str, Any]]):
    """A stand-in for executor.run_steps that replays `events` for the first step."""

    async def fake_run_steps(prompt, steps, approved_ids, emit, stop, config, **kw):
        s = steps[0]
        for kind, payload in events:
            p = payload(s) if callable(payload) else payload
            await emit(kind, p)
        return {"status": "completed"}

    return fake_run_steps


def _one_step_events(frame_png: bytes):
    return [
        ("step_started", lambda s: {"step_id": s.id, "index": s.index, "title": s.title}),
        ("frame", lambda s: {"step_id": s.id, "png": frame_png}),
        ("step_result", lambda s: {"step_id": s.id, "index": s.index, "status": "done",
                                   "summary": "ok", "actions": 1, "duration_ms": 5}),
        ("final_result", lambda s: {"status": "completed", "message": "All approved steps were attempted.",
                                    "attempted": [s.id], "completed": [s.id]}),
    ]


def test_frame_is_saved_as_jpeg_and_served(client, monkeypatch):
    monkeypatch.setattr(executor, "run_steps", _fake_run(_one_step_events(_png())))
    tid, steps = _start(client, (1,))
    _wait(client, tid)
    evs = client.app.state.oversight.store.get_events(tid)
    (fr,) = [e for e in evs if e["kind"] == "frame"]
    assert fr["payload"] == {"step_id": steps[0]["id"], "seq": 1}  # no bytes, ever
    r = client.get(f"/task/{tid}/frames/1.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    im = Image.open(io.BytesIO(r.content))
    assert im.format == "JPEG" and (im.width, im.height) == (1600, 800)


def test_frame_404s(client):
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    assert client.get(f"/task/{tid}/frames/1.jpg").status_code == 404
    assert client.get("/task/tsk_nope/frames/1.jpg").status_code == 404


def test_undecodable_frame_is_dropped_and_run_finishes(client, monkeypatch):
    monkeypatch.setattr(executor, "run_steps", _fake_run(_one_step_events(b"not a png")))
    tid, _ = _start(client, (1,))
    assert _wait(client, tid)["status"] == "completed"
    kinds = [e["kind"] for e in client.app.state.oversight.store.get_events(tid)]
    assert "frame" not in kinds


# ------------------------------------------------------------------ recap module

from oversight import recap  # noqa: E402
from oversight.llm import CallRecord, LLMError  # noqa: E402

RSTEPS = [{"id": "a", "index": 1, "title": "Search rackets", "removed": False},
          {"id": "b", "index": 2, "title": "Add to cart", "removed": True},
          {"id": "c", "index": 3, "title": "Draft message", "removed": False},
          {"id": "d", "index": 4, "title": "Send message", "removed": False}]
RRESULTS = {"a": {"status": "done", "summary": "Found 4 rackets under $100."},
            "c": {"status": "failed", "summary": "WhatsApp did not load."}}
RFINAL = {"status": "failed", "message": "A step failed, so the remaining steps were not run.",
          "attempted": ["a", "c"], "completed": ["a"]}


class FakeLLM:
    def __init__(self, data: dict | None = None, exc: Exception | None = None) -> None:
        self.data, self.exc, self.calls = data, exc, []

    async def call(self, **kw):
        self.calls.append(kw)
        if self.exc:
            raise self.exc
        return self.data, CallRecord(scope=kw["scope"], provider="fake", model="m", usd=0.001)


def test_fallback_recap_is_deterministic_and_complete():
    r = recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL)
    assert r == {
        "headline": "Stopped early: a step failed after 1 step(s) completed.",
        "done": [{"step_id": "a", "text": "Found 4 rackets under $100."}],
        "skipped": [{"step_id": "b", "reason": "Removed before the run."},
                    {"step_id": "c", "reason": "Failed: WhatsApp did not load."},
                    {"step_id": "d", "reason": "Not run: the run ended early."}],
        "source": "fallback",
    }
    assert recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL) == r


@pytest.mark.parametrize("status,headline", [
    ("completed", "Done: 1 step(s) completed. 1 skipped as you asked."),
    ("stopped", "Stopped by you after 1 step(s)."),
    ("capped", "Stopped at the action limit after 1 step(s)."),
])
def test_fallback_headlines(status, headline):
    assert recap.build_fallback_recap(RSTEPS, RRESULTS, {**RFINAL, "status": status})["headline"] == headline


GOOD = {"headline": "Found rackets; the message didn't go out.",
        "done": [{"step_id": "a", "text": "Found 4 rackets under $100 on Google Shopping."}],
        "skipped": [{"step_id": "b", "reason": "You removed it."},
                    {"step_id": "c", "reason": "WhatsApp did not load."},
                    {"step_id": "d", "reason": "Not reached."}]}


def test_build_recap_llm_success_records_cost():
    llm, calls = FakeLLM(GOOD), []

    async def on_call(rec):
        calls.append(rec)

    r = asyncio.run(recap.build_recap(llm, "task", RSTEPS, RRESULTS, RFINAL, on_call))
    assert r == {**GOOD, "source": "llm"}
    assert llm.calls[0]["scope"] == "recap" and llm.calls[0]["effort"] == "low"
    assert llm.calls[0]["schema"] == recap.RECAP_SCHEMA
    assert len(calls) == 1 and calls[0].scope == "recap"


def test_build_recap_falls_back_on_llm_error_and_still_records_cost():
    calls = []

    async def on_call(rec):
        calls.append(rec)

    err = LLMError("refused", CallRecord(scope="recap", provider="fake", model="m"))
    r = asyncio.run(recap.build_recap(FakeLLM(exc=err), "task", RSTEPS, RRESULTS, RFINAL, on_call))
    assert r == recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL)
    assert len(calls) == 1


@pytest.mark.parametrize("bad", [
    {**GOOD, "done": [{"step_id": "zzz", "text": "invented"}]},       # unknown step
    {**GOOD, "done": [{"step_id": "c", "text": "claims the failed step"}]},  # not actually done
    {**GOOD, "headline": "   "},                                       # empty headline
])
def test_build_recap_rejects_unfaithful_output(bad):
    r = asyncio.run(recap.build_recap(FakeLLM(bad), "task", RSTEPS, RRESULTS, RFINAL))
    assert r["source"] == "fallback"


def test_build_recap_falls_back_on_unexpected_exception():
    r = asyncio.run(recap.build_recap(FakeLLM(exc=RuntimeError("socket closed")), "task",
                                      RSTEPS, RRESULTS, RFINAL))
    assert r["source"] == "fallback"


# ------------------------------------------------------------------ recap in _drive


def _run_kinds(client, tid):
    return [e for e in client.app.state.oversight.store.get_events(tid) if e["run_id"]]


def test_run_emits_one_recap_right_before_final(client):
    tid, steps = _start(client, (1, 4))
    assert _wait(client, tid)["status"] == "completed"
    evs = _run_kinds(client, tid)
    kinds = [e["kind"] for e in evs]
    assert kinds.count("run_recap") == 1 and kinds.count("final_result") == 1
    assert kinds[-2:] == ["run_recap", "final_result"]
    rc = evs[-2]["payload"]
    assert rc["source"] == "fallback"  # fixtures mode: no model
    assert [d["step_id"] for d in rc["done"]] == [steps[0]["id"], steps[3]["id"]]
    assert [s["step_id"] for s in rc["skipped"]] == [steps[i]["id"] for i in (1, 2, 4, 5)]
    assert all(s["reason"] == "Removed before the run." for s in rc["skipped"])
    results = [e["payload"] for e in evs if e["kind"] == "step_result"]
    assert all(r["actions"] > 0 and r["duration_ms"] >= 0 for r in results)


def test_stop_mid_run_still_recaps_then_final(client):
    tid, _ = _start(client, (1, 4))
    client.post(f"/task/{tid}/stop")
    assert _wait(client, tid)["status"] == "stopped"
    kinds = [e["kind"] for e in _run_kinds(client, tid)]
    assert kinds[-2:] == ["run_recap", "final_result"] and kinds.count("run_recap") == 1


def test_executor_crash_still_recaps(client, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(executor, "run_steps", boom)
    tid, _ = _start(client, (1,))
    assert _wait(client, tid)["status"] == "failed"
    evs = _run_kinds(client, tid)
    assert [e["kind"] for e in evs][-2:] == ["run_recap", "final_result"]
    assert evs[-2]["payload"]["source"] == "fallback"


def test_recap_uses_the_model_when_present_and_records_cost(client):
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    steps = client.post(f"/task/{tid}/plan").json()["steps"]
    first = steps[0]["id"]
    good = {"headline": "Found rackets.", "done": [{"step_id": first, "text": "Searched."}],
            "skipped": [{"step_id": s["id"], "reason": "You removed it."} for s in steps[1:]]}
    client.app.state.oversight.llm = FakeLLM(good)  # swap in after planning (plan is replayed)
    r = client.post(f"/task/{tid}/run", json={"approved_step_ids": [first], "checked_step_ids": [first],
                                              "removed_step_ids": [s["id"] for s in steps[1:]],
                                              "boundaries": []})
    assert r.status_code == 200, r.text
    _wait(client, tid)
    evs = _run_kinds(client, tid)
    rc = [e for e in evs if e["kind"] == "run_recap"][0]["payload"]
    assert rc == {**good, "source": "llm"}
    calls = client.get(f"/task/{tid}").json()["llm_calls"]
    assert any(c["scope"] == "recap" for c in calls)


def test_cancel_during_recap_call_still_ends_with_recap_then_final(client):
    tid, _ = _start(client, (1,))
    _wait(client, tid)  # plan + first run done; now drive a second run with a hanging recap
    # Reuse the stored plan: approve step 1 again and remove the rest.
    steps = client.get(f"/task/{tid}").json()["steps"]
    keep = [s["id"] for s in steps if s["index"] == 1]
    drop = [s["id"] for s in steps if s["index"] != 1]

    class HangingLLM:
        async def call(self, **kw):
            await asyncio.sleep(3600)

    client.app.state.oversight.llm = HangingLLM()
    r = client.post(f"/task/{tid}/run", json={"approved_step_ids": keep, "checked_step_ids": keep,
                                              "removed_step_ids": drop, "boundaries": []})
    assert r.status_code == 200, r.text
    st = client.app.state.oversight
    for _ in range(200):
        evs = [e for e in st.store.get_events(tid) if e["run_id"] == r.json()["run_id"]]
        if any(e["kind"] == "step_result" for e in evs):
            break
        time.sleep(0.02)
    time.sleep(0.1)
    task = st.active_runs[tid].task
    client.portal.call(lambda: _cancel(task))
    _wait(client, tid)
    kinds = [e["kind"] for e in st.store.get_events(tid) if e["run_id"] == r.json()["run_id"]]
    assert kinds[-2:] == ["run_recap", "final_result"] and kinds.count("final_result") == 1


async def _cancel(task):
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
