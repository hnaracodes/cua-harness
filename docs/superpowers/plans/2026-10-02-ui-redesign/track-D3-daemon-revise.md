# Track D3: Daemon re-propose and step edit

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8) and Ownership matrix first. Spec: "Daemon API changes §2 Revise and edit". docs/01 step 6 describes the original re-propose design. Wave 1, Batch A. Starts from `ui-redesign` after Wave 0 is merged.

**Owns (and only these):** `daemon/oversight/replanner.py` (new), `daemon/oversight/routes/revise.py`, `daemon/tests/test_revise.py`.

Worktree:

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
git worktree add ".worktrees/rd-D3" -b "rd/D3" ui-redesign
cd ".worktrees/rd-D3/daemon" && uv sync
```

All commands below run from `.worktrees/rd-D3/daemon`.

**Rules this track enforces:**
- A step the user removed stays removed. The planner keeps it in the list, with the same id and status, so the UI can still show it struck through. It returns to pending only when the instruction asks for it back and the planner rewrites it.
- Unchanged steps keep their id, status, scores, `edited_from` and `revision`. This means a polygon drawn on any axis pair keeps meaning the same thing.
- Changed and new steps are pending and get rescored. Nothing is approved implicitly. A changed step can still fall inside an existing polygon, in which case the existing approval rule approves it exactly like any other step.
- Every changed, added, or dropped step records a decision (`action: "revise"`, `source: "chat"`). Every edit records `action: "edit"`, `source: "step_list"`. These are the training signal.

---

## Task D3-1: The replanner (pure merge, LLM call, fixture mode)

**Files:**
- Create: `daemon/oversight/replanner.py`
- Test: `daemon/tests/test_revise.py`

**Interfaces:**
- Consumes: `StructuredLLM.call(..., images=())` and `ImageInput` (C4), `planner.GLYPHS`, `MIN_STEPS`, `MAX_STEPS`, `store.new_id`, `LLMError`, and `CallRecord`.
- Produces (used by D3-2):
  - `RevisedStep(keep_step_id: str | None, title: str, description: str, glyph: str)`
  - `REVISE_SCHEMA`, `SYSTEM`
  - `validate_revision(data: dict, current_ids: set[str]) -> list[RevisedStep]`
  - `async replan(llm, prompt: str, current_steps: list[dict], instruction: str | None, images=(), on_call=None) -> list[RevisedStep]`
  - `fixture_replan(current_steps: list[dict], instruction: str | None) -> list[RevisedStep]`
  - `Merge(steps: list[dict], changed: set[str], added: set[str], dropped: set[str], unchanged: set[str])`
  - `merge_revision(task_id: str, current_steps: list[dict], revised: list[RevisedStep]) -> Merge`

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_revise.py`:

