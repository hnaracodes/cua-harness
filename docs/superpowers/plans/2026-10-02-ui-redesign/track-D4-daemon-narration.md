# Track D4: Daemon run narration (actions/duration, frames, recap)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8) and Ownership matrix first. Spec sections: "Daemon API changes §3 Run narration" and "Screens §3 Running". Runs in Wave 1 Batch A, in worktree `.worktrees/rd-D4` on branch `rd/D4`.

**Owns (modify/create only these):** `daemon/oversight/executor.py`, `daemon/oversight/recap.py` (new), `daemon/oversight/routes/frames.py`, `daemon/oversight/api.py` **only the bodies of `_drive` and `_start_run`**, `daemon/tests/test_narration.py` (new).

**Never touch:** `assert_step_approved`, `assert_all_approved`, `_dispatch_step`'s first statement, or the per-step `assert_step_approved(step, approved_ids)` inside `run_steps`. Every change below sits *after* those checks.

Setup:

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
git worktree add ".worktrees/rd-D4" -b "rd/D4" ui-redesign
cd ".worktrees/rd-D4/daemon" && uv sync
```

All commands below run from `.worktrees/rd-D4/daemon`.

---

### Task D4-1: `step_result` carries `actions` and `duration_ms`

**Files:**
- Modify: `daemon/oversight/executor.py` (`run_steps` loop and the "Approved steps that never ran" loop)
- Test: `daemon/tests/test_narration.py` (create)

**Interfaces:**
- Consumes: `executor.run_steps(task_prompt, steps, approved_ids, emit, stop, config, *, driver=None, llm=None, desk=None)`, `RunState.actions_used`.
- Produces: every `step_result` payload = `{step_id, index, status, summary, actions: int, duration_ms: int}` (C3 "step_result gains actions: int and duration_ms: int"; C1 `StepResultPayload.actions?`/`duration_ms?`). Skipped (never-run) results carry `actions: 0, duration_ms: 0`.

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_narration.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_narration.py -q`
Expected: FAIL with `KeyError: 'actions'` in both tests.

- [ ] **Step 3: Implement**

In `daemon/oversight/executor.py`, inside `run_steps`, replace this block:

```python
        rs.attempted.append(step.id)
        await emit("step_started", {"step_id": step.id, "index": step.index, "title": step.title})
        try:
            outcome = await _dispatch_step(rs, step, approved_ids, runner)
        except UnapprovedStepError:
            raise
        except Exception as e:  # driver/model failure: fail this step, stop the run
            outcome = StepOutcome("failed", f"{type(e).__name__}: {e}")
        await emit("step_result", {"step_id": step.id, "index": step.index, "status": outcome.status,
                                   "summary": outcome.summary})
```

with:

```python
        rs.attempted.append(step.id)
        await emit("step_started", {"step_id": step.id, "index": step.index, "title": step.title})
        actions_before, t_step = rs.actions_used, time.monotonic()
        try:
            outcome = await _dispatch_step(rs, step, approved_ids, runner)
        except UnapprovedStepError:
            raise
        except Exception as e:  # driver/model failure: fail this step, stop the run
            outcome = StepOutcome("failed", f"{type(e).__name__}: {e}")
        await emit("step_result", {"step_id": step.id, "index": step.index, "status": outcome.status,
                                   "summary": outcome.summary,
                                   "actions": rs.actions_used - actions_before,
                                   "duration_ms": int((time.monotonic() - t_step) * 1000)})
```

And in the "Approved steps that never ran." loop, replace:

```python
            await emit("step_result", {"step_id": s.id, "index": s.index, "status": "skipped",
                                       "summary": "Not run: the run ended early."})
```

with:

```python
            await emit("step_result", {"step_id": s.id, "index": s.index, "status": "skipped",
                                       "summary": "Not run: the run ended early.",
                                       "actions": 0, "duration_ms": 0})
```

(`time` is already imported in `executor.py`; `LiveRunner.run_step` uses `time.monotonic()`.)

- [ ] **Step 4: Run to verify pass, plus the existing executor suite**

Run: `uv run pytest tests/test_narration.py tests/test_executor.py -q`
Expected: all pass (the exact-sequence test `test_simulated_mode_event_sequence` is unaffected: no new event kinds in simulated mode).

- [ ] **Step 5: Commit**

