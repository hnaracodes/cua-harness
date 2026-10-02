"""Executor tests against a fake cua-driver and a fake model. No desktop, no API.

Run: uv run --with pytest --with anthropic pytest daemon/tests/test_executor.py -q
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oversight.cua import (  # noqa: E402
    CuaDriver,
    ForbiddenCall,
    PermissionsPending,
    WindowState,
    parse_call_output,
)
from oversight.executor import (  # noqa: E402
    ExecConfig,
    ExecStep,
    Turn,
    UnapprovedStepError,
    count_images,
    parse_keys,
    render_ax,
    render_history,
    run_steps,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def steps(n: int = 3) -> list[ExecStep]:
    titles = ["Search for tennis rackets under $100", "Select a recommended racket", "Add selected racket to cart",
              "Draft party message", "Send message"]
    return [ExecStep(id=f"stp_{i}", index=i, title=titles[i - 1], description=f"desc {i}") for i in range(1, n + 1)]


class FakeRunner:
    """Stands in for the ``cua-driver`` subprocess. Records every argv."""

    def __init__(self) -> None:
        self.argv: list[list[str]] = []

    async def __call__(self, argv: list[str]) -> tuple[int, str, str]:
        self.argv.append(argv)
        if argv[1:2] == ["status"]:
            return 0, "Cua Driver daemon is running", ""
        return 0, json.dumps({"structuredContent": {"ok": True}}), ""


def fake_driver() -> tuple[CuaDriver, FakeRunner]:
    r = FakeRunner()
    return CuaDriver(binary="cua-driver", runner=r), r


class FakeDesk:
    def __init__(self, driver: CuaDriver, elements: list[dict[str, Any]] | None = None) -> None:
        self.driver = driver
        self.target = SimpleNamespace(pid=111, window_id=222)
        self.observations = 0
        self.elements = elements if elements is not None else [
            {"element_index": 1, "role": "AXButton", "label": "Search", "element_token": "tok1", "depth": 1},
            {"element_index": 2, "role": "AXTextField", "label": "Address and search bar", "element_token": "tok2"},
        ]

    async def ensure(self, url: str | None = None) -> Any:
        return self.target

    async def observe(self, **kw: Any) -> WindowState:
        self.observations += 1
        return WindowState(pid=111, window_id=222, elements=list(self.elements), png=PNG,
                           screenshot_width=1280, screenshot_height=860, window_title="Google")

    async def close(self) -> None:
        pass


def tool_use(name: str, inp: dict[str, Any]) -> Any:
    return SimpleNamespace(type="tool_use", name=name, input=inp, id=f"tu_{name}")


class FakeLLM:
    """Scripted model. ``script`` is a list of lists of tool uses, one per turn;
    after it runs out it repeats ``default``."""

    def __init__(self, script: list[list[Any]] | None = None, default: list[Any] | None = None) -> None:
        self.script = list(script or [])
        self.default = default if default is not None else [tool_use("click_element", {"index": 1})]
        self.requests: list[dict[str, Any]] = []

    async def __call__(self, req: dict[str, Any]) -> Any:
        self.requests.append(req)
        content = self.script.pop(0) if self.script else self.default
        return SimpleNamespace(content=content, stop_reason="tool_use", model=req["model"],
                               usage=SimpleNamespace(input_tokens=1000, output_tokens=50))


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def __call__(self, kind: str, payload: dict[str, Any]) -> None:
        self.events.append((kind, payload))

    def kinds(self) -> list[str]:
        return [k for k, _ in self.events]


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Approval assertion
# ---------------------------------------------------------------------------


def test_unapproved_step_raises_before_any_driver_call() -> None:
    driver, runner = fake_driver()
    llm = FakeLLM()
    rec = Recorder()
    st = steps(3)
    approved = frozenset({"stp_1", "stp_2"})  # stp_3 is not approved
    with pytest.raises(UnapprovedStepError):
        run(run_steps("task", st, approved, rec, asyncio.Event(), ExecConfig(mode="live"),
                      driver=driver, llm=llm))
    assert runner.argv == []  # zero driver calls
    assert driver.calls == []
    assert llm.requests == []
    assert rec.events == []


def test_unapproved_step_raises_in_simulated_mode_too() -> None:
    rec = Recorder()
    with pytest.raises(UnapprovedStepError):
        run(run_steps("task", steps(2), frozenset({"stp_1"}), rec, asyncio.Event(),
                      ExecConfig(mode="simulated", sim_delay_s=0)))
    assert rec.events == []


def test_unapproved_error_is_an_assertion_error() -> None:
    assert issubclass(UnapprovedStepError, AssertionError)


def test_step_list_mutated_between_steps_is_caught() -> None:
    st = steps(2)
    approved = frozenset(s.id for s in st)
    evil = ExecStep(id="stp_evil", index=99, title="Buy with saved card", description="pay")

    class MutatingEmit(Recorder):
        async def __call__(self, kind: str, payload: dict[str, Any]) -> None:
            await super().__call__(kind, payload)
            if kind == "step_result" and payload["step_id"] == "stp_1":
                st.append(evil)  # injected after the entry check passed

    rec = MutatingEmit()
    with pytest.raises(UnapprovedStepError):
        run(run_steps("task", st, approved, rec, asyncio.Event(), ExecConfig(mode="simulated", sim_delay_s=0)))
    started = [p["step_id"] for k, p in rec.events if k == "step_started"]
    acted = {p["step_id"] for k, p in rec.events if k == "action"}
    assert "stp_evil" not in started and "stp_evil" not in acted
    assert started == ["stp_1", "stp_2"]


def test_step_swapped_in_place_is_caught_live() -> None:
    driver, runner = fake_driver()
    st = steps(2)
    approved = frozenset(s.id for s in st)
    desk = FakeDesk(driver)

    class SwapEmit(Recorder):
        async def __call__(self, kind: str, payload: dict[str, Any]) -> None:
            await super().__call__(kind, payload)
            if kind == "step_result" and payload["step_id"] == "stp_1":
                st[1] = ExecStep(id="stp_x", index=2, title="Send money", description="")

    llm = FakeLLM(default=[tool_use("step_done", {"summary": "ok"})])
    rec = SwapEmit()
    with pytest.raises(UnapprovedStepError):
        run(run_steps("task", st, approved, rec, asyncio.Event(), ExecConfig(mode="live"),
                      driver=driver, llm=llm, desk=desk))
    assert len(llm.requests) == 1  # only step 1 ever reached the model
    assert "stp_x" not in [p["step_id"] for k, p in rec.events if k == "step_started"]


# ---------------------------------------------------------------------------
# Screenshot history pruning
# ---------------------------------------------------------------------------


def test_render_history_keeps_last_three_images() -> None:
    turns = [Turn(step_index=1, seq=i, png=PNG + bytes([i])) for i in range(1, 7)]
    blocks = render_history(turns, keep=3)
    images = [b for b in blocks if b["type"] == "image"]
    placeholders = [b for b in blocks if b["type"] == "text" and "history pruned" in b["text"]]
    assert len(images) == 3
    assert len(placeholders) == 3
    # The kept ones are the newest three.
    texts = [b["text"] for b in blocks if b["type"] == "text"]
    assert any("Observation 6" in t and "screenshot:" in t for t in texts)
    assert any("Observation 1" in t and "pruned" in t for t in texts)


def test_live_requests_never_carry_more_than_three_images() -> None:
    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM()  # always clicks, never finishes
    cfg = ExecConfig(mode="live", max_actions_per_step=8, max_actions_per_run=25)
    out = run(run_steps("task", steps(1), frozenset({"stp_1"}), Recorder(), asyncio.Event(), cfg,
                        driver=driver, llm=llm, desk=desk))
    assert out["status"] == "failed"
    assert len(llm.requests) == 8
    for req in llm.requests:
        n, _ = count_images(req["messages"][0]["content"])
        assert n <= 3
    last = llm.requests[-1]["messages"][0]["content"]
    assert count_images(last)[0] == 3
    assert sum(1 for b in last if b["type"] == "text" and "history pruned" in b["text"]) == 5


# ---------------------------------------------------------------------------
# Caps and stop
# ---------------------------------------------------------------------------


def test_step_cap_stops_the_loop() -> None:
    driver, runner = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM()
    rec = Recorder()
    cfg = ExecConfig(mode="live", max_actions_per_step=10, max_actions_per_run=25)
    out = run(run_steps("task", steps(3), frozenset({"stp_1", "stp_2", "stp_3"}), rec, asyncio.Event(), cfg,
                        driver=driver, llm=llm, desk=desk))
    actions = [p for k, p in rec.events if k == "action"]
    assert len(actions) == 10
    assert out["actions_used"] == 10
    results = [p for k, p in rec.events if k == "step_result"]
    assert results[0]["status"] == "failed" and "cap" in results[0]["summary"]
    assert [r["status"] for r in results[1:]] == ["skipped", "skipped"]
    assert out["status"] == "failed"
    assert all(a["mode"] == "ax" for a in actions)
    # Every click went through cua-driver by element token, in the background.
    clicks = [json.loads(a[3]) for a in runner.argv if a[2] == "click"]
    assert len(clicks) == 10 and all(c["element_token"] == "tok1" for c in clicks)
    assert all("delivery_mode" not in c for c in clicks)


def test_run_cap_stops_the_loop() -> None:
    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    rec = Recorder()
    cfg = ExecConfig(mode="live", max_actions_per_step=10, max_actions_per_run=4)
    out = run(run_steps("task", steps(2), frozenset({"stp_1", "stp_2"}), rec, asyncio.Event(), cfg,
                        driver=driver, llm=FakeLLM(), desk=desk))
    assert out["status"] == "capped"
    assert out["actions_used"] == 4
    assert rec.events[-1][0] == "final_result" and rec.events[-1][1]["status"] == "capped"


def test_run_cap_in_simulated_mode() -> None:
    rec = Recorder()
    cfg = ExecConfig(mode="simulated", sim_delay_s=0, max_actions_per_run=2)
    out = run(run_steps("task", steps(3), frozenset({"stp_1", "stp_2", "stp_3"}), rec, asyncio.Event(), cfg))
    assert out["status"] == "capped"
    assert len([1 for k, _ in rec.events if k == "action"]) == 2


def test_stop_event_checked_between_actions() -> None:
    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    stop = asyncio.Event()

    class StopAfterTwo(Recorder):
        async def __call__(self, kind: str, payload: dict[str, Any]) -> None:
            await super().__call__(kind, payload)
            if kind == "action" and payload["n"] == 2:
                stop.set()

    # Model emits three clicks per turn; stop lands after the second.
    llm = FakeLLM(default=[tool_use("click_element", {"index": 1})] * 3)
    rec = StopAfterTwo()
    out = run(run_steps("task", steps(2), frozenset({"stp_1", "stp_2"}), rec, stop, ExecConfig(mode="live"),
                        driver=driver, llm=llm, desk=desk))
    assert out["status"] == "stopped"
    assert len([1 for k, _ in rec.events if k == "action"]) == 2
    results = [p["status"] for k, p in rec.events if k == "step_result"]
    assert results == ["stopped", "skipped"]


# ---------------------------------------------------------------------------
# Simulated mode
# ---------------------------------------------------------------------------


def test_simulated_mode_event_sequence() -> None:
    rec = Recorder()
    st = steps(2)
    out = run(run_steps("task", st, frozenset(s.id for s in st), rec, asyncio.Event(),
                        ExecConfig(mode="simulated", sim_delay_s=0)))
    kinds = rec.kinds()
    assert kinds[0] == "step_started" and kinds[-1] == "final_result"
    # step_started, action+, cost, step_result per step
    i = 0
    for s in st:
        assert kinds[i] == "step_started" and rec.events[i][1]["step_id"] == s.id
        i += 1
        n = 0
        while kinds[i] == "action":
            assert rec.events[i][1]["mode"] == "sim" and rec.events[i][1]["step_id"] == s.id
            i += 1
            n += 1
        assert n >= 1
        assert kinds[i] == "cost"
        i += 1
        assert kinds[i] == "step_result" and rec.events[i][1]["status"] == "done"
        i += 1
    assert kinds[i] == "final_result" and i == len(kinds) - 1
    final = rec.events[-1][1]
    assert final["status"] == "completed"
    assert final["message"] == "All approved steps were attempted."
    assert final["attempted"] == ["stp_1", "stp_2"] and final["completed"] == ["stp_1", "stp_2"]
    assert out["cost_usd"] == 0.0
    ns = [p["n"] for k, p in rec.events if k == "action"]
    assert ns == list(range(1, len(ns) + 1))


def test_simulated_mode_never_touches_the_driver(monkeypatch: pytest.MonkeyPatch) -> None:
    import oversight.executor as ex

    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("simulated mode built a driver")

    monkeypatch.setattr(ex, "CuaDriver", boom)
    monkeypatch.setattr(ex, "AgentDesk", boom)
    run(run_steps("task", steps(1), frozenset({"stp_1"}), Recorder(), asyncio.Event(),
                  ExecConfig(mode="simulated", sim_delay_s=0)))


# ---------------------------------------------------------------------------
# Live loop details
# ---------------------------------------------------------------------------


def test_live_done_and_cost_events() -> None:
    driver, runner = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM(script=[
        [tool_use("open_url", {"url": "https://www.google.com"})],
        [tool_use("type_into_element", {"index": 2, "text": "tennis rackets under $100",
                                        "replace": False, "submit": True})],
        [tool_use("step_done", {"summary": "Results are showing."})],
    ])
    rec = Recorder()
    out = run(run_steps("task", steps(1), frozenset({"stp_1"}), rec, asyncio.Event(), ExecConfig(mode="live"),
                        driver=driver, llm=llm, desk=desk))
    assert out["status"] == "completed" and out["completed"] == ["stp_1"]
    costs = [p for k, p in rec.events if k == "cost"]
    assert len(costs) == 3
    assert costs[-1]["usd_total"] == pytest.approx(3 * (1000 * 4 + 50 * 20) / 1e6)
    tools = [a[2] for a in runner.argv]
    assert "type_text" in tools and "press_key" in tools
    req = llm.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert all(t.get("type") != "computer_toolset_20260801" for t in req["tools"])  # AX first


def test_pixel_fallback_when_tree_empty() -> None:
    driver, runner = fake_driver()
    desk = FakeDesk(driver, elements=[])
    llm = FakeLLM(script=[
        [tool_use("left_click", {"coordinate": [640, 120]})],
        [tool_use("step_done", {"summary": "ok"})],
    ])
    rec = Recorder()
    run(run_steps("task", steps(1), frozenset({"stp_1"}), rec, asyncio.Event(), ExecConfig(mode="live"),
                  driver=driver, llm=llm, desk=desk))
    assert any(t.get("type") == "computer_toolset_20260801" for t in llm.requests[0]["tools"])
    act = [p for k, p in rec.events if k == "action"][0]
    assert act["mode"] == "pixel" and act["ok"]
    click = [json.loads(a[3]) for a in runner.argv if a[2] == "click"][0]
    assert (click["x"], click["y"], click["window_id"]) == (640.0, 120.0, 222)


def test_pixel_fallback_when_element_not_found() -> None:
    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM(script=[
        [tool_use("click_element", {"index": 77})],
        [tool_use("step_done", {"summary": "ok"})],
    ])
    rec = Recorder()
    run(run_steps("task", steps(1), frozenset({"stp_1"}), rec, asyncio.Event(), ExecConfig(mode="live"),
                  driver=driver, llm=llm, desk=desk))
    assert not any(t.get("type") == "computer_toolset_20260801" for t in llm.requests[0]["tools"])
    assert any(t.get("type") == "computer_toolset_20260801" for t in llm.requests[1]["tools"])
    act = [p for k, p in rec.events if k == "action"][0]
    assert act["ok"] is False and act["error"] == "element_not_found"


# ---------------------------------------------------------------------------
# Driver wrapper rules
# ---------------------------------------------------------------------------


def test_driver_refuses_full_screen_and_foreground() -> None:
    driver, runner = fake_driver()
    with pytest.raises(ForbiddenCall):
        run(driver.call("get_desktop_state", {}))
    with pytest.raises(ForbiddenCall):
        run(driver.call("click", {"pid": 1, "x": 1, "y": 1, "scope": "desktop"}))
    with pytest.raises(ForbiddenCall):
        run(driver.call("click", {"pid": 1, "element_token": "t", "delivery_mode": "foreground"}))
    with pytest.raises(ForbiddenCall):
        run(driver.call("bring_to_front", {"pid": 1}))
    assert runner.argv == []


def test_driver_adds_session_label() -> None:
    driver, runner = fake_driver()
    run(driver.call("list_windows", {"pid": 5}))
    assert json.loads(runner.argv[0][3])["session"] == "oversight-agent"


def test_parse_permissions_pending() -> None:
    with pytest.raises(PermissionsPending):
        parse_call_output("list_windows", "permissions_pending: macOS Accessibility ...", "", 75)
    with pytest.raises(PermissionsPending):
        parse_call_output("list_sessions", "permissions_pending: macOS ...", "", 0)


def test_parse_structured_content() -> None:
    out = parse_call_output("x", json.dumps({"content": [{"type": "text", "text": "hi"}],
                                             "structuredContent": {"windows": [1]}}), "", 0)
    assert out["windows"] == [1] and out["text"] == "hi"


def test_window_scoped_flag_off_requires_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OVERSIGHT_ALLOW_FULL_SCREEN", raising=False)
    driver, runner = fake_driver()
    with pytest.raises(ValueError):
        run(run_steps("t", steps(1), frozenset({"stp_1"}), Recorder(), asyncio.Event(),
                      ExecConfig(mode="live", window_scoped_screenshots=False), driver=driver, llm=FakeLLM(),
                      desk=FakeDesk(driver)))
    assert runner.argv == []


def test_parse_keys() -> None:
    assert parse_keys("Return") == ([], "return")
    assert parse_keys("ctrl+l") == (["ctrl"], "l")
    assert parse_keys("cmd+shift+T") == (["cmd", "shift"], "t")
    assert parse_keys("Page_Down") == ([], "pagedown")
    assert parse_keys("bogus_key")[1] is None


def test_render_ax_prunes_and_indexes() -> None:
    els = [
        {"element_index": 1, "role": "AXGroup", "label": "", "depth": 0},
        {"element_index": 2, "role": "AXTextField", "label": "Address and search bar", "value": "", "depth": 1},
        {"element_index": 3, "role": "AXLink", "label": "Wilson Clash 100", "depth": 2},
        {"element_index": 4, "role": "AXStaticText", "label": "$89.99", "depth": 2},
    ]
    txt = render_ax(els, 10_000)
    assert "[1]" not in txt and "[2] textfield" in txt and "[3] link" in txt and "$89.99" in txt
    assert "tok" not in txt
