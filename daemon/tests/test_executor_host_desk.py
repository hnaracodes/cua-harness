"""HostDeskEnvironment against Peripheral's Environment interface (imported from
testing/, never copied). Skipped when testing/ or its deps are not importable.

Run: uv run --with pytest --with pydantic --with pyyaml --with anthropic \
       pytest daemon/tests/test_executor_host_desk.py -q
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1]))
for cand in (HERE.parents[2] / "testing", HERE.parents[3] / "testing"):
    if (cand / "peripheral").is_dir():
        sys.path.insert(0, str(cand))
        break

peripheral_actions = pytest.importorskip("peripheral.actions")
pytest.importorskip("peripheral.vm.base")

from oversight.cua import CuaDriver  # noqa: E402
from oversight.host_desk import make_host_desk_environment  # noqa: E402


class FakeRunner:
    def __init__(self) -> None:
        self.argv: list[list[str]] = []

    async def __call__(self, argv: list[str]) -> tuple[int, str, str]:
        self.argv.append(argv)
        return 0, json.dumps({"ok": True}), ""


class FakeDesk:
    def __init__(self, driver: CuaDriver) -> None:
        self.driver = driver
        self.target = SimpleNamespace(pid=10, window_id=20)

    async def ensure(self, url=None):
        return self.target

    async def close(self) -> None:
        pass


def test_host_desk_environment_contract() -> None:
    from peripheral.vm.base import Environment

    runner = FakeRunner()
    env = make_host_desk_environment(FakeDesk(CuaDriver(runner=runner)))
    assert isinstance(env, Environment)
    assert env.is_disposable() is False  # the user's real machine
    assert asyncio.run(env.has_snapshot("x")) is False

    Action = peripheral_actions.Action
    res = asyncio.run(env.execute(Action(kind="left_click", coordinate=(100, 200))))
    assert res.ok
    tool, args = runner.argv[-1][2], json.loads(runner.argv[-1][3])
    assert tool == "click" and (args["x"], args["y"], args["window_id"]) == (100.0, 200.0, 20)
    assert "delivery_mode" not in args

    res = asyncio.run(env.execute(Action(kind="mouse_move", coordinate=(1, 1))))
    assert not res.ok and "background" in (res.error or "")