```bash
git add oversight/executor.py tests/test_narration.py
git commit -m "executor: step_result carries actions and duration_ms" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task D4-2: Frames (live executor → JPEG on disk → `frame` event → `GET /frames`)

**Files:**
- Modify: `daemon/oversight/executor.py` (`LiveRunner.run_step`, right after the Turn is appended)
- Modify: `daemon/oversight/routes/frames.py` (replace the Wave 0 stub)
- Modify: `daemon/oversight/api.py` (`_drive` body only)
- Test: `daemon/tests/test_narration.py`

**Interfaces:**
- Consumes: `Ctx.st.store.add_frame(task_id, run_id, step_id, path) -> int`, `get_frame(task_id, seq) -> dict | None` (C4), `settings.data_dir`.
- Produces: internal executor event `("frame", {"step_id": str, "png": bytes})` (live mode only; never stored, never sent); public SSE event `frame` with `FramePayload` `{step_id, seq}` (C1/C3); `GET /task/{id}/frames/{seq}.jpg` → `image/jpeg` or 404 (C3); `routes.frames.save_frame_jpeg(png: bytes, dest: Path) -> None`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_narration.py`:

```python
# ------------------------------------------------------------------ frames


def test_live_runner_emits_one_frame_per_observation():
    from test_executor import FakeDesk, FakeLLM, fake_driver, tool_use  # same-dir test helpers

    driver, _ = fake_driver()
    desk = FakeDesk(driver)
    llm = FakeLLM(script=[[tool_use("open_url", {"url": "https://www.google.com"})],
                          [tool_use("step_done", {"summary": "Results are showing."})]])
    rec = Rec()
    st = [executor.ExecStep(id="stp_1", index=1, title="Search", description="d")]
    asyncio.run(executor.run_steps("p", st, frozenset({"stp_1"}), rec, asyncio.Event(),
                                   executor.ExecConfig(mode="live"), driver=driver, llm=llm, desk=desk))
    frames = [p for k, p in rec.events if k == "frame"]
    assert len(frames) == 2  # two observations: before open_url, before step_done
    assert all(f["step_id"] == "stp_1" and f["png"].startswith(b"\x89PNG") for f in frames)
    (result,) = [p for k, p in rec.events if k == "step_result"]
    assert result["actions"] == 1


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _png(w: int = 2000, h: int = 1000) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (30, 60, 90)).save(buf, "PNG")
    return buf.getvalue()


def _start(client, approve_idx: tuple[int, ...] = (1, 4)) -> tuple[str, list[dict]]:
    """Plan the fixture task, approve `approve_idx` by checkbox, remove the rest, run."""
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    steps = client.post(f"/task/{tid}/plan").json()["steps"]
    keep = [s["id"] for s in steps if s["index"] in approve_idx]
    drop = [s["id"] for s in steps if s["index"] not in approve_idx]
    r = client.post(f"/task/{tid}/run", json={"approved_step_ids": keep, "checked_step_ids": keep,
                                              "removed_step_ids": drop, "boundaries": []})
    assert r.status_code == 200, r.text
    return tid, steps


def _wait(client, tid: str) -> dict:
    for _ in range(300):
        runs = client.get(f"/task/{tid}").json()["runs"]
        if runs and runs[-1]["status"] != "running":
            return runs[-1]
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def _fake_run(events: list[tuple[str, Any]]):
    """A stand-in for executor.run_steps that replays `events` for the first step."""

    async def fake_run_steps(prompt, steps, approved_ids, emit, stop, config, **kw):
        s = steps[0]
        for kind, payload in events:
            p = payload(s) if callable(payload) else payload
            await emit(kind, p)
        return {"status": "completed"}

    return fake_run_steps


def _one_step_events(frame_png: bytes):
    return [
        ("step_started", lambda s: {"step_id": s.id, "index": s.index, "title": s.title}),
        ("frame", lambda s: {"step_id": s.id, "png": frame_png}),
        ("step_result", lambda s: {"step_id": s.id, "index": s.index, "status": "done",
                                   "summary": "ok", "actions": 1, "duration_ms": 5}),
        ("final_result", lambda s: {"status": "completed", "message": "All approved steps were attempted.",
                                    "attempted": [s.id], "completed": [s.id]}),
    ]


def test_frame_is_saved_as_jpeg_and_served(client, monkeypatch):
    monkeypatch.setattr(executor, "run_steps", _fake_run(_one_step_events(_png())))
    tid, steps = _start(client, (1,))
    _wait(client, tid)
    evs = client.app.state.oversight.store.get_events(tid)
    (fr,) = [e for e in evs if e["kind"] == "frame"]
    assert fr["payload"] == {"step_id": steps[0]["id"], "seq": 1}  # no bytes, ever
    r = client.get(f"/task/{tid}/frames/1.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    im = Image.open(io.BytesIO(r.content))
    assert im.format == "JPEG" and (im.width, im.height) == (1600, 800)


def test_frame_404s(client):
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    assert client.get(f"/task/{tid}/frames/1.jpg").status_code == 404
    assert client.get("/task/tsk_nope/frames/1.jpg").status_code == 404


def test_undecodable_frame_is_dropped_and_run_finishes(client, monkeypatch):
    monkeypatch.setattr(executor, "run_steps", _fake_run(_one_step_events(b"not a png")))
    tid, _ = _start(client, (1,))
    assert _wait(client, tid)["status"] == "completed"
    kinds = [e["kind"] for e in client.app.state.oversight.store.get_events(tid)]
    assert "frame" not in kinds
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_narration.py -q -k "frame"`
Expected: FAIL. `test_live_runner_emits_one_frame_per_observation` fails with `assert 0 == 2`; `test_frame_is_saved_as_jpeg_and_served` fails because the `frame` event payload still contains `png` bytes (and the route 404s/405s).

