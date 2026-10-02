"""FastAPI daemon. Implements the docs/01 sprint contract addendum.

The UI renders and captures gestures; every decision is made here. `POST /run`
recomputes the approved set itself and hands the executor only approved steps.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import approval, apps, executor, fixtures
from .dimensions import DIMENSION_KEYS, load_dimensions
from .events import EventBus
from .llm import CallRecord, ImageInput, LLMError, StructuredLLM
from .planner import plan_task
from .routes import attachments as attachments_routes
from .routes import frames as frames_routes
from .routes import revise as revise_routes
from .routes import setup as setup_routes
from .routes.ctx import Ctx
from .scorer import SCORER_VERSION, LLMScorer, StepView, content_hash
from .settings import Settings, cua_driver_status
from .store import Store, new_id

log = logging.getLogger("oversight")
MAX_ATTACHMENTS = 4


def err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


# ---------------------------------------------------------------- bodies


class TaskBody(BaseModel):
    prompt: str
    selected_app: str | None = None
    attachment_ids: list[str] = []


class BoundaryBody(BaseModel):
    x_dim: str
    y_dim: str
    polygon: list[list[float]]


class DecisionBody(BaseModel):
    step_id: str
    action: str
    source: str = "plan_panel"


class RunBody(BaseModel):
    approved_step_ids: list[str]
    checked_step_ids: list[str] = []
    removed_step_ids: list[str] = []
    boundaries: list[BoundaryBody] | None = None


@dataclass
class ActiveRun:
    """One per task. Registered synchronously by POST /run before its first await, so a
    concurrent /run (or a forced re-plan) sees the slot taken. `run_id` is empty while
    the run is still being validated and preflighted."""
    run_id: str
    stop: asyncio.Event
    task: asyncio.Task | None = None


@dataclass
class State:
    settings: Settings
    store: Store
    bus: EventBus
    llm: StructuredLLM | None
    plan_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    active_runs: dict[str, ActiveRun] = field(default_factory=dict)
    session_cost: float = 0.0


def _validate_boundary(b: BoundaryBody) -> str | None:
    if b.x_dim not in DIMENSION_KEYS or b.y_dim not in DIMENSION_KEYS:
        return f"unknown dimension in ({b.x_dim}, {b.y_dim})"
    for p in b.polygon:
        if len(p) != 2:
            return "polygon points must be [x, y]"
        # NaN/Infinity would make the ray cast approve arbitrary steps and poison
        # GET /task (JSON cannot encode them). The grid is normalized 0..1.
        if not all(math.isfinite(v) and 0.0 <= v <= 1.0 for v in p):
            return "polygon coordinates must be finite numbers in [0, 1]"
    return None


# The app's own webview (macOS/Linux tauri://localhost, Windows http(s)://tauri.localhost)
# and the Vite dev / Playwright servers on loopback. Nothing else may drive the daemon.
APP_ORIGIN_REGEX = (r"^(tauri://localhost|https?://tauri\.localhost"
                    r"|http://(localhost|127\.0\.0\.1)(:\d+)?)$")
_APP_ORIGIN = re.compile(APP_ORIGIN_REGEX)


class OriginGuard:
    """403 for any request whose Origin header is present and is not the app. CORS alone
    only hides responses: a "simple" cross-origin POST (or a form post) still reaches the
    route and runs. Requests with no Origin (curl, scripts, tests) are allowed, so a curl
    script keeps full capability."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            origins = [v.decode("latin-1") for k, v in scope.get("headers", [])
                       if k.lower() == b"origin"]
            if origins and not all(_APP_ORIGIN.fullmatch(o) for o in origins):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await JSONResponse({"error": "origin not allowed"},
                                   status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


INTERRUPTED_MESSAGE = "The daemon restarted during this run."


def close_interrupted_runs(store: Store) -> None:
    """At startup, a run row with no finished_at was cut off by a restart (nothing can
    still be driving it). Mark it failed and end its chat the way every run ends: a
    run_recap, then a final_result, so the UI never shows a run that is forever running."""
    from . import recap

    for run in store.unfinished_runs():
        task_id, run_id = run["task_id"], run["id"]
        removed = set(run["removed"])
        recap_steps = [{"id": s["id"], "index": s["index"], "title": s["title"],
                        "removed": s["id"] in removed} for s in store.get_steps(task_id)]
        results = {str(e["payload"].get("step_id")): e["payload"]
                   for e in store.get_events(task_id)
                   if e["run_id"] == run_id and e["kind"] == "step_result"}
        final = {"status": "failed", "message": INTERRUPTED_MESSAGE,
                 "attempted": [sid for sid, r in results.items()
                               if r.get("status") in ("done", "failed", "stopped")],
                 "completed": [sid for sid, r in results.items() if r.get("status") == "done"]}
        store.finish_run(run_id, "failed", final)
        store.append_event(task_id, run_id, "run_recap",
                           recap.build_fallback_recap(recap_steps, results, final))
        store.append_event(task_id, run_id, "final_result", final)


def create_app(settings: Settings) -> FastAPI:
    store = Store(settings.db_path)
    close_interrupted_runs(store)
    bus = EventBus(store)
    llm = None if settings.fixtures else StructuredLLM(settings.provider, settings.model)
    st = State(settings=settings, store=store, bus=bus, llm=llm)

    app = FastAPI(title="Sketch Oversight daemon")
    app.state.oversight = st
    app.add_middleware(CORSMiddleware, allow_origin_regex=APP_ORIGIN_REGEX,
                       allow_methods=["*"], allow_headers=["*"], expose_headers=["*"])
    # Added last, so it runs first: a foreign page is refused before CORS or any route.
    app.add_middleware(OriginGuard)

    @app.exception_handler(RequestValidationError)
    async def _validation(_req: Request, exc: RequestValidationError):
        return err(422, "invalid request body", detail=json.loads(json.dumps(exc.errors(),
                                                                               default=str)))

    # ------------------------------------------------------------ helpers

    async def record_call(task_id: str | None, run_id: str | None, rec: CallRecord) -> None:
        store.add_llm_call(task_id, run_id, rec)
        st.session_cost = round(st.session_cost + rec.usd, 6)
        if task_id:
            await bus.emit(task_id, run_id, "cost", {
                "scope": rec.scope, "model": rec.model, "usd_delta": rec.usd,
                "usd_total": store.task_cost(task_id), "latency_ms": rec.latency_ms,
                "input_tokens": rec.input_tokens, "output_tokens": rec.output_tokens,
            })

    def scores_snapshot(task_id: str, step_id: str) -> dict:
        """What the step looked like when the user decided: the training signal."""
        step = next((s for s in store.get_steps(task_id) if s["id"] == step_id), None)
        scores = [s for s in store.get_scores(task_id) if s["step_id"] == step_id]
        pos = {s["dimension"]: s["position"] for s in scores}
        points = {}
        for b in store.get_boundaries(task_id):
            if b["x_dim"] in pos and b["y_dim"] in pos:
                x, y = pos[b["x_dim"]], pos[b["y_dim"]]
                points[f"{b['x_dim']}|{b['y_dim']}"] = {
                    "point": [x, y],
                    "inside": approval.point_in_polygon(x, y, b["polygon"]),
                }
        return {"step": step, "scores": scores, "grid_points": points}

    # ------------------------------------------------------------ status

    @app.get("/health")
    async def health():
        cua_ok, cua_word, cua_detail = await cua_driver_status()
        model = settings.display_model
        key_word = "API key found" if settings.api_key_present else "API key missing"
        if settings.fixtures:
            status_line = f"Ready. cua-driver {cua_word}, {key_word}, fixtures mode (no API calls)."
        else:
            status_line = f"Ready. cua-driver {cua_word}, {key_word}, model {model}."
        if settings.exec_mode == "live" and not cua_ok:
            status_line = (f"Live execution blocked: cua-driver {cua_word}. "
                           f"{key_word}, model {model}. Planning and scoring still work.")
        elif settings.exec_mode == "simulated":
            status_line = status_line[:-1] + ", simulated executor."
        return {
            "daemon": "ok",
            "api_key": settings.api_key_present,
            "provider": settings.display_provider,
            "model": model,
            "cua_driver": cua_ok,
            "fixtures": settings.fixtures,
            "cua_driver_detail": cua_detail,
            "exec_mode": settings.exec_mode,
            "cost_usd_total": st.session_cost,
            "cost_usd_all_time": store.total_cost(),
            "status_line": status_line,
            "setup_complete": bool(store.get_setting("setup_complete", False)),
            "plan_only": bool(store.get_setting("plan_only", False)),
        }

    @app.get("/dimensions")
    async def dimensions():
        return {"dimensions": [d.to_api() for d in load_dimensions()]}

    @app.get("/boundaries")
    async def saved_boundaries():
        return {"boundaries": store.get_boundaries(None)}

    # ------------------------------------------------------------ tasks

    @app.get("/tasks")
    async def tasks():
        return {"tasks": [{"id": t["id"], "prompt": t["prompt"], "created_at": t["created_at"],
                           "step_count": t["step_count"]} for t in store.list_tasks()]}

    @app.post("/task")
    async def create_task(body: TaskBody):
        prompt = body.prompt.strip()
        if not prompt:
            return err(400, "prompt is empty")
        if len(body.attachment_ids) > MAX_ATTACHMENTS:
            return err(400, f"at most {MAX_ATTACHMENTS} images per task")
        unknown = [a for a in body.attachment_ids if store.get_attachment(a) is None]
        if unknown:
            return err(400, "unknown attachment ids", unknown=unknown)
        tid = store.create_task(prompt, body.selected_app,
                                "fixtures" if settings.fixtures else "live")
        store.link_attachments(tid, body.attachment_ids)
        return {"task_id": tid}

    @app.get("/task/{task_id}")
    async def get_task(task_id: str):
        task = store.get_task(task_id)
        if task is None:
            return err(404, "task not found", task_id=task_id)
        return {
            "task": {**task, "attachments": [
                {k: a[k] for k in ("attachment_id", "mime", "bytes")}
                for a in store.get_task_attachments(task_id)]},
            "steps": store.get_steps(task_id),
            "scores": store.get_scores(task_id),
            "boundaries": store.get_boundaries(task_id),
            "runs": store.get_runs(task_id),
            "decisions": store.get_decisions(task_id),
            "llm_calls": store.get_llm_calls(task_id),
            "cost_usd": store.task_cost(task_id),
        }

    @app.get("/task/{task_id}/scores")
    async def get_scores(task_id: str):
        if store.get_task(task_id) is None:
            return err(404, "task not found", task_id=task_id)
        return {"steps": store.get_steps(task_id), "scores": store.get_scores(task_id)}

    # ------------------------------------------------------------ plan + score

    async def progress(task_id: str, stage: str, message: str, done: int, total: int) -> None:
        await bus.emit(task_id, None, "plan_progress",
                       {"stage": stage, "message": message, "done": done, "total": total})

    async def score_steps(task_id: str, prompt: str, steps: list[dict], *,
                          context: list[dict] | None = None,
                          on_done: Callable[[StepView], Awaitable[None]] | None = None
                          ) -> list[dict]:
        """Score `steps` on all ten dimensions; the scorer sees `context` (default: steps)."""
        if settings.fixtures:
            return [sc.to_api() for sc in fixtures.scores_for_steps(steps)]
        assert st.llm is not None

        async def on_call(rec: CallRecord) -> None:
            await record_call(task_id, None, rec)

        model = f"{settings.model}|scorer-v{SCORER_VERSION}"
        scorer = LLMScorer(st.llm,
                           cache_get=lambda h: store.cache_get(h, model),
                           cache_put=lambda h, v: store.cache_put(h, model, v),
                           on_call=on_call)
        def view(s: dict) -> StepView:
            return StepView(s["id"], s["index"], s["title"], s["description"])

        ctx_views = [view(s) for s in (context or steps)]

        async def one(v: StepView) -> list:
            res = await scorer.score(prompt, v, ctx_views)
            if on_done:
                await on_done(v)
            return res

        results = await asyncio.gather(*(one(view(s)) for s in steps))
        return [sc.to_api() for r in results for sc in r]

    def load_images(task_id: str) -> list[ImageInput]:
        out = []
        for a in store.get_task_attachments(task_id):
            p = Path(a["path"])
            if p.is_file():
                out.append(ImageInput(a["mime"], p.read_bytes()))
        return out

    async def plan_fixtures(task_id: str) -> tuple[list[dict], list[dict]]:
        total = len(fixtures.STEPS)
        await progress(task_id, "planning", "Generating plan (fixtures).", 0, total)
        await asyncio.sleep(0.25)
        await record_call(task_id, None, CallRecord(scope="plan", provider="fixtures",
                                                    model="fixtures"))
        steps = [{"id": new_id("stp"), "task_id": task_id, "index": i + 1, "title": t,
                  "description": d, "glyph": g, "status": "pending", "edited_from": None,
                  "revision": 0, "app": None} for i, (t, d, g) in enumerate(fixtures.STEPS)]
        await progress(task_id, "scoring",
                       "Preparing oversight view. Scoring actions and placing them on the grid.",
                       0, total)
        for i, s in enumerate(steps):
            await asyncio.sleep(0.1)
            await record_call(task_id, None, CallRecord(scope="score", provider="fixtures",
                                                        model="fixtures"))
            await progress(task_id, "scoring", f"Scored step {s['index']}.", i + 1, total)
        scores = [sc.to_api() for sc in
                  fixtures.fixture_scores({s["index"]: s["id"] for s in steps})]
        return steps, scores

    async def plan_live(task_id: str, prompt: str, selected_app: str | None
                        ) -> tuple[list[dict], list[dict]]:
        assert st.llm is not None

        async def on_call(rec: CallRecord) -> None:
            await record_call(task_id, None, rec)

        await progress(task_id, "planning", "Generating plan.", 0, 0)
        catalog = await apps.app_catalog()
        planned = await plan_task(st.llm, prompt, selected_app, on_call=on_call,
                                  images=load_images(task_id), catalog=catalog)
        steps = [{"id": new_id("stp"), "task_id": task_id, "index": i + 1, "title": p.title,
                  "description": p.description, "glyph": p.glyph, "status": "pending",
                  "edited_from": None, "revision": 0, "app": p.app}
                 for i, p in enumerate(planned)]
        total = len(steps)
        await progress(task_id, "scoring",
                       "Preparing oversight view. Scoring actions and placing them on the grid.",
                       0, total)
        done = 0

        async def on_done(v: StepView) -> None:
            nonlocal done
            done += 1
            await progress(task_id, "scoring", f"Scored step {v.index}.", done, total)

        return steps, await score_steps(task_id, prompt, steps, on_done=on_done)

    @app.post("/task/{task_id}/plan")
    async def plan(task_id: str, force: bool = False):
        task = store.get_task(task_id)
        if task is None:
            return err(404, "task not found", task_id=task_id)
        lock = st.plan_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            existing = store.get_steps(task_id)
            if existing and not force:  # replay: a saved plan beats re-generating one
                return {"task_id": task_id, "steps": existing,
                        "scores": store.get_scores(task_id)}
            if task_id in st.active_runs:
                return err(409, "a run is in progress for this task")
            try:
                if settings.fixtures:
                    steps, scores = await plan_fixtures(task_id)
                else:
                    steps, scores = await plan_live(task_id, task["prompt"], task["selected_app"])
            except LLMError as e:
                await progress(task_id, "error", str(e), 0, 0)
                return err(502, f"planning failed: {e}")
            except Exception as e:  # pragma: no cover
                log.exception("plan failed")
                await progress(task_id, "error", f"{type(e).__name__}: {e}", 0, 0)
                return err(500, f"planning failed: {type(e).__name__}: {e}")
            store.replace_plan(task_id, steps, scores)
            await progress(task_id, "done", f"{len(steps)} steps scored on 10 dimensions.",
                           len(steps), len(steps))
            return {"task_id": task_id, "steps": store.get_steps(task_id),
                    "scores": store.get_scores(task_id)}

    # ------------------------------------------------------------ boundary + decisions

    @app.put("/task/{task_id}/boundary")
    async def put_boundary(task_id: str, body: BoundaryBody):
        if store.get_task(task_id) is None:
            return err(404, "task not found", task_id=task_id)
        problem = _validate_boundary(body)
        if problem:
            return err(400, problem)
        bid = store.put_boundary(task_id, body.x_dim, body.y_dim, body.polygon)
        inside = approval.inside_step_ids(store.positions_by_step(task_id), body.x_dim,
                                          body.y_dim, body.polygon) if bid else []
        return {"boundary_id": bid, "inside_step_ids": inside}

    @app.post("/task/{task_id}/decision")
    async def decision(task_id: str, body: DecisionBody):
        if store.get_task(task_id) is None:
            return err(404, "task not found", task_id=task_id)
        status_for = {"remove": "removed", "restore": "pending", "check": "approved",
                      "uncheck": "pending"}
        if body.action not in status_for:
            return err(400, f"action must be one of {sorted(status_for)}")
        if body.step_id not in {s["id"] for s in store.get_steps(task_id)}:
            return err(404, "step not found in task", step_id=body.step_id)
        store.add_decision(task_id, body.step_id, body.action, body.source,
                           scores_snapshot(task_id, body.step_id))
        store.set_step_status(body.step_id, status_for[body.action])
        return {"ok": True}

    # ------------------------------------------------------------ run

    @app.post("/task/{task_id}/run")
    async def run(task_id: str, body: RunBody):
        task = store.get_task(task_id)
        if task is None:
            return err(404, "task not found", task_id=task_id)
        if task_id in st.active_runs:
            return err(409, "a run is already in progress for this task",
                       run_id=st.active_runs[task_id].run_id or None)
        lock = st.plan_locks.get(task_id)
        if lock is not None and lock.locked():
            return err(409, "a plan is being generated for this task")
        # Reserve the slot BEFORE any await. Without this two concurrent /run calls both
        # pass the check above while the live preflight yields, the second overwrites
        # the first, and /stop can only reach one of them.
        active = ActiveRun(run_id="", stop=asyncio.Event())
        st.active_runs[task_id] = active
        try:
            return await _start_run(task_id, task, body, active)
        finally:
            if active.task is None and st.active_runs.get(task_id) is active:
                del st.active_runs[task_id]

    async def _start_run(task_id: str, task: dict, body: RunBody, active: ActiveRun):
        if settings.exec_mode == "live":
            # Preflight first: a 503 must leave no trace (no boundary writes, no run row).
            cua_ok, cua_word, cua_detail = await cua_driver_status(force=True)
            if not cua_ok:
                return err(503, f"live executor unavailable: cua-driver {cua_word}. Nothing ran. "
                                "Grant CuaDriver Accessibility and Screen Recording, or start "
                                "the daemon with --exec simulated.", detail=cua_detail)

        # From here to create_task below there is no await: the stored plan, removals and
        # boundaries cannot change under the classification.
        steps = store.get_steps(task_id)
        if not steps:
            return err(409, "task has no plan yet")
        ids = {s["id"] for s in steps}
        unknown = (set(body.checked_step_ids) | set(body.removed_step_ids)
                   | set(body.approved_step_ids)) - ids
        if unknown:
            return err(400, "unknown step ids", unknown=sorted(unknown))

        # The daemon owns removals. A step whose stored status is `removed` (latest
        # decision was remove, or an earlier run excluded it) stays removed until a
        # POST /decision restore, whatever a stale client sends.
        stored_removed = {s["id"] for s in steps if s["status"] == "removed"}
        missing = sorted(stored_removed - set(body.removed_step_ids))
        if missing:
            return err(409, "steps removed by an earlier decision are missing from "
                            "removed_step_ids (POST /decision restore to bring one back)",
                       removed=missing)
        removed_ids = stored_removed | set(body.removed_step_ids)

        if body.boundaries is not None:
            for b in body.boundaries:
                problem = _validate_boundary(b)
                if problem:
                    return err(400, problem)
            boundaries = [{"x_dim": b.x_dim, "y_dim": b.y_dim, "polygon": b.polygon}
                          for b in body.boundaries if len(b.polygon) >= 3]
        else:
            boundaries = [{"x_dim": b["x_dim"], "y_dim": b["y_dim"], "polygon": b["polygon"]}
                          for b in store.get_boundaries(task_id)]

        positions = store.positions_by_step(task_id)
        statuses = approval.classify([s["id"] for s in steps], positions,
                                     body.checked_step_ids, removed_ids, boundaries)
        expected = sorted(approval.approved_set(statuses))
        got = sorted(set(body.approved_step_ids))
        pending = sorted(sid for sid, s in statuses.items() if s == "pending")
        if expected != got or pending:
            return err(409, "approved set does not match the boundary and checkboxes"
                       if expected != got else "some steps are still pending",
                       expected=expected, got=got, pending=pending)

        # Persist the boundary state the approval was computed from.
        if body.boundaries is not None:
            keep = {(b["x_dim"], b["y_dim"]) for b in boundaries}
            for old in store.get_boundaries(task_id):
                if (old["x_dim"], old["y_dim"]) not in keep:
                    store.put_boundary(task_id, old["x_dim"], old["y_dim"], [])
            for b in boundaries:
                store.put_boundary(task_id, b["x_dim"], b["y_dim"], b["polygon"])

        removed_steps = [s for s in steps if statuses[s["id"]] == "removed"]
        approved_steps = [s for s in steps if statuses[s["id"]] == "approved"]
        approved_ids = frozenset(s["id"] for s in approved_steps)
        run_id = store.create_run(task_id, settings.exec_mode, sorted(approved_ids),
                                  [s["id"] for s in removed_steps], boundaries)
        active.run_id = run_id

        checked = set(body.checked_step_ids)
        for s in steps:
            snap = scores_snapshot(task_id, s["id"])
            if statuses[s["id"]] == "removed":
                store.add_decision(task_id, s["id"], "remove", "run", snap, run_id)
            else:
                inside = approval.inside_any(positions.get(s["id"], {}), boundaries)
                src = ("check+polygon" if inside and s["id"] in checked
                       else "check" if s["id"] in checked else "polygon")
                store.add_decision(task_id, s["id"], "approve", src, snap, run_id)
            store.set_step_status(s["id"], statuses[s["id"]])

        exec_steps = [executor.ExecStep(id=s["id"], index=s["index"], title=s["title"],
                                        description=s["description"],
                                        app_name=(s.get("app") or {}).get("name"),
                                        app_bundle=(s.get("app") or {}).get("bundle_id"))
                      for s in approved_steps]
        # Defence in depth: the executor asserts this too.
        assert all(e.id in approved_ids for e in exec_steps)

        config = executor.ExecConfig(
            mode=settings.exec_mode, provider=settings.provider,
            # The executor has its own default (claude-opus-5-5); OVERSIGHT_EXEC_MODEL overrides.
            model=os.environ.get("OVERSIGHT_EXEC_MODEL") or executor.DEFAULT_MODEL)
        active.task = asyncio.create_task(
            _drive(task_id, active, task["prompt"], exec_steps, approved_ids, config,
                   removed_steps, len(steps)))
        return {"run_id": run_id}

    async def _drive(task_id: str, active: ActiveRun, prompt: str, exec_steps: list,
                     approved_ids: frozenset[str], config: Any, removed_steps: list[dict],
                     step_count: int) -> None:
        from . import recap
        from .routes.frames import save_frame_jpeg

        run_id, stop = active.run_id, active.stop
        saw_final: dict | None = None
        frame_n = 0
        results: dict[str, dict] = {}
        removed_ids = {s["id"] for s in removed_steps}
        recap_steps = [{"id": s["id"], "index": s["index"], "title": s["title"],
                        "removed": s["id"] in removed_ids} for s in store.get_steps(task_id)]

        async def finalize(final: dict, *, use_llm: bool) -> None:
            """run_recap, then final_result, exactly once: the chat always ends in a summary."""
            nonlocal saw_final
            if saw_final is not None:
                return
            saw_final = final
            rc: dict
            try:
                if use_llm and st.llm is not None:
                    async def on_call(rec: CallRecord) -> None:
                        await record_call(task_id, run_id, rec)

                    rc = await recap.build_recap(st.llm, prompt, recap_steps, results, final, on_call)
                else:
                    rc = recap.build_fallback_recap(recap_steps, results, final)
            except asyncio.CancelledError:
                # Cancelled during the recap call: still end the stream, then propagate.
                await bus.emit(task_id, run_id, "run_recap",
                               recap.build_fallback_recap(recap_steps, results, final))
                await bus.emit(task_id, run_id, "final_result", final)
                raise
            except Exception:  # never let the recap block the final result
                log.exception("recap failed")
                rc = recap.build_fallback_recap(recap_steps, results, final)
            await bus.emit(task_id, run_id, "run_recap", rc)
            await bus.emit(task_id, run_id, "final_result", final)

        async def emit(kind: str, payload: dict) -> None:
            nonlocal frame_n
            if kind == "frame":
                png = payload.get("png")
                if not isinstance(png, (bytes, bytearray)) or not png:
                    return
                frame_n += 1
                dest = settings.data_dir / "frames" / task_id / f"{run_id}_{frame_n}.jpg"
                try:
                    await asyncio.to_thread(save_frame_jpeg, bytes(png), dest)
                except Exception:
                    log.warning("dropping an undecodable frame for task %s", task_id, exc_info=True)
                    return
                step_id = str(payload.get("step_id", ""))
                seq = store.add_frame(task_id, run_id, step_id, str(dest))
                payload = {"step_id": step_id, "seq": seq}
            if kind == "cost":
                rec = CallRecord(
                    scope=payload.get("scope", "run"), provider=config.provider,
                    model=str(payload.get("model", config.model)),
                    input_tokens=int(payload.get("input_tokens", 0) or 0),
                    output_tokens=int(payload.get("output_tokens", 0) or 0),
                    usd=float(payload.get("usd_delta", 0.0) or 0.0),
                    latency_ms=int(payload.get("latency_ms", 0) or 0))
                store.add_llm_call(task_id, run_id, rec)
                st.session_cost = round(st.session_cost + rec.usd, 6)
                payload = {**payload, "scope": rec.scope, "usd_total": store.task_cost(task_id)}
            if kind == "step_result":
                results[str(payload.get("step_id"))] = payload
            if kind == "final_result":
                await finalize(payload, use_llm=True)
                return
            await bus.emit(task_id, run_id, kind, payload)

        try:
            await bus.emit(task_id, run_id, "consideration_scored", {
                "step_count": step_count, "dimension_count": len(DIMENSION_KEYS),
                "approved_count": len(exec_steps)})
            for s in removed_steps:
                await bus.emit(task_id, run_id, "step_removed",
                               {"step_id": s["id"], "index": s["index"], "title": s["title"]})
            result = await executor.run_steps(prompt, exec_steps, approved_ids, emit, stop,
                                              config)
            if saw_final is None:
                result = result or {}
                await finalize({"status": result.get("status", "completed"),
                                "message": result.get("message", "All approved steps were attempted."),
                                "attempted": result.get("attempted", []),
                                "completed": result.get("completed", [])}, use_llm=True)
        except executor.UnapprovedStepError as e:
            await finalize({"status": "failed", "message": f"Refused: {e}", "attempted": [],
                            "completed": []}, use_llm=False)
        except asyncio.CancelledError:
            await finalize({"status": "stopped", "message": "Run cancelled.", "attempted": [],
                            "completed": []}, use_llm=False)
            raise
        except Exception as e:
            log.exception("executor failed")
            await finalize({"status": "failed",
                            "message": f"Executor error: {type(e).__name__}: {e}",
                            "attempted": [], "completed": []}, use_llm=False)
        finally:
            store.finish_run(run_id, (saw_final or {}).get("status", "failed"), saw_final or {})
            # Only release our own slot: a later run's entry must stay stoppable.
            if st.active_runs.get(task_id) is active:
                del st.active_runs[task_id]

    @app.post("/task/{task_id}/stop")
    async def stop_run(task_id: str):
        if store.get_task(task_id) is None:
            return err(404, "task not found", task_id=task_id)
        active = st.active_runs.get(task_id)
        if active is None:
            return {"stopped": False, "message": "no run in progress"}
        active.stop.set()  # also reaches a run still in preflight: it starts already stopped
        return {"stopped": True, "run_id": active.run_id or None}

    # ------------------------------------------------------------ events (SSE)

    @app.get("/task/{task_id}/events")
    async def events(task_id: str, request: Request, since: int = 0):
        if store.get_task(task_id) is None:
            return err(404, "task not found", task_id=task_id)
        last_id = request.headers.get("last-event-id")
        if last_id and last_id.isdigit():
            since = max(since, int(last_id))

        async def gen():
            q = bus.subscribe(task_id)
            try:
                last = since
                for ev in store.get_events(task_id, since):
                    last = ev["seq"]
                    yield {"event": ev["kind"], "id": str(ev["seq"]), "data": json.dumps(ev)}
                while True:
                    ev = await q.get()
                    if ev["seq"] <= last:
                        continue
                    last = ev["seq"]
                    yield {"event": ev["kind"], "id": str(ev["seq"]), "data": json.dumps(ev)}
            finally:
                bus.unsubscribe(task_id, q)

        return EventSourceResponse(gen(), ping=15)

    ctx = Ctx(st=st, record_call=record_call, progress=progress,
              scores_snapshot=scores_snapshot, score_steps=score_steps,
              load_images=load_images)
    app.state.ctx = ctx
    for mod in (setup_routes, attachments_routes, revise_routes, frames_routes):
        mod.register(app, ctx)

    return app


__all__ = ["create_app", "content_hash"]
