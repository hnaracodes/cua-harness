"""Re-propose and step edit (spec: Daemon API changes §2). Track D3."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..llm import CallRecord, LLMError
from ..replanner import fixture_replan, merge_revision, replan
from .ctx import Ctx


class ReviseBody(BaseModel):
    instruction: str | None = None


class StepPatch(BaseModel):
    title: str | None = None
    description: str | None = None


def _err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def register(app: FastAPI, ctx: Ctx) -> None:
    st = ctx.st
    store = st.store

    @app.post("/task/{task_id}/repropose")
    async def repropose(task_id: str, body: ReviseBody):
        task = store.get_task(task_id)
        if task is None:
            return _err(404, "task not found", task_id=task_id)
        if task_id in st.active_runs:
            return _err(409, "a run is in progress for this task")
        lock = st.plan_locks.setdefault(task_id, asyncio.Lock())
        if lock.locked():
            return _err(409, "a plan is being generated for this task")
        async with lock:
            current = store.get_steps(task_id)
            if not current:
                return _err(409, "task has no plan yet")
            instruction = (body.instruction or "").strip() or None
            await ctx.progress(task_id, "planning", "Revising the plan.", 0, 0)
            try:
                if st.settings.fixtures:
                    revised = fixture_replan(current, instruction)
                else:
                    async def on_call(rec: CallRecord) -> None:
                        await ctx.record_call(task_id, None, rec)

                    revised = await replan(st.llm, task["prompt"], current, instruction,
                                           images=ctx.load_images(task_id), on_call=on_call,
                                           positions=store.positions_by_step(task_id),
                                           boundaries=store.get_boundaries(task_id))
                merged = merge_revision(task_id, current, revised)
                to_score = [s for s in merged.steps if s["id"] in merged.changed | merged.added]
                total = len(to_score)
                new_scores: list[dict] = []
                if total:
                    await ctx.progress(task_id, "scoring", "Preparing oversight view. Scoring "
                                       "actions and placing them on the grid.", 0, total)
                    done = 0

                    async def on_done(v) -> None:
                        nonlocal done
                        done += 1
                        await ctx.progress(task_id, "scoring", f"Scored step {v.index}.", done, total)

                    new_scores = await ctx.score_steps(task_id, task["prompt"], to_score,
                                                       context=merged.steps, on_done=on_done)
            except LLMError as e:
                await ctx.progress(task_id, "error", str(e), 0, 0)
                return _err(502, f"revising failed: {e}")

            # Training signal: what changed/dropped steps looked like BEFORE the revision.
            before = {sid: ctx.scores_snapshot(task_id, sid) for sid in merged.changed | merged.dropped}
            kept_scores = [sc for sc in store.get_scores(task_id) if sc["step_id"] in merged.unchanged]
            store.revise_plan(task_id, merged.steps, kept_scores + new_scores)
            for sid in sorted(merged.changed | merged.dropped):
                store.add_decision(task_id, sid, "revise", "chat", {**before[sid], "instruction": instruction})
            for sid in sorted(merged.added):
                store.add_decision(task_id, sid, "revise", "chat",
                                   {**ctx.scores_snapshot(task_id, sid), "instruction": instruction})

            revision = 1 + sum(1 for e in store.get_events(task_id) if e["kind"] == "plan_revised")
            await st.bus.emit(task_id, None, "plan_revised", {
                "revision": revision, "instruction": instruction,
                "changed_step_ids": sorted(merged.changed), "added_step_ids": sorted(merged.added),
                "dropped_step_ids": sorted(merged.dropped)})
            n = len(merged.steps)
            await ctx.progress(task_id, "done", f"Plan revised: {n} steps.", n, n)
            return {"task_id": task_id, "steps": store.get_steps(task_id),
                    "scores": store.get_scores(task_id), "revision": revision}

    @app.patch("/task/{task_id}/step/{step_id}")
    async def edit_step(task_id: str, step_id: str, body: StepPatch):
        task = store.get_task(task_id)
        if task is None:
            return _err(404, "task not found", task_id=task_id)
        title = (body.title or "").strip()
        desc = (body.description or "").strip()
        if not title and not desc:
            return _err(400, "nothing to change: give a title or a description")
        steps = store.get_steps(task_id)
        step = next((s for s in steps if s["id"] == step_id), None)
        if step is None:
            return _err(404, "step not found in task", step_id=step_id)
        if task_id in st.active_runs:
            return _err(409, "a run is in progress for this task")
        new_title = title or step["title"]
        new_desc = desc or step["description"]
        if new_title == step["title"] and new_desc == step["description"]:
            return {"step": step, "scores": [s for s in store.get_scores(task_id) if s["step_id"] == step_id]}

        snap = ctx.scores_snapshot(task_id, step_id)  # what the user saw before editing
        edited = {**step, "title": new_title, "description": new_desc}
        context = [edited if s["id"] == step_id else s for s in steps]
        try:
            scores = await ctx.score_steps(task_id, task["prompt"], [edited], context=context)
        except LLMError as e:
            return _err(502, f"rescoring failed: {e}")
        store.update_step(step_id, new_title, new_desc, step["title"])
        store.set_step_status(step_id, "pending")  # approval of old text never carries over
        store.replace_step_scores(step_id, scores)
        store.add_decision(task_id, step_id, "edit", "step_list", {
            **snap, "edited_from": step["title"], "new_title": new_title,
            "new_description": new_desc})
        fresh = next(s for s in store.get_steps(task_id) if s["id"] == step_id)
        return {"step": fresh, "scores": [s for s in store.get_scores(task_id) if s["step_id"] == step_id]}