- [ ] **Step 3: Emit frames from the live runner**

In `daemon/oversight/executor.py`, `LiveRunner.run_step`, replace:

```python
            self.seq += 1
            turn = Turn(step_index=step.index, seq=self.seq, png=ws.png)
            rs.turns.append(turn)
```

with:

```python
            self.seq += 1
            turn = Turn(step_index=step.index, seq=self.seq, png=ws.png)
            rs.turns.append(turn)
            if ws.png:
                # The exact window-scoped capture the model is about to see. The daemon
                # converts it to JPEG for the desk view; the bytes never enter the event log.
                await rs.emit("frame", {"step_id": step.id, "png": ws.png})
```

- [ ] **Step 4: Implement `routes/frames.py`**

Replace the entire content of `daemon/oversight/routes/frames.py` with:

```python
"""Agent desk frames (track D4): the window-scoped capture the model saw, as JPEG."""

from __future__ import annotations

import io
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from .ctx import Ctx

MAX_FRAME_WIDTH = 1600
JPEG_QUALITY = 80


def save_frame_jpeg(png: bytes, dest: Path) -> None:
    """Decode `png`, downscale to MAX_FRAME_WIDTH keeping aspect, write JPEG to `dest`.
    Raises on undecodable input (the caller drops that frame)."""
    from PIL import Image

    with Image.open(io.BytesIO(png)) as im:
        im.load()
        rgb = im.convert("RGB")
    if rgb.width > MAX_FRAME_WIDTH:
        h = max(1, round(rgb.height * MAX_FRAME_WIDTH / rgb.width))
        rgb = rgb.resize((MAX_FRAME_WIDTH, h))
    dest.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(dest, "JPEG", quality=JPEG_QUALITY)


def register(app: FastAPI, ctx: Ctx) -> None:
    store = ctx.st.store

    @app.get("/task/{task_id}/frames/{seq}.jpg")
    async def get_frame(task_id: str, seq: int):
        fr = store.get_frame(task_id, seq)
        if fr is None or not Path(fr["path"]).is_file():
            return JSONResponse({"error": "frame not found", "task_id": task_id, "seq": seq},
                                status_code=404)
        return FileResponse(fr["path"], media_type="image/jpeg")
```

- [ ] **Step 5: Intercept `frame` in `_drive`**

In `daemon/oversight/api.py`, inside `_drive`, replace:

```python
        run_id, stop = active.run_id, active.stop
        saw_final: dict | None = None

        async def emit(kind: str, payload: dict) -> None:
            nonlocal saw_final
            if kind == "cost":
```

with:

```python
        from .routes.frames import save_frame_jpeg

        run_id, stop = active.run_id, active.stop
        saw_final: dict | None = None
        frame_n = 0

        async def emit(kind: str, payload: dict) -> None:
            nonlocal saw_final, frame_n
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
```

(The rest of `emit` is unchanged in this task; the `if kind == "cost":` branch keeps its body, and the final `await bus.emit(task_id, run_id, kind, payload)` now sends the public frame payload.)

- [ ] **Step 6: Run to verify pass**

