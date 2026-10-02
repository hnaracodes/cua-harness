"""Browser desk: cua-driver-owned isolated Chrome over CDP. Fake driver, no desktop.

Response shapes are the ones cua-driver 0.32.0 returned on 2026-10-02 for
``get_browser_state`` (bind and semantic_v2 snapshot), ``browser_navigate``,
``browser_type`` and ``browser_click``.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

import oversight.browser_desk as bd  # noqa: E402
from oversight.cua import CuaDriver, CuaDriverError, ForbiddenCall, parse_call_output  # noqa: E402
from oversight.executor import (  # noqa: E402
    BROWSER_TOOL_NAMES,
    ExecConfig,
    ExecStep,
    UnapprovedStepError,
    build_request,
    RunState,
    run_steps,
)
from test_executor import FakeLLM, Recorder, run, tool_use  # noqa: E402


def _png(w: int = 2400, h: int = 1904) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (20, 20, 20)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


REFS = [
    {"actions": ["click", "pointer"], "name": "DuckDuckGo home", "ref": "p7:0", "role": "link",
     "visibility": "in_viewport"},
    {"actions": ["click", "type", "pointer"], "name": "Search privately", "ref": "p7:1", "role": "combobox",
     "value": None, "visibility": "in_viewport"},
    {"actions": ["click", "pointer"], "name": None, "ref": "p7:3", "role": "strong", "visibility": "in_viewport"},
    {"actions": ["click", "pointer"], "name": "Search", "ref": "p7:4", "role": "button",
     "visibility": "in_viewport"},
    {"actions": [], "name": "Wilson Clash 100 $89.99", "ref": "p7:9", "role": "statictext",
     "visibility": "near_viewport"},
    {"actions": [], "name": "decorative", "ref": "p7:10", "role": "statictext", "visibility": "in_viewport"},
]


class FakeBrowserRunner:
    """Stands in for ``cua-driver call``; answers the browser tools."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.url = "about:blank"

    async def __call__(self, argv: list[str]) -> tuple[int, str, str]:
        tool, args = argv[2], json.loads(argv[3])
        self.calls.append((tool, args))
        if tool == "list_windows":
            out = {"windows": [
                {"window_id": 9, "layer": 0, "is_on_screen": False, "title": "", "z_index": 9,
                 "bounds": {"width": 500, "height": 500, "x": 0, "y": 0}},
                {"window_id": 7, "layer": 0, "is_on_screen": True, "title": "about:blank", "z_index": 5,
                 "bounds": {"width": 1200, "height": 1039, "x": 0, "y": 0}},
            ]}
        elif tool == "get_browser_state" and "target_id" not in args:
            out = {"status": "ok", "mode": "bind", "target_id": "bt-1",
                   "tabs": [{"active": True, "tab_id": "tab-1", "title": "t", "url": self.url}]}
        elif tool == "get_browser_state":
            out = {"status": "ok", "mode": "snapshot", "refs": REFS, "page": {"title": "DDG", "url": self.url},
                   "screenshot_png_b64": _png(), "screenshot_width": 2400, "screenshot_height": 1904}
        elif tool == "browser_navigate":
            self.url = args["url"]
            out = {"status": "ok", "url": args["url"], "refs_invalidated": True}
        elif tool in ("browser_click", "browser_type"):
            out = {"effect": "unverifiable", "delivery": {"mode": "background"},
                   "route": "dom" if tool == "browser_click" else "trusted_input"}
        else:
            out = {"status": "ok"}
        return 0, json.dumps(out), ""


@pytest.fixture
def desk(monkeypatch: pytest.MonkeyPatch) -> tuple[bd.BrowserDesk, FakeBrowserRunner]:
    async def running_pid(name: str = bd.PROFILE_NAME) -> int:
        return 4242

    monkeypatch.setattr(bd, "driver_browser_pid", running_pid)
    r = FakeBrowserRunner()
    return bd.BrowserDesk(CuaDriver(binary="cua-driver", runner=r)), r