```python
import asyncio

import pytest

from oversight import fixtures
from oversight.llm import CallRecord, ImageInput, LLMError
from oversight.replanner import (
    RevisedStep,
    fixture_replan,
    merge_revision,
    replan,
    validate_revision,
)


def _steps(statuses=("pending",) * 6):
    return [{"id": f"stp_{i + 1}", "task_id": "tsk_1", "index": i + 1, "title": t,
             "description": d, "glyph": g, "status": statuses[i], "edited_from": None,
             "revision": 0} for i, (t, d, g) in enumerate(fixtures.STEPS)]


def test_fixture_replan_grammar_drop_and_add():
    cur = _steps()
    out = fixture_replan(cur, "drop 6; add Ask the party group for a date")
    assert [r.keep_step_id for r in out] == ["stp_1", "stp_2", "stp_3", "stp_4", "stp_5", None]
    assert out[-1].title == "Ask the party group for a date"
    assert [r.title for r in out[:5]] == [s["title"] for s in cur[:5]]


def test_fixture_replan_free_text_revises_last_active_step():
    cur = _steps(("pending",) * 5 + ("removed",))
    out = fixture_replan(cur, "only message the party group")
    assert out[4].keep_step_id == "stp_5"
    assert out[4].title == cur[4]["title"] + " (revised: only message the party group)"
    assert out[5].title == cur[5]["title"]  # removed step kept verbatim, stays removed


def test_fixture_replan_without_instruction_keeps_everything():
    cur = _steps()
    out = fixture_replan(cur, None)
    assert [(r.keep_step_id, r.title, r.description) for r in out] == \
        [(s["id"], s["title"], s["description"]) for s in cur]


def test_merge_revision_classifies_and_preserves():
    cur = _steps(("approved", "pending", "pending", "pending", "removed", "pending"))
    cur[1]["edited_from"] = "Old title"
    revised = [
        RevisedStep("stp_1", cur[0]["title"], cur[0]["description"], "search"),   # unchanged
        RevisedStep("stp_2", cur[1]["title"], cur[1]["description"], "compare"),  # unchanged
        RevisedStep("stp_4", "Draft a shorter message", "Keep it to two lines.", "message"),  # changed
        RevisedStep("stp_5", cur[4]["title"], cur[4]["description"], "contacts"),  # unchanged, removed
        RevisedStep(None, "Ask for a date", "Ask the group which date works.", "message"),  # new
    ]
    m = merge_revision("tsk_1", cur, revised)
    assert m.unchanged == {"stp_1", "stp_2", "stp_5"}
    assert m.changed == {"stp_4"}
    assert m.dropped == {"stp_3", "stp_6"}
    assert len(m.added) == 1
    by = {s["id"]: s for s in m.steps}
    assert [s["index"] for s in m.steps] == [1, 2, 3, 4, 5]
    assert by["stp_1"]["status"] == "approved"
    assert by["stp_5"]["status"] == "removed"
    assert by["stp_2"]["edited_from"] == "Old title"
    assert (by["stp_4"]["status"], by["stp_4"]["revision"]) == ("pending", 1)
    new = by[next(iter(m.added))]
    assert new["status"] == "pending" and new["task_id"] == "tsk_1" and new["revision"] == 0


def test_merge_revision_duplicate_or_unknown_ids_become_new_steps():
    cur = _steps()
    revised = [RevisedStep("stp_1", "A", "a", "generic"), RevisedStep("stp_1", "B", "b", "generic"),
               RevisedStep("stp_99", "C", "c", "generic")]
    m = merge_revision("tsk_1", cur, revised)
    assert m.steps[0]["id"] == "stp_1"
    assert len(m.added) == 2 and "stp_99" not in {s["id"] for s in m.steps}


def test_validate_revision_drops_unknown_keep_ids_and_bad_glyphs():
    data = {"steps": [{"keep_step_id": "stp_1", "title": "A", "description": "a", "glyph": "search"},
                      {"keep_step_id": "nope", "title": "B", "description": "b", "glyph": "rocket"},
                      {"keep_step_id": None, "title": "C", "description": "c", "glyph": "send"},
                      {"keep_step_id": None, "title": "D", "description": "d", "glyph": "send"}]}
    out = validate_revision(data, {"stp_1"})
    assert [r.keep_step_id for r in out] == ["stp_1", None, None, None]
    assert out[1].glyph == "generic"
    with pytest.raises(LLMError):
        validate_revision({"steps": data["steps"][:2]}, {"stp_1"})  # fewer than 4 steps
    with pytest.raises(LLMError):
        validate_revision({"steps": [{"keep_step_id": None, "title": "", "description": "x",
                                      "glyph": "send"}] * 4}, set())


class _FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    async def call(self, **kw):
        self.calls.append(kw)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply, CallRecord(scope="plan", provider="fake", model="fake")


def _reply(cur):
    return {"steps": [{"keep_step_id": s["id"], "title": s["title"], "description": s["description"],
                       "glyph": s["glyph"]} for s in cur]}


def test_replan_prompt_carries_statuses_instruction_and_images():
    cur = _steps(("approved", "pending", "pending", "pending", "removed", "pending"))
    llm = _FakeLLM([_reply(cur)])
    seen = []

    async def on_call(rec):
        seen.append(rec)

    out = asyncio.run(replan(llm, "the task", cur, "skip the cart", images=[ImageInput("image/png", b"x")],
                             on_call=on_call))
    assert [r.keep_step_id for r in out] == [s["id"] for s in cur]
    kw = llm.calls[0]
    assert kw["schema_name"] == "revise" and kw["scope"] == "plan"
    assert "id=stp_1 [approved]" in kw["user"] and "id=stp_5 [removed]" in kw["user"]
    assert "skip the cart" in kw["user"] and "the task" in kw["user"]
    assert [i.mime for i in kw["images"]] == ["image/png"]
    assert len(seen) == 1


def test_replan_retries_once_then_fails():
    cur = _steps()
    llm = _FakeLLM([{"steps": []}, _reply(cur)])
    assert len(asyncio.run(replan(llm, "t", cur, None))) == 6
    llm = _FakeLLM([{"steps": []}, {"steps": []}])
    with pytest.raises(LLMError, match="replanner failed"):
        asyncio.run(replan(llm, "t", cur, None))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_revise.py -q`