Run: `uv run pytest tests/test_narration.py tests/test_executor.py tests/test_api.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add oversight/executor.py oversight/routes/frames.py oversight/api.py tests/test_narration.py
git commit -m "daemon: desk frames (window capture -> JPEG, frame event, GET frames)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task D4-3: `recap.py` (structured recap + deterministic fallback)

**Files:**
- Create: `daemon/oversight/recap.py`
- Test: `daemon/tests/test_narration.py`

**Interfaces:**
- Consumes: `StructuredLLM.call(*, scope, system, user, schema, schema_name, effort, max_tokens, images=())` and `CallRecord`, `LLMError(message, record)` from `oversight/llm.py`.
- Produces (used by D4-4):
  - `RECAP_SCHEMA: dict`
  - `RecapStep = dict` with keys `id: str, index: int, title: str, removed: bool`
  - `build_fallback_recap(steps: list[RecapStep], results: Mapping[str, dict], final: Mapping) -> dict` → `RunRecapPayload` with `source: "fallback"` (C1)
  - `async build_recap(llm, prompt: str, steps: list[RecapStep], results: Mapping[str, dict], final: Mapping, on_call: Callable[[CallRecord], Awaitable[None]] | None = None) -> dict` → `RunRecapPayload` with `source: "llm"`, or the fallback on any failure
  - `results` maps `step_id → step_result payload`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_narration.py`:

```python
# ------------------------------------------------------------------ recap module

from oversight import recap  # noqa: E402
from oversight.llm import CallRecord, LLMError  # noqa: E402

RSTEPS = [{"id": "a", "index": 1, "title": "Search rackets", "removed": False},
          {"id": "b", "index": 2, "title": "Add to cart", "removed": True},
          {"id": "c", "index": 3, "title": "Draft message", "removed": False},
          {"id": "d", "index": 4, "title": "Send message", "removed": False}]
RRESULTS = {"a": {"status": "done", "summary": "Found 4 rackets under $100."},
            "c": {"status": "failed", "summary": "WhatsApp did not load."}}
RFINAL = {"status": "failed", "message": "A step failed, so the remaining steps were not run.",
          "attempted": ["a", "c"], "completed": ["a"]}


class FakeLLM:
    def __init__(self, data: dict | None = None, exc: Exception | None = None) -> None:
        self.data, self.exc, self.calls = data, exc, []

    async def call(self, **kw):
        self.calls.append(kw)
        if self.exc:
            raise self.exc
        return self.data, CallRecord(scope=kw["scope"], provider="fake", model="m", usd=0.001)


def test_fallback_recap_is_deterministic_and_complete():
    r = recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL)
    assert r == {
        "headline": "Stopped early: a step failed after 1 step(s) completed.",
        "done": [{"step_id": "a", "text": "Found 4 rackets under $100."}],
        "skipped": [{"step_id": "b", "reason": "Removed before the run."},
                    {"step_id": "c", "reason": "Failed: WhatsApp did not load."},
                    {"step_id": "d", "reason": "Not run: the run ended early."}],
        "source": "fallback",
    }
    assert recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL) == r


@pytest.mark.parametrize("status,headline", [
    ("completed", "Done: 1 step(s) completed. 1 skipped as you asked."),
    ("stopped", "Stopped by you after 1 step(s)."),
    ("capped", "Stopped at the action limit after 1 step(s)."),
])
def test_fallback_headlines(status, headline):
    assert recap.build_fallback_recap(RSTEPS, RRESULTS, {**RFINAL, "status": status})["headline"] == headline


GOOD = {"headline": "Found rackets; the message didn't go out.",
        "done": [{"step_id": "a", "text": "Found 4 rackets under $100 on Google Shopping."}],
        "skipped": [{"step_id": "b", "reason": "You removed it."},
                    {"step_id": "c", "reason": "WhatsApp did not load."},
                    {"step_id": "d", "reason": "Not reached."}]}


def test_build_recap_llm_success_records_cost():
    llm, calls = FakeLLM(GOOD), []

    async def on_call(rec):
        calls.append(rec)

    r = asyncio.run(recap.build_recap(llm, "task", RSTEPS, RRESULTS, RFINAL, on_call))
    assert r == {**GOOD, "source": "llm"}
    assert llm.calls[0]["scope"] == "recap" and llm.calls[0]["effort"] == "low"
    assert llm.calls[0]["schema"] == recap.RECAP_SCHEMA
    assert len(calls) == 1 and calls[0].scope == "recap"


def test_build_recap_falls_back_on_llm_error_and_still_records_cost():
    calls = []

    async def on_call(rec):
        calls.append(rec)

    err = LLMError("refused", CallRecord(scope="recap", provider="fake", model="m"))
    r = asyncio.run(recap.build_recap(FakeLLM(exc=err), "task", RSTEPS, RRESULTS, RFINAL, on_call))
    assert r == recap.build_fallback_recap(RSTEPS, RRESULTS, RFINAL)
    assert len(calls) == 1


@pytest.mark.parametrize("bad", [
    {**GOOD, "done": [{"step_id": "zzz", "text": "invented"}]},       # unknown step
    {**GOOD, "done": [{"step_id": "c", "text": "claims the failed step"}]},  # not actually done
    {**GOOD, "headline": "   "},                                       # empty headline
])
def test_build_recap_rejects_unfaithful_output(bad):
    r = asyncio.run(recap.build_recap(FakeLLM(bad), "task", RSTEPS, RRESULTS, RFINAL))
    assert r["source"] == "fallback"


def test_build_recap_falls_back_on_unexpected_exception():
    r = asyncio.run(recap.build_recap(FakeLLM(exc=RuntimeError("socket closed")), "task",
                                      RSTEPS, RRESULTS, RFINAL))
    assert r["source"] == "fallback"
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_narration.py -q -k recap`
Expected: FAIL with `ImportError: cannot import name 'recap' from 'oversight'`.

