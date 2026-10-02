"""What a feature route module gets from create_app (contract C4)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..api import State
    from ..llm import ImageInput


@dataclass
class Ctx:
    st: "State"
    # (task_id | None, run_id | None, CallRecord) -> persists, adds session cost, emits `cost`
    record_call: Callable[..., Awaitable[None]]
    # (task_id, stage, message, done, total) -> emits `plan_progress`
    progress: Callable[..., Awaitable[None]]
    # (task_id, step_id) -> decision snapshot (the training signal)
    scores_snapshot: Callable[[str, str], dict]
    # (task_id, prompt, steps, *, context=None, on_done=None) -> score dicts (to_api shape).
    # Scores only `steps`; `context` (default: steps) is the whole plan the scorer sees.
    score_steps: Callable[..., Awaitable[list[dict]]]
    # task_id -> the task's attachments as images (missing files skipped)
    load_images: Callable[[str], list["ImageInput"]]
    extra: dict[str, Any] | None = None