Expected: collection FAILS with `ModuleNotFoundError: No module named 'oversight.replanner'`.

- [ ] **Step 3: Implement `replanner.py`**

Create `daemon/oversight/replanner.py`:

```python
"""Re-propose: revise a plan from the user's decisions and a chat instruction.

Spec: Daemon API changes §2 (built on docs/01 step 6). The model returns the whole
revised plan; each step either keeps an existing id (`keep_step_id`) or is new. The
daemon, not the model, decides what counts as unchanged (exact title + description).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

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


def render_current(steps: list[dict]) -> str:
    return "\n".join(f"- id={s['id']} [{s['status']}] {s['index']}. {s['title']}: {s['description']}"
                     for s in sorted(steps, key=lambda s: s["index"]))


async def replan(llm: StructuredLLM, prompt: str, current_steps: list[dict],
                 instruction: str | None, images: Sequence[ImageInput] = (),
                 on_call=None) -> list[RevisedStep]:
    """Validated revised plan. Retries once on invalid output; `on_call(record)` is awaited
    after every LLM call for cost accounting (like planner.plan_task)."""
    user = (f"Task: {prompt}\n\nCurrent plan (id, [status], index. title: description):\n"
            f"{render_current(current_steps)}\n\nInstruction from the user: "
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_revise.py -q`
Expected: `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add oversight/replanner.py tests/test_revise.py
git commit -m "daemon: replanner (keep-id revisions, pure merge, fixture grammar)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D3-2: `POST /task/{id}/repropose`

**Files:**
- Modify: `daemon/oversight/routes/revise.py` (replace the Wave 0 stub)
- Test: `daemon/tests/test_revise.py` (append)

**Interfaces:**
- Consumes:
  - C4 `Ctx`: `st.store`, `st.settings`, `st.bus`, `st.llm`, `st.plan_locks`, `st.active_runs`, `progress`, `record_call`, `score_steps(..., context=, on_done=)`, `scores_snapshot`, `load_images`.
  - Store: `get_task`, `get_steps`, `get_scores`, `revise_plan`, `add_decision`, `get_events`.
  - D3-1 exports.
- Produces:
  - C3 `POST /task/{id}/repropose` `{instruction: str | null}` → 200 `{task_id, steps, scores, revision}`. Errors: 404, 409 (no plan, run active, plan being generated), 502 (LLM).
  - SSE `plan_revised` with C1 `PlanRevisedPayload` (sorted id lists). `plan_progress` events (stage `planning`, then `scoring` if anything is rescored, then `done`).
  - `revision` = the number of `plan_revised` events for the task after this one (1, 2, …).

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_revise.py`:

```python
from fastapi.testclient import TestClient

from oversight.api import ActiveRun, create_app
from oversight.routes import revise as revise_routes
from oversight.settings import Settings

OTHER = ("financial_commitment", "verifiability")


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _plan(client):
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    body = client.post(f"/task/{tid}/plan").json()
    return tid, {s["index"]: s for s in body["steps"]}, body["scores"]


def _events(client, tid, kind):
    return [e for e in client.app.state.oversight.store.get_events(tid) if e["kind"] == kind]


def test_repropose_preserves_state(client):
    # Review Focus #3: mixed polygon/check/remove state on two axis pairs.
    tid, steps, scores = _plan(client)
    x, y = fixtures.DEMO_AXES
    client.put(f"/task/{tid}/boundary", json={"x_dim": x, "y_dim": y, "polygon": fixtures.DEMO_POLYGON})
    client.put(f"/task/{tid}/boundary", json={"x_dim": OTHER[0], "y_dim": OTHER[1],
                                              "polygon": [[0, 0], [0.3, 0], [0.3, 0.3]]})
    client.post(f"/task/{tid}/decision", json={"step_id": steps[3]["id"], "action": "check", "source": "step_list"})
    client.post(f"/task/{tid}/decision", json={"step_id": steps[5]["id"], "action": "remove", "source": "step_list"})

    r = client.post(f"/task/{tid}/repropose", json={"instruction": "drop 6; add Ask the party group for a date"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 1 and body["task_id"] == tid
    new = {s["index"]: s for s in body["steps"]}
    assert [new[i]["id"] for i in range(1, 6)] == [steps[i]["id"] for i in range(1, 6)]
    assert steps[6]["id"] not in {s["id"] for s in body["steps"]}
    assert new[6]["title"] == "Ask the party group for a date" and new[6]["status"] == "pending"
    assert new[3]["status"] == "approved" and new[5]["status"] == "removed"

    before = sorted((s for s in scores if s["step_id"] == steps[1]["id"]), key=lambda s: s["dimension"])
    after = sorted((s for s in body["scores"] if s["step_id"] == steps[1]["id"]), key=lambda s: s["dimension"])
    assert before == after
    assert len([s for s in body["scores"] if s["step_id"] == new[6]["id"]]) == 10

    pairs = {(b["x_dim"], b["y_dim"]) for b in client.app.state.oversight.store.get_boundaries(tid)}
    assert pairs == {(x, y), OTHER}

    ev = _events(client, tid, "plan_revised")[-1]["payload"]
    assert ev == {"revision": 1, "instruction": "drop 6; add Ask the party group for a date",
                  "changed_step_ids": [], "added_step_ids": [new[6]["id"]],
                  "dropped_step_ids": [steps[6]["id"]]}
    decs = [(d["step_id"], d["action"], d["source"]) for d in client.get(f"/task/{tid}").json()["decisions"]]
    assert (steps[6]["id"], "revise", "chat") in decs and (new[6]["id"], "revise", "chat") in decs
    stages = [e["payload"]["stage"] for e in _events(client, tid, "plan_progress")]
    assert stages[-3:] == ["planning", "scoring", "done"]

    assert client.post(f"/task/{tid}/repropose", json={"instruction": None}).json()["revision"] == 2


def test_repropose_rewrite_goes_pending_and_rescored(client):
    tid, steps, _ = _plan(client)
    client.post(f"/task/{tid}/decision", json={"step_id": steps[6]["id"], "action": "check", "source": "step_list"})
    body = client.post(f"/task/{tid}/repropose", json={"instruction": "only message the party group"}).json()
    s6 = next(s for s in body["steps"] if s["id"] == steps[6]["id"])
    assert s6["title"].endswith("(revised: only message the party group)")
    assert (s6["status"], s6["revision"]) == ("pending", 1)
    ev = _events(client, tid, "plan_revised")[-1]["payload"]
    assert ev["changed_step_ids"] == [steps[6]["id"]]


def test_repropose_errors(client):
    assert client.post("/task/tsk_nope/repropose", json={"instruction": "x"}).status_code == 404
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409

    tid, _steps_, _ = _plan(client)
    st = client.app.state.oversight
    st.active_runs[tid] = ActiveRun(run_id="run_x", stop=asyncio.Event())
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409
    del st.active_runs[tid]

    lock = asyncio.Lock()
    asyncio.run(lock.acquire())
    st.plan_locks[tid] = lock
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409
    lock.release()


def test_repropose_llm_failure_is_502_and_reported(client, monkeypatch):
    tid, steps, _ = _plan(client)

    def boom(current, instruction):
        raise LLMError("model refused the request")

    monkeypatch.setattr(revise_routes, "fixture_replan", boom)
    r = client.post(f"/task/{tid}/repropose", json={"instruction": "x"})
    assert r.status_code == 502 and "model refused" in r.json()["error"]
    assert _events(client, tid, "plan_progress")[-1]["payload"]["stage"] == "error"
    assert [s["id"] for s in client.get(f"/task/{tid}").json()["steps"]] == [steps[i]["id"] for i in range(1, 7)]


def test_repropose_live_path_uses_replan_with_images(client, monkeypatch):
    tid, steps, _ = _plan(client)
    seen = {}

    async def fake_replan(llm, prompt, current, instruction, images=(), on_call=None):
        seen.update(prompt=prompt, instruction=instruction, images=list(images), n=len(current))
        return [RevisedStep(s["id"], s["title"], s["description"], s["glyph"])
                for s in sorted(current, key=lambda s: s["index"])]

    monkeypatch.setattr(revise_routes, "replan", fake_replan)
    client.app.state.oversight.settings.fixtures = False
    client.app.state.oversight.llm = object()  # never called: replan is faked, nothing rescored
    r = client.post(f"/task/{tid}/repropose", json={"instruction": "keep it"})
    client.app.state.oversight.settings.fixtures = True
    assert r.status_code == 200, r.text
    assert seen == {"prompt": fixtures.TASK_PROMPT, "instruction": "keep it", "images": [], "n": 6}
```