- [ ] **Step 3: Implement `daemon/oversight/recap.py`**

```python
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
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/test_narration.py -q -k recap`
Expected: all recap tests pass.

- [ ] **Step 5: Commit**

```bash
git add oversight/recap.py tests/test_narration.py
git commit -m "daemon: structured run recap with faithful-or-fallback rule" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task D4-4: `run_recap` always precedes `final_result` (every `_drive` path)

**Files:**
- Modify: `daemon/oversight/api.py` (`_drive` body only)
- Test: `daemon/tests/test_narration.py`

**Interfaces:**
- Consumes: `recap.build_recap`, `recap.build_fallback_recap` (D4-3); `record_call(task_id, run_id, rec)` and `st.llm` from `create_app`'s scope; `store.get_steps(task_id)`.
- Produces: per run, exactly one `run_recap` event (`RunRecapPayload`, C1) emitted immediately before the single `final_result` — on normal completion, stop, executor crash, `UnapprovedStepError`, and cancellation. Recap LLM cost is recorded through `record_call` with `scope="recap"` (shows in `llm_calls` and as a `cost` event). Cancel/crash/refusal paths use the fallback (no model call).

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_narration.py`:

```python
# ------------------------------------------------------------------ recap in _drive


def _run_kinds(client, tid):
    return [e for e in client.app.state.oversight.store.get_events(tid) if e["run_id"]]


def test_run_emits_one_recap_right_before_final(client):
    tid, steps = _start(client, (1, 4))
    assert _wait(client, tid)["status"] == "completed"
    evs = _run_kinds(client, tid)
    kinds = [e["kind"] for e in evs]
    assert kinds.count("run_recap") == 1 and kinds.count("final_result") == 1
    assert kinds[-2:] == ["run_recap", "final_result"]
    rc = evs[-2]["payload"]
    assert rc["source"] == "fallback"  # fixtures mode: no model
    assert [d["step_id"] for d in rc["done"]] == [steps[0]["id"], steps[3]["id"]]
    assert [s["step_id"] for s in rc["skipped"]] == [steps[i]["id"] for i in (1, 2, 4, 5)]
    assert all(s["reason"] == "Removed before the run." for s in rc["skipped"])
    results = [e["payload"] for e in evs if e["kind"] == "step_result"]
    assert all(r["actions"] > 0 and r["duration_ms"] >= 0 for r in results)


def test_stop_mid_run_still_recaps_then_final(client):
    tid, _ = _start(client, (1, 4))
    client.post(f"/task/{tid}/stop")
    assert _wait(client, tid)["status"] == "stopped"
    kinds = [e["kind"] for e in _run_kinds(client, tid)]
    assert kinds[-2:] == ["run_recap", "final_result"] and kinds.count("run_recap") == 1


def test_executor_crash_still_recaps(client, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(executor, "run_steps", boom)
    tid, _ = _start(client, (1,))
    assert _wait(client, tid)["status"] == "failed"
    evs = _run_kinds(client, tid)
    assert [e["kind"] for e in evs][-2:] == ["run_recap", "final_result"]
    assert evs[-2]["payload"]["source"] == "fallback"


def test_recap_uses_the_model_when_present_and_records_cost(client):
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    steps = client.post(f"/task/{tid}/plan").json()["steps"]
    first = steps[0]["id"]
    good = {"headline": "Found rackets.", "done": [{"step_id": first, "text": "Searched."}],
            "skipped": [{"step_id": s["id"], "reason": "You removed it."} for s in steps[1:]]}
    client.app.state.oversight.llm = FakeLLM(good)  # swap in after planning (plan is replayed)
    r = client.post(f"/task/{tid}/run", json={"approved_step_ids": [first], "checked_step_ids": [first],
                                              "removed_step_ids": [s["id"] for s in steps[1:]],
                                              "boundaries": []})
    assert r.status_code == 200, r.text
    _wait(client, tid)
    evs = _run_kinds(client, tid)
    rc = [e for e in evs if e["kind"] == "run_recap"][0]["payload"]
    assert rc == {**good, "source": "llm"}
    calls = client.get(f"/task/{tid}").json()["llm_calls"]
    assert any(c["scope"] == "recap" for c in calls)
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_narration.py -q -k "recap and (run or stop or crash or model)"`
Expected: FAIL — `assert 0 == 1` on `kinds.count("run_recap")` (no recap emitted yet).

