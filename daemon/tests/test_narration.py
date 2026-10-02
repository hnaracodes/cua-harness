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