```python
def test_revise_routes_registered(client):
    paths = {getattr(r, "path", "") for r in client.app.routes}
    assert {"/task/{task_id}/repropose", "/task/{task_id}/step/{step_id}"} <= paths
```

This last test passes only after D3-3 adds the PATCH route. Until then, run D3-2's checks with `-k "not routes_registered"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_revise.py -q`
Expected: FAIL. `test_repropose_*` get 404 (no route yet), so asserts like `assert 404 == 200` fail. `test_repropose_llm_failure…` fails with `AttributeError: module 'oversight.routes.revise' has no attribute 'fixture_replan'`.

- [ ] **Step 3: Implement the route**

Replace `daemon/oversight/routes/revise.py` with:

```python
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
                                           images=ctx.load_images(task_id), on_call=on_call)
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
```

(Task D3-3 adds the PATCH handler inside the same `register`. `StepPatch` is declared now so the module's shape doesn't change later.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_revise.py -q -k "not routes_registered"`
Expected: `14 passed`.

- [ ] **Step 5: Full suite and commit**

Run: `uv run pytest -q -k "not routes_registered"`
Expected: all pass.

```bash
git add oversight/routes/revise.py tests/test_revise.py
git commit -m "daemon: POST /task/{id}/repropose (keeps ids, statuses, scores and boundaries)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D3-3: `PATCH /task/{id}/step/{step_id}`

**Files:**
- Modify: `daemon/oversight/routes/revise.py` (add the handler inside `register`)
- Test: `daemon/tests/test_revise.py` (append)

**Interfaces:**
- Consumes: store `update_step`, `replace_step_scores`, `set_step_status`, and `add_decision`; `ctx.score_steps(..., context=)`; and `ctx.scores_snapshot`.
- Produces: C3 `PATCH /task/{id}/step/{step_id}` `{title?, description?}` → 200 `{step, scores}`. Errors: 400 (both empty), 404 (task or step), 409 (run active), 502 (scoring LLM). `edited_from` keeps the first original title. The edited step becomes **pending**: an approval given to the old text never carries over to new text.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_revise.py`:

```python
def test_edit_step_flow(client):
    tid, steps, _ = _plan(client)
    sid = steps[4]["id"]
    client.post(f"/task/{tid}/decision", json={"step_id": sid, "action": "check", "source": "step_list"})

    r = client.patch(f"/task/{tid}/step/{sid}", json={"title": "Draft a short party message"})
    assert r.status_code == 200, r.text
    step = r.json()["step"]
    assert step["title"] == "Draft a short party message"
    assert step["description"] == steps[4]["description"]
    assert step["edited_from"] == steps[4]["title"]
    assert step["status"] == "pending"
    assert len(r.json()["scores"]) == 10 and {s["step_id"] for s in r.json()["scores"]} == {sid}

    r2 = client.patch(f"/task/{tid}/step/{sid}", json={"description": "Two lines, no names."})
    assert r2.json()["step"]["edited_from"] == steps[4]["title"]  # first original title kept
    assert r2.json()["step"]["revision"] == 2

    decs = [d for d in client.get(f"/task/{tid}").json()["decisions"] if d["action"] == "edit"]
    assert len(decs) == 2 and decs[0]["source"] == "step_list" and decs[0]["step_id"] == sid
    assert decs[0]["snapshot"]["edited_from"] == steps[4]["title"]


def test_edit_step_errors(client):
    tid, steps, _ = _plan(client)
    sid = steps[1]["id"]
    assert client.patch(f"/task/{tid}/step/{sid}", json={"title": "  ", "description": ""}).status_code == 400
    assert client.patch(f"/task/{tid}/step/stp_nope", json={"title": "x"}).status_code == 404
    assert client.patch(f"/task/tsk_nope/step/{sid}", json={"title": "x"}).status_code == 404
    st = client.app.state.oversight
    st.active_runs[tid] = ActiveRun(run_id="run_x", stop=asyncio.Event())
    assert client.patch(f"/task/{tid}/step/{sid}", json={"title": "x"}).status_code == 409
    del st.active_runs[tid]


def test_edit_step_noop_returns_current_without_decision(client):
    tid, steps, _ = _plan(client)
    sid = steps[2]["id"]
    r = client.patch(f"/task/{tid}/step/{sid}", json={"title": steps[2]["title"]})
    assert r.status_code == 200 and r.json()["step"]["revision"] == 0
    assert not [d for d in client.get(f"/task/{tid}").json()["decisions"] if d["action"] == "edit"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_revise.py -q -k edit_step`
Expected: FAIL. PATCH returns 405 Method Not Allowed (no route), so `assert 405 == 200` fails.

- [ ] **Step 3: Implement the handler**

In `daemon/oversight/routes/revise.py`, add this inside `register`, after `repropose`:

```python
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
```

`edited_from` on the stored row stays the first original title because `update_step` uses `COALESCE(edited_from, ?)`. The decision snapshot records the title the user replaced in this particular edit. Scoring runs before the write, so a failed rescore leaves the step untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_revise.py -q`
Expected: `18 passed`.

- [ ] **Step 5: Full suite and commit**

Run: `uv run pytest -q`
Expected: all pass.

```bash
git add oversight/routes/revise.py tests/test_revise.py
git commit -m "daemon: PATCH /task/{id}/step/{step_id} (edit, rescore, edit decision, back to pending)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- Resolved in Wave 0: the `step_edited` reducer action unchecks the edited step.
- Resolved in Wave 0: `plan_revised` keeps a check only on steps the daemon still reports as approved.
- `revision` in the repropose response is the task's revise count, derived from stored `plan_revised` events. There's no new column. Replays stay consistent.
- Decision `source: "chat"` (revise) is a daemon-side value outside the UI's `DecisionSource` union. That's fine: the UI never sends it, and the daemon accepts any string.