- [ ] **Step 3: Implement**

In `daemon/oversight/api.py`, `_drive`, change the import line added in D4-2 to:

```python
        from . import recap
        from .routes.frames import save_frame_jpeg
```

Directly after `frame_n = 0`, add:

```python
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
            except Exception:  # never let the recap block the final result
                log.exception("recap failed")
                rc = recap.build_fallback_recap(recap_steps, results, final)
            await bus.emit(task_id, run_id, "run_recap", rc)
            await bus.emit(task_id, run_id, "final_result", final)
```

In `emit`, remove `saw_final` from its `nonlocal` line (it becomes `nonlocal frame_n`), and replace its tail:

```python
            if kind == "final_result":
                saw_final = payload
            await bus.emit(task_id, run_id, kind, payload)
```

with:

```python
            if kind == "step_result":
                results[str(payload.get("step_id"))] = payload
            if kind == "final_result":
                await finalize(payload, use_llm=True)
                return
            await bus.emit(task_id, run_id, kind, payload)
```

Replace the `try/except` body (keep the `finally:` block exactly as it is) with:

```python
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
```

(`saw_final` is set inside `finalize`, so the unchanged `finally:` still reads it for `store.finish_run`.)

- [ ] **Step 4: Run to verify pass, then the whole daemon suite**

Run: `uv run pytest tests/test_narration.py -q && uv run pytest -q`
Expected: all pass; existing `test_api.py::test_run_flow_and_409` still sees `evs[-1]["kind"] == "final_result"` with the same message.

- [ ] **Step 5: Commit**

```bash
git add oversight/api.py tests/test_narration.py
git commit -m "daemon: run_recap before final_result on every run path" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Track exit check

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev/.worktrees/rd-D4/daemon" && uv run pytest -q
git diff --name-only ui-redesign...HEAD
```

Expected: suite green; diff lists only `daemon/oversight/executor.py`, `daemon/oversight/recap.py`, `daemon/oversight/routes/frames.py`, `daemon/oversight/api.py`, `daemon/tests/test_narration.py`. In `api.py`, `git diff ui-redesign...HEAD -- daemon/oversight/api.py` touches only lines inside `_drive`.

Spec gate 3 (daemon half): a simulated run's event stream reads `step_started → action* → step_result{actions,duration_ms}` per step and ends `run_recap → final_result`.

## Contract notes

- Frame files are named `<run_id>_<n>.jpg`, not `<seq>.jpg`: `seq` comes from `store.add_frame` after the file is written. The public URL `/task/{id}/frames/{seq}.jpg` (C3) is unchanged.
- Recap LLM cost is recorded with `scope="recap"`; C1 `CostPayload.scope` is typed `"plan" | "score" | "run"` — U2/U5 must tolerate `"recap"` (orchestrator may widen the type).
- Cancel, crash and `UnapprovedStepError` paths always use the fallback recap (no model call inside a cancelled task).
- `executor.run_steps` now emits an internal `("frame", {"step_id", "png": bytes})` in live mode; any other caller of `run_steps` (e.g. the `testing/` harness) receives raw bytes it must ignore or not JSON-serialize.
- `recap` and `save_frame_jpeg` are imported inside `_drive` so `api.py` edits stay within the owned function.