# -- wrapper guard -----------------------------------------------------------


def test_guard_refuses_user_profiles_trusted_input_and_side_channels() -> None:
    r = FakeBrowserRunner()
    d = CuaDriver(binary="cua-driver", runner=r)
    bad = [
        ("browser_prepare", {"strategy": {"kind": "existing_profile"}, "pid": 1, "window_id": 2}),
        ("browser_prepare", {"allow_launch": True, "profile": {"mode": "user"}}),
        ("browser_prepare", {"profile": {"mode": "isolated_named", "name": "x"}}),
        ("browser_click", {"target_id": "a", "tab_id": "b", "ref": "p1:1"}),
        ("browser_click", {"target_id": "a", "tab_id": "b", "ref": "p1:1", "input_route": "trusted"}),
        ("browser_pointer", {"target_id": "a", "tab_id": "b", "action": "scroll", "delta_y": 9}),
        ("browser_type", {"target_id": "a", "tab_id": "b", "ref": "p1:1", "text": "x", "mode": "keystrokes"}),
        ("browser_download", {}), ("browser_set_input_files", {}), ("clipboard_write", {}),
        ("browser_dialog", {}), ("page", {}),
        ("press_key", {"pid": 1, "window_id": 2, "key": "return", "delivery_mode": "foreground"}),
    ]
    for tool, args in bad:
        with pytest.raises(ForbiddenCall):
            run(d.call(tool, args))
    assert r.calls == []


def test_wrapper_clicks_by_dom_event_and_types_with_insert_text() -> None:
    r = FakeBrowserRunner()
    d = CuaDriver(binary="cua-driver", runner=r)
    run(d.browser_click("bt", "tab", "p1:4"))
    run(d.browser_type("bt", "tab", "p1:1", "hi", replace=True))
    run(d.browser_prepare_isolated("oversight-agent"))
    (t1, a1), (t2, a2), (t3, a3) = r.calls
    assert t1 == "browser_click" and a1["input_route"] == "dom_event"
    assert t2 == "browser_type" and "mode" not in a2 and a2["replace"] is True
    assert t3 == "browser_prepare" and a3["profile"] == {"mode": "isolated_named", "name": "oversight-agent"}


def test_refused_effect_raises() -> None:
    out = json.dumps({"effect": "refused", "error": {"code": "browser_input_trust_unavailable"}})
    with pytest.raises(CuaDriverError) as e:
        parse_call_output("browser_click", out, "", 0)
    assert e.value.code == "browser_input_trust_unavailable"


# -- desk --------------------------------------------------------------------


def test_web_elements_keep_actionable_and_priced_rows() -> None:
    rows = bd.web_elements(REFS)
    assert [(r["element_index"], r["element_token"]) for r in rows] == [
        (0, "p7:0"), (1, "p7:1"), (2, "p7:4"), (3, "p7:9")]


def test_observe_binds_real_window_and_downscales_tab_screenshot(desk) -> None:
    d, r = desk
    ws = run(d.observe())
    assert ws.window_id == 7  # the on-screen window, not the 500x500 helper
    assert ws.raw["target_id"] == "bt-1" and ws.raw["tab_id"] == "tab-1"
    assert max(ws.screenshot_width, ws.screenshot_height) == 1280
    assert [e["label"] for e in ws.elements][:2] == ["DuckDuckGo home", "Search privately"]
    snap = [a for t, a in r.calls if t == "get_browser_state" and "target_id" in a][0]
    assert snap["snapshot_format"] == "semantic_v2" and snap["include_screenshot"] is True


# -- executor on the browser desk ---------------------------------------------


def _steps() -> list[ExecStep]:
    return [ExecStep(id="stp_1", index=1, title="Search for tennis rackets under $100", description="d")]


def test_browser_request_offers_no_keys_scroll_or_pixels() -> None:
    rs = RunState(task_prompt="t", steps=_steps(), config=ExecConfig(), emit=Recorder(), stop=asyncio.Event())
    req = build_request(rs, _steps()[0], None, pixel=True, browser=True)
    names = {t.get("name") for t in req["tools"]}
    assert names == set(BROWSER_TOOL_NAMES)
    assert "Return key" in req["system"]


