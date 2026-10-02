"""Per-step desk routing: web steps to the browser desk, Messages steps to the
user's Messages app. Step titles are the planner's real output for the
iMessage task on 2026-10-02."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oversight.executor import ExecConfig, ExecStep, RunState, build_request  # noqa: E402
from oversight.host_desk import MESSAGES_APP, NOTES_APP, route_app  # noqa: E402

TASK = ("Help me find a tennis racket less than $100 for my friends birthday present, and prepare a "
        "short message to amogh to let them know I am planning a party via iMessages")


def test_imessage_task_routes_messaging_steps_to_messages() -> None:
    expect = {
        "Search for tennis rackets under $100": None,
        "Compare top racket options": None,
        "Present recommended racket for your approval": None,
        "Open Messages and find Amogh's contact": MESSAGES_APP,
        "Draft a short party message to Amogh": MESSAGES_APP,
        "Send message only after your approval": MESSAGES_APP,
    }
    for title, app in expect.items():
        assert route_app(TASK, title, "") == app, title


def test_messaging_words_alone_do_not_open_messages() -> None:
    whatsapp = "prepare a short message to my friends via whatsapp"
    assert route_app(whatsapp, "Draft WhatsApp party message", "") is None
    assert route_app("plan a party", "Write it in Apple Notes", "") == NOTES_APP


def test_app_request_uses_app_prompt_and_no_url_tool() -> None:
    steps = [ExecStep(id="s5", index=5, title="Draft a short party message to Amogh", description="")]

    async def emit(kind: str, payload: dict) -> None:
        pass

    rs = RunState(task_prompt=TASK, steps=steps, config=ExecConfig(), emit=emit, stop=asyncio.Event())
    req = build_request(rs, steps[0], None, pixel=False, app="Messages")
    names = {t.get("name") for t in req["tools"]}
    assert "open_url" not in names and {"click_element", "type_into_element"} <= names
    assert "Messages app" in req["system"] and "Never pick a group" in req["system"]
    assert "already has that approval" in req["system"]


def test_real_plans_route_with_full_step_text() -> None:
    """Titles AND descriptions from three real plans. The Jev plan's step 2
    says "Take notes to use in the document" and must stay in the browser."""
    import json

    cases = json.loads((Path(__file__).parent / "routing_cases.json").read_text())
    expected = {
        "iMessages": [None, None, None, MESSAGES_APP, MESSAGES_APP, MESSAGES_APP],
        '"test"': [None, None, None, MESSAGES_APP, MESSAGES_APP, MESSAGES_APP],
        "Jev": [None] * 7,
    }
    seen = 0
    for case in cases:
        key = next(k for k in expected if k in case["prompt"])
        got = [route_app(case["prompt"], t, d) for t, d in case["steps"]]
        assert got == expected[key], (key, list(zip([t for t, _ in case["steps"]], got)))
        seen += 1
    assert seen == 3


def test_app_desk_refuses_a_minimized_window(monkeypatch) -> None:
    """Real Notes state on 2026-10-02: the only titled window is off screen,
    and it stays that way through the whole recovery ladder."""
    import json

    from oversight import host_desk

    async def fake_run(*argv, timeout=15.0):
        return 0, "", ""

    monkeypatch.setattr(host_desk, "_run", fake_run)
    for k in ("LAUNCH_POLL_S", "REOPEN_POLL_S", "MENU_POLL_S", "POLL_EVERY_S"):
        monkeypatch.setattr(host_desk.AppDesk, k, 0.0)

    import pytest

    from oversight.cua import CuaDriver
    from oversight.host_desk import AppDesk

    wins = {"windows": [
        {"window_id": 97, "layer": 0, "is_on_screen": False, "title": "Notes", "z_index": 5,
         "bounds": {"width": 1000, "height": 660, "x": 0, "y": 0}},
        {"window_id": 101, "layer": 0, "is_on_screen": False, "title": "", "z_index": 9,
         "bounds": {"width": 500, "height": 500, "x": 0, "y": 0}},
    ]}

    async def runner(argv: list[str]) -> tuple[int, str, str]:
        tool = argv[2]
        if tool == "launch_app":
            return 0, json.dumps({"pid": 701, "bundle_id": "com.apple.Notes"}), ""
        if tool == "list_windows":
            return 0, json.dumps(wins), ""
        if tool == "invoke_menu":
            return 1, "", "menu item not found"
        raise AssertionError(f"unexpected {tool}")

    desk = AppDesk(CuaDriver(binary="cua-driver", runner=runner), *NOTES_APP)
    with pytest.raises(RuntimeError, match="minimized"):
        asyncio.run(desk.ensure())
