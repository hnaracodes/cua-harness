"""Planner: task prompt to 4-8 individually refusable steps, structured output."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .llm import CallRecord, ImageInput, LLMError, StructuredLLM

GLYPHS = ("search", "compare", "cart", "message", "send", "contacts", "browse",
          "document", "calendar", "payment", "settings", "generic")

MIN_STEPS = 4
MAX_STEPS = 8

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "glyph": {"type": "string", "enum": list(GLYPHS)},
                },
                "required": ["title", "description", "glyph"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["steps"],
    "additionalProperties": False,
}

SYSTEM = f"""You plan tasks for a computer-use agent that works on the user's desktop.
A human reviews your plan step by step before anything runs and may approve or refuse
each step on its own. So:

- Produce {MIN_STEPS} to {MAX_STEPS} steps, in execution order.
- Each step is one concrete, individually meaningful and individually refusable action.
  Never bundle actions with different risk into one step: searching, choosing, adding
  to a cart, paying, drafting a message, choosing recipients and sending are separate.
- If the request has several parts, cover every part.
- Do not silently escalate: if the user asked to prepare or find something, plan that,
  and put any riskier follow-on action (buying, sending, deleting) in its own step,
  described as happening only after review.
- title: imperative, at most 8 words, e.g. "Search for tennis rackets under $100".
- description: one or two sentences saying what the agent will do and where.
- glyph: pick from {", ".join(GLYPHS)}.
Respond with the JSON object only."""

IMAGES_NOTE = ("\nThe user attached one or more images with the task. Treat them as context the "
               "user provided (for example a product, a form, or a screenshot to work from). "
               "Plan only the actions the task asks for; never plan to upload or forward the "
               "images unless the task says to.")


@dataclass
class PlannedStep:
    title: str
    description: str
    glyph: str


def validate_plan(data: dict) -> list[PlannedStep]:
    steps = data.get("steps")
    if not isinstance(steps, list):
        raise LLMError("plan has no steps array")
    if not MIN_STEPS <= len(steps) <= MAX_STEPS:
        raise LLMError(f"plan has {len(steps)} steps, expected {MIN_STEPS} to {MAX_STEPS}")
    out = []
    for s in steps:
        title = str(s.get("title", "")).strip()
        desc = str(s.get("description", "")).strip()
        glyph = s.get("glyph") if s.get("glyph") in GLYPHS else "generic"
        if not title or not desc:
            raise LLMError("plan step missing title or description")
        out.append(PlannedStep(title, desc, glyph))
    return out


async def plan_task(llm: StructuredLLM, prompt: str, selected_app: str | None,
                    on_call=None, images: Sequence[ImageInput] = ()) -> list[PlannedStep]:
    """Returns validated steps. Retries once on invalid output. `on_call(record)` is
    awaited after every LLM call for cost accounting."""
    user = f"Task: {prompt}"
    if selected_app:
        user += f"\nSelected app: {selected_app}"
    system = SYSTEM + IMAGES_NOTE if images else SYSTEM
    last: Exception | None = None
    for _attempt in range(2):
        try:
            data, rec = await llm.call(scope="plan", system=system, user=user,
                                       schema=PLAN_SCHEMA, schema_name="plan",
                                       effort="medium", max_tokens=8000, images=images)
        except LLMError as e:
            if on_call and e.record:
                await on_call(e.record)
            last = e
            continue
        if on_call:
            await on_call(rec)
        try:
            return validate_plan(data)
        except LLMError as e:
            last = e
    raise LLMError(f"planner failed: {last}")


__all__ = ["GLYPHS", "IMAGES_NOTE", "PlannedStep", "plan_task", "validate_plan", "CallRecord"]