def test_browser_run_types_clicks_and_finishes_in_background(desk) -> None:
    d, r = desk
    llm = FakeLLM(script=[
        [tool_use("open_url", {"url": "https://duckduckgo.com/"})],
        [tool_use("type_into_element", {"index": 1, "text": "tennis rackets under $100", "replace": True}),
         tool_use("click_element", {"index": 2})],
        [tool_use("step_done", {"summary": "Searched."})],
    ])
    rec = Recorder()
    out = run(run_steps("task", _steps(), frozenset({"stp_1"}), rec, asyncio.Event(),
                        ExecConfig(mode="live"), driver=d.driver, desk=d, llm=llm))
    assert out["status"] == "completed"
    acts = [p for k, p in rec.events if k == "action"]
    assert [a["verb"] for a in acts] == ["open_url", "type_into_element", "click_element"]
    assert all(a["ok"] for a in acts)
    tools = [t for t, _ in r.calls]
    assert "browser_navigate" in tools and "browser_type" in tools and "browser_click" in tools
    assert not {"press_key", "hotkey", "click", "type_text", "scroll"} & set(tools)


def test_browser_desk_still_refuses_unapproved_steps(desk) -> None:
    d, r = desk
    llm = FakeLLM()
    with pytest.raises(UnapprovedStepError):
        run(run_steps("task", _steps(), frozenset(), Recorder(), asyncio.Event(),
                      ExecConfig(mode="live"), driver=d.driver, desk=d, llm=llm))
    assert r.calls == [] and llm.requests == []


def test_open_url_rejects_non_http(desk) -> None:
    d, r = desk
    llm = FakeLLM(script=[[tool_use("open_url", {"url": "file:///etc/passwd"})],
                          [tool_use("step_failed", {"reason": "no"})]])
    rec = Recorder()
    run(run_steps("task", _steps(), frozenset({"stp_1"}), rec, asyncio.Event(),
                  ExecConfig(mode="live"), driver=d.driver, desk=d, llm=llm))
    act = [p for k, p in rec.events if k == "action"][0]
    assert act["ok"] is False and "http" in act["error"]
    assert "browser_navigate" not in [t for t, _ in r.calls]


FRAME_GONE = json.dumps({"refusal": {"code": "browser_route_unavailable", "message":
    "Accessibility.getFullAXTree failed: CDP Accessibility.getFullAXTree failed (-32602): "
    "Frame with the given frameId is not found."}, "status": "refused"})


def test_observe_rides_out_a_navigation_in_flight(desk, monkeypatch) -> None:
    """Real failure, 2026-10-02: a link click started a navigation and the next
    snapshot hit the old, gone frame. The desk waits, re-binds and retries."""
    d, r = desk
    d.retry_delays = (0, 0, 0)
    orig = r.__call__
    refusals = {"left": 2}

    async def flaky(argv):
        if argv[2] == "get_browser_state" and "target_id" in json.loads(argv[3]) and refusals["left"]:
            refusals["left"] -= 1
            r.calls.append((argv[2], json.loads(argv[3])))
            return 1, FRAME_GONE, ""
        return await orig(argv)

    d.driver._runner = flaky
    ws = run(d.observe())
    assert ws.elements and refusals["left"] == 0
    binds = [a for t, a in r.calls if t == "get_browser_state" and "target_id" not in a]
    assert len(binds) == 3  # re-bound before each retry


def test_observe_gives_up_after_its_retries(desk) -> None:
    d, r = desk
    d.retry_delays = (0, 0, 0)

    async def always_gone(argv):
        if argv[2] == "get_browser_state" and "target_id" in json.loads(argv[3]):
            return 1, FRAME_GONE, ""
        return await FakeBrowserRunner.__call__(r, argv)

    d.driver._runner = always_gone
    with pytest.raises(CuaDriverError):
        run(d.observe())
