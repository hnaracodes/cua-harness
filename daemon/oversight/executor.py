# STUB: replaced by the executor branch at merge.
"""Minimal executor implementing the docs/01 addendum interface.

Only simulated behaviour lives here. The real cua-driver executor is owned by the
executor branch; at merge this whole file is taken from that branch. Keep any
executor-specific logic out of the rest of the daemon.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Literal

_APPDEV = Path(__file__).resolve().parent.parent.parent


@dataclass(frozen=True)
class ExecStep:
    id: str
    index: int
    title: str
    description: str


class UnapprovedStepError(AssertionError):
    """Raised if any step handed to the executor is not in the approved set."""


@dataclass
class ExecConfig:
    mode: Literal["live", "simulated"] = "live"
    max_actions_per_run: int = 25
    max_actions_per_step: int = 10
    screenshot_history: int = 3
    window_scoped_screenshots: bool = True
    own_browser_profile: bool = True
    ax_first: bool = True
    chrome_profile_dir: str = str(_APPDEV / ".agent-desk" / "chrome-profile")
    provider: str = "anthropic"
    model: str = "claude-sonnet-5-5"


Emit = Callable[[str, dict], Awaitable[None]]


def _assert_approved(step: ExecStep, approved_ids: frozenset[str]) -> None:
    if step.id not in approved_ids:
        raise UnapprovedStepError(f"step {step.index} ({step.id}) is not approved")


_SIM_ACTIONS = [
    ("focus", "Chrome (agent profile)", "Bring the agent's own browser window forward"),
    ("type", "address bar", "Enter the query for this step"),
    ("read", "window", "Read the accessibility tree of the target window"),
]


async def run_steps(task_prompt: str, steps: list[ExecStep], approved_ids: frozenset[str],
                    emit: Emit, stop: asyncio.Event, config: ExecConfig) -> dict:
    for s in steps:  # entry assertion
        _assert_approved(s, approved_ids)

    attempted: list[str] = []
    completed: list[str] = []
    n = 0
    status = "completed"
    for s in steps:
        if stop.is_set():
            status = "stopped"
            await emit("step_result", {"step_id": s.id, "index": s.index, "status": "skipped",
                                       "summary": "Stopped before this step."})
            continue
        _assert_approved(s, approved_ids)  # again, immediately before dispatch
        attempted.append(s.id)
        await emit("step_started", {"step_id": s.id, "index": s.index, "title": s.title})
        stopped_here = False
        for verb, target, detail in _SIM_ACTIONS[: config.max_actions_per_step]:
            if stop.is_set():
                stopped_here = True
                break
            if n >= config.max_actions_per_run:
                status = "capped"
                break
            n += 1
            await asyncio.sleep(0.15)
            await emit("action", {"step_id": s.id, "n": n, "mode": "sim", "verb": verb,
                                  "target": target, "detail": f"{detail}: {s.title}",
                                  "ok": True, "error": None})
        if stopped_here:
            status = "stopped"
            await emit("step_result", {"step_id": s.id, "index": s.index, "status": "stopped",
                                       "summary": "Stopped by the user."})
            continue
        if status == "capped":
            await emit("step_result", {"step_id": s.id, "index": s.index, "status": "failed",
                                       "summary": "Action cap reached."})
            break
        completed.append(s.id)
        await emit("step_result", {"step_id": s.id, "index": s.index, "status": "done",
                                   "summary": f"Simulated: {s.title}."})

    if status == "completed":
        message = "All approved steps were attempted."
    elif status == "stopped":
        message = "Stopped by the user."
    else:
        message = "Stopped at the action cap."
    result = {"status": status, "message": message, "attempted": attempted,
              "completed": completed}
    await emit("final_result", result)
    return result
