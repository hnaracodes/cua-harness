"""End-of-run recap (spec: Daemon API §3, Screens §3).

One structured call turns the step results into the last message the user reads: what got
done, what was skipped and why. Structured output, never prose parsed with a regex. If the
call fails for any reason, or returns anything that is not faithful to the facts, a
deterministic fallback says the same thing plainly. A run always ends with a recap."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .llm import CallRecord, LLMError

RecapStep = dict  # {"id": str, "index": int, "title": str, "removed": bool}
OnCall = Callable[[CallRecord], Awaitable[None]]

RECAP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "done": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"step_id": {"type": "string"}, "text": {"type": "string"}},
                "required": ["step_id", "text"],
                "additionalProperties": False,
            },
        },
        "skipped": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"step_id": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["step_id", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["headline", "done", "skipped"],
    "additionalProperties": False,
}

SYSTEM = """You write the last message a user reads after a computer-use agent finished a task
they approved step by step. You get the task, every planned step, and what happened to each.
- headline: one plain sentence saying the outcome.
- done: one item per step whose outcome is "done", in step order. text: one sentence saying
  what was done and where the result is (which site, app or window), using only the facts given.
- skipped: one item per step that did not finish (removed by the user, failed, stopped, skipped
  or never reached), in step order. reason: a short plain reason taken from the facts.
Never invent results, links, prices or names that are not in the facts. Respond with JSON only."""


def _headline(status: str, n_done: int, n_removed: int) -> str:
    if status == "completed":
        extra = f" {n_removed} skipped as you asked." if n_removed else ""
        return f"Done: {n_done} step(s) completed.{extra}"
    if status == "stopped":
        return f"Stopped by you after {n_done} step(s)."
    if status == "capped":
        return f"Stopped at the action limit after {n_done} step(s)."
    return f"Stopped early: a step failed after {n_done} step(s) completed."


def build_fallback_recap(steps: list[RecapStep], results: Mapping[str, dict],
                         final: Mapping) -> dict:
    done: list[dict] = []
    skipped: list[dict] = []
    for s in sorted(steps, key=lambda x: x["index"]):
        sid = s["id"]
        r = results.get(sid)
        status = (r or {}).get("status")
        summary = (r or {}).get("summary")
        if s.get("removed"):
            skipped.append({"step_id": sid, "reason": "Removed before the run."})
        elif r is None:
            skipped.append({"step_id": sid, "reason": "Not run: the run ended early."})
        elif status == "done":
            done.append({"step_id": sid, "text": str(summary or "Done.")})
        elif status == "failed":
            skipped.append({"step_id": sid, "reason": f"Failed: {summary or 'no reason given'}"})
        elif status == "stopped":
            skipped.append({"step_id": sid, "reason": "Stopped by the user."})
        else:
            skipped.append({"step_id": sid, "reason": str(summary or "Not run: the run ended early.")})
    n_removed = sum(1 for s in steps if s.get("removed"))
    return {"headline": _headline(str(final.get("status", "failed")), len(done), n_removed),
            "done": done, "skipped": skipped, "source": "fallback"}


def _faithful(data: Any, steps: list[RecapStep], results: Mapping[str, dict]) -> bool:
    if not isinstance(data, dict) or not str(data.get("headline", "")).strip():
        return False
    known = {s["id"] for s in steps}
    finished = {sid for sid, r in results.items() if r.get("status") == "done"}
    for item in data.get("done", []):
        if not isinstance(item, dict) or item.get("step_id") not in finished or not str(item.get("text", "")).strip():
            return False
    for item in data.get("skipped", []):
        if not isinstance(item, dict) or item.get("step_id") not in known or not str(item.get("reason", "")).strip():
            return False
    return True


async def build_recap(llm: Any, prompt: str, steps: list[RecapStep], results: Mapping[str, dict],
                      final: Mapping, on_call: OnCall | None = None) -> dict:
    facts = {
        "task": prompt,
        "final_status": final.get("status"),
        "final_message": final.get("message"),
        "steps": [{"step_id": s["id"], "index": s["index"], "title": s["title"],
                   "outcome": ("removed by the user before the run" if s.get("removed")
                               else (results.get(s["id"]) or {}).get("status", "not reached")),
                   "summary": (results.get(s["id"]) or {}).get("summary")}
                  for s in sorted(steps, key=lambda x: x["index"])],
    }
    try:
        data, rec = await llm.call(scope="recap", system=SYSTEM,
                                   user=json.dumps(facts, ensure_ascii=False),
                                   schema=RECAP_SCHEMA, schema_name="run_recap",
                                   effort="low", max_tokens=2000)
    except LLMError as e:
        if on_call and e.record:
            await on_call(e.record)
        return build_fallback_recap(steps, results, final)
    except Exception:  # network, SDK, anything: the chat must still end in a summary
        return build_fallback_recap(steps, results, final)
    if on_call:
        await on_call(rec)
    if not _faithful(data, steps, results):
        return build_fallback_recap(steps, results, final)
    return {
        "headline": str(data["headline"]).strip(),
        "done": [{"step_id": d["step_id"], "text": str(d["text"]).strip()} for d in data["done"]],
        "skipped": [{"step_id": d["step_id"], "reason": str(d["reason"]).strip()} for d in data["skipped"]],
        "source": "llm",
    }
