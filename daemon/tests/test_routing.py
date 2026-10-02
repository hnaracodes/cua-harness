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
