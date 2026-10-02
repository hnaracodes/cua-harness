"""AppDesk window recovery ladder: reopen, then Window menu, then a clear error."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from oversight import host_desk
from oversight.host_desk import AppDesk

BIG = {"width": 1000, "height": 660, "x": 0, "y": 0}


def win(wid: int, on: bool, title: str = "Messages") -> dict[str, Any]:
    return {"window_id": wid, "layer": 0, "is_on_screen": on, "title": title, "z_index": 1,
            "bounds": BIG}


class FakeDriver:
    """Windows follow a script: `on_open` / `on_menu` replace the window list."""

    def __init__(self, wins, on_open=None, on_menu=None) -> None:
        self.wins = wins
        self.on_open = on_open
        self.on_menu = on_menu
        self.calls: list[tuple[str, dict]] = []

    async def launch_app(self, **kw):
        self.calls.append(("launch_app", kw))
        return {"pid": 42}

    async def list_windows(self, pid=None):
        return list(self.wins)

    async def call(self, tool, args=None):
        self.calls.append((tool, args or {}))
        if tool == "invoke_menu":
            if self.on_menu is None:
                raise RuntimeError("no such menu item")
            self.wins = self.on_menu
            return {}
        raise AssertionError(tool)


@pytest.fixture
def opens(monkeypatch):
    seen: list[tuple[str, ...]] = []
    state: dict[str, FakeDriver] = {}

    async def fake_run(*argv, timeout=15.0):
        seen.append(argv)
        drv = state.get("drv")
        if argv[:2] == ("open", "-b") and drv is not None and drv.on_open is not None:
            drv.wins = drv.on_open
        return 0, "", ""

    monkeypatch.setattr(host_desk, "_run", fake_run)
    for k in ("LAUNCH_POLL_S", "REOPEN_POLL_S", "MENU_POLL_S", "POLL_EVERY_S"):
        monkeypatch.setattr(AppDesk, k, 0.0)
    return seen, state


def make(state, drv):
    state["drv"] = drv
    return AppDesk(drv, "com.apple.MobileSMS", "Messages")


def test_minimized_window_restored_by_reopen(opens) -> None:
    seen, state = opens
    drv = FakeDriver([win(7, False)], on_open=[win(7, True)])
    t = asyncio.run(make(state, drv).ensure())
    assert t.window_id == 7 and t.pid == 42
    assert ("open", "-b", "com.apple.MobileSMS") in seen
    assert not any(c[0] == "invoke_menu" for c in drv.calls)


def test_no_window_then_reopen_creates_one(opens) -> None:
    seen, state = opens
    drv = FakeDriver([], on_open=[win(9, True)])
    t = asyncio.run(make(state, drv).ensure())
    assert t.window_id == 9
    assert ("open", "-b", "com.apple.MobileSMS") in seen


def test_already_on_screen_does_nothing(opens) -> None:
    seen, state = opens
    drv = FakeDriver([win(3, True)])
    t = asyncio.run(make(state, drv).ensure())
    assert t.window_id == 3
    assert not any(a[0] == "open" for a in seen)
    assert [c[0] for c in drv.calls] == ["launch_app"]


def test_window_menu_rung_restores_minimized(opens) -> None:
    seen, state = opens
    drv = FakeDriver([win(5, False, "Amogh")], on_open=None, on_menu=[win(5, True, "Amogh")])
    t = asyncio.run(make(state, drv).ensure())
    assert t.window_id == 5
    menu = [c for c in drv.calls if c[0] == "invoke_menu"]
    assert menu == [("invoke_menu", {"pid": 42, "path": ["Window", "Amogh"]})]


def test_unrecoverable_raises_clear_message(opens) -> None:
    seen, state = opens
    drv = FakeDriver([win(5, False)])
    with pytest.raises(RuntimeError) as e:
        asyncio.run(make(state, drv).ensure())
    assert str(e.value) == ("Couldn't bring up a Messages window: it stayed minimized or hidden "
                            "after reopening it. Open Messages once and run again.")


def test_refresh_adopts_new_on_screen_window(opens) -> None:
    seen, state = opens
    drv = FakeDriver([win(3, True)])
    desk = make(state, drv)
    asyncio.run(desk.ensure())
    drv.wins = [win(3, False), win(11, True)]
    t = asyncio.run(desk.refresh_window())
    assert t.window_id == 11
    assert not any(a[0] == "open" for a in seen)
