"""Re-propose: revise a plan from the user's decisions and a chat instruction.

Spec: Daemon API changes §2 (built on docs/01 step 6). The model returns the whole
revised plan; each step either keeps an existing id (`keep_step_id`) or is new. The
daemon, not the model, decides what counts as unchanged (exact title + description).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from . import approval
from .llm import ImageInput, LLMError, StructuredLLM
from .planner import GLYPHS, MAX_STEPS, MIN_STEPS
from .store import new_id

REVISE_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "keep_step_id": {"type": ["string", "null"]},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "glyph": {"type": "string", "enum": list(GLYPHS)},
                },
                "required": ["keep_step_id", "title", "description", "glyph"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["steps"],
    "additionalProperties": False,
}

SYSTEM = f"""You revise a plan for a computer-use agent. A human already reviewed the
current plan step by step and may have approved or removed steps. Return the WHOLE
revised plan, in execution order, {MIN_STEPS} to {MAX_STEPS} steps.

- For every step you keep exactly as it is, copy its title and description verbatim and
  set keep_step_id to its id. Change nothing the instruction does not require.
- For a step you rewrite, keep its id in keep_step_id and give the new title/description.
- For a brand-new step, set keep_step_id to null.
- Respect the human's decisions. A [removed] step stays in the plan verbatim with its id
  (it will not run) unless the instruction explicitly asks to bring it back; then rewrite
  it. Do not rewrite [approved] steps unless the instruction asks you to change them.
- An [edited] step was reworded by the human. Keep their wording unless the instruction
  asks you to change it.
- Leave a step out only if the instruction asks to drop it or it no longer makes sense.
- Each step is one concrete, individually refusable action. Never bundle risky actions
  (buying, sending, deleting) into a safer step.
- title: imperative, at most 8 words. description: one or two sentences.
- glyph: pick from {", ".join(GLYPHS)}.
Respond with the JSON object only."""


@dataclass(frozen=True)
class RevisedStep:
    keep_step_id: str | None
    title: str
    description: str
    glyph: str


@dataclass
class Merge:
    steps: list[dict]
    changed: set[str]
    added: set[str]
    dropped: set[str]
    unchanged: set[str]


def validate_revision(data: dict, current_ids: set[str]) -> list[RevisedStep]:
    steps = data.get("steps")
    if not isinstance(steps, list):
        raise LLMError("revision has no steps array")
    if not MIN_STEPS <= len(steps) <= MAX_STEPS:
        raise LLMError(f"revision has {len(steps)} steps, expected {MIN_STEPS} to {MAX_STEPS}")
    out = []
    for s in steps:
        title = str(s.get("title", "")).strip()
        desc = str(s.get("description", "")).strip()
        if not title or not desc:
            raise LLMError("revised step missing title or description")
        keep = s.get("keep_step_id")
        keep = keep if isinstance(keep, str) and keep in current_ids else None
        glyph = s.get("glyph") if s.get("glyph") in GLYPHS else "generic"
        out.append(RevisedStep(keep, title, desc, glyph))
    return out


def polygon_approved_ids(positions: Mapping[str, Mapping[str, float]] | None,
                         boundaries: Sequence[Mapping] | None) -> set[str]:
    """Steps whose RAW point lies inside a stored boundary. The store keeps them 'pending'
    until /run, but for the user they are already approved."""
    out: set[str] = set()
    for b in boundaries or ():
        pos = {sid: p for sid, p in (positions or {}).items()
               if b["x_dim"] in p and b["y_dim"] in p}
        out.update(approval.inside_step_ids(pos, b["x_dim"], b["y_dim"], b.get("polygon") or []))
    return out


def render_current(steps: list[dict],
                   positions: Mapping[str, Mapping[str, float]] | None = None,
                   boundaries: Sequence[Mapping] | None = None) -> str:
    inside = polygon_approved_ids(positions, boundaries)

    def status(s: dict) -> str:
        return "approved" if s["status"] == "pending" and s["id"] in inside else s["status"]

    return "\n".join(f"- id={s['id']} [{status(s)}]{' [edited]' if s.get('edited_from') else ''} "
                     f"{s['index']}. {s['title']}: {s['description']}"
                     for s in sorted(steps, key=lambda s: s["index"]))


async def replan(llm: StructuredLLM, prompt: str, current_steps: list[dict],
                 instruction: str | None, images: Sequence[ImageInput] = (),
                 on_call=None, *, positions: Mapping[str, Mapping[str, float]] | None = None,
                 boundaries: Sequence[Mapping] | None = None) -> list[RevisedStep]:
    """Validated revised plan. Retries once on invalid output; `on_call(record)` is awaited
    after every LLM call for cost accounting (like planner.plan_task). `positions` and
    `boundaries` (the stored ones) let steps inside a polygon read as [approved]."""
    user = (f"Task: {prompt}\n\nCurrent plan (id, [status], index. title: description):\n"
            f"{render_current(current_steps, positions, boundaries)}\n\nInstruction from the user: "
            f"{instruction or '(none: change only what the decisions above require)'}")
    ids = {s["id"] for s in current_steps}
    last: Exception | None = None
    for _attempt in range(2):
        try:
            data, rec = await llm.call(scope="plan", system=SYSTEM, user=user,
                                       schema=REVISE_SCHEMA, schema_name="revise",
                                       effort="medium", max_tokens=8000, images=images)
        except LLMError as e:
            if on_call and e.record:
                await on_call(e.record)
            last = e
            continue
        if on_call:
            await on_call(rec)
        try:
            return validate_revision(data, ids)
        except LLMError as e:
            last = e
    raise LLMError(f"replanner failed: {last}")


_DROP = re.compile(r"^drop (\d+)$", re.I)
_ADD = re.compile(r"^add (.+)$", re.I)


def fixture_replan(current_steps: list[dict], instruction: str | None) -> list[RevisedStep]:
    """Deterministic --fixtures revision. Test grammar, clauses split by ';':
    `drop N` drops step N, `add <title>` appends a new step; any other text is appended
    to the last non-removed step's title as ' (revised: <text>)'."""
    cur = sorted(current_steps, key=lambda s: s["index"])
    out = [RevisedStep(s["id"], s["title"], s["description"], s["glyph"]) for s in cur]
    added: list[RevisedStep] = []
    drops: set[int] = set()
    free: list[str] = []
    for clause in (c.strip() for c in (instruction or "").split(";")):
        if not clause:
            continue
        if m := _DROP.match(clause):
            drops.add(int(m.group(1)))
        elif m := _ADD.match(clause):
            added.append(RevisedStep(None, m.group(1).strip(), f"{m.group(1).strip()}.", "generic"))
        else:
            free.append(clause)
    if free:
        active = [i for i, s in enumerate(cur) if s["status"] != "removed"]
        if active:
            i = active[-1]
            r = out[i]
            out[i] = RevisedStep(r.keep_step_id, f"{r.title} (revised: {'; '.join(free)})",
                                 r.description, r.glyph)
    kept = [r for r, s in zip(out, cur) if s["index"] not in drops]
    return kept + added


def merge_revision(task_id: str, current_steps: list[dict],
                   revised: list[RevisedStep]) -> Merge:
    """Apply a revision to the stored steps (pure). Unchanged = same id and identical
    title + description: keeps id, status, scores, edited_from, revision. A rewritten kept
    step keeps its id, becomes pending, revision+1. Unknown or repeated ids become new."""
    by_id = {s["id"]: s for s in current_steps}
    out: list[dict] = []
    used: set[str] = set()
    changed: set[str] = set()
    added: set[str] = set()
    unchanged: set[str] = set()
    for i, r in enumerate(revised, start=1):
        old = by_id.get(r.keep_step_id) if r.keep_step_id else None
        if old is not None and old["id"] not in used:
            used.add(old["id"])
            if old["title"] == r.title and old["description"] == r.description:
                out.append({**old, "index": i})
                unchanged.add(old["id"])
            else:
                out.append({**old, "index": i, "title": r.title, "description": r.description,
                            "glyph": r.glyph, "status": "pending",
                            "revision": int(old.get("revision", 0)) + 1})
                changed.add(old["id"])
        else:
            sid = new_id("stp")
            out.append({"id": sid, "task_id": task_id, "index": i, "title": r.title,
                        "description": r.description, "glyph": r.glyph, "status": "pending",
                        "edited_from": None, "revision": 0})
            added.add(sid)
    dropped = set(by_id) - used
    return Merge(out, changed, added, dropped, unchanged)


__all__ = ["REVISE_SCHEMA", "SYSTEM", "Merge", "RevisedStep", "fixture_replan",
           "merge_revision", "replan", "render_current", "validate_revision"]
