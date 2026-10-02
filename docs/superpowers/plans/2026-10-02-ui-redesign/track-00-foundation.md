# Track 00: Wave 0 foundation (W0-1, W0-2, W0-3)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1 to C8), and Ownership matrix first. W0-1 and W0-2 run in parallel. W0-3 starts after both are merged into `ui-redesign`.

Wave 0 does three things: it freezes every contract, moves the old UI into `paper/`, and leaves a working app built on stubs. That way every Wave 1 track can start from green checks and replace one stub without touching anyone else's files.

---

## Task W0-1: Daemon foundation

**Files:**
- Modify: `daemon/pyproject.toml` (dependencies), `daemon/uv.lock` (via `uv sync`)
- Modify: `daemon/oversight/store.py` (schema + methods)
- Modify: `daemon/oversight/fixtures.py` (`scores_for_steps`, `synthetic_scores`)
- Modify: `daemon/oversight/llm.py` (`ImageInput`, `images=` parameter)
- Modify: `daemon/oversight/planner.py` (`images=` passthrough)
- Modify: `daemon/oversight/api.py` (ctx, route registration, health fields, attachments on tasks, `score_steps`, `load_images`)
- Create: `daemon/oversight/routes/__init__.py`, `routes/ctx.py`, `routes/setup.py`, `routes/attachments.py`, `routes/revise.py`, `routes/frames.py`
- Test: `daemon/tests/test_store_v2.py`, `daemon/tests/test_routes_v2.py`

**Interfaces:**
- Consumes: the existing `Store`, `State`, `record_call`, `progress`, `scores_snapshot`, `LLMScorer`, and `verdicts_to_scores`.
- Produces: Contracts C3 (`/health` fields, `POST /task` attachment_ids, `GET /task` attachments) and C4 (`Ctx`, `register`, store methods, `ImageInput`, `scores_for_steps`), plus `app.state.ctx` for tests.

- [ ] **Step 1: Add the dependencies**

In `daemon/pyproject.toml`, append to the `dependencies` list after `"pillow>=10.3",`:

```toml
    "keyring>=25.0",
    "python-multipart>=0.0.9",
```

Run: `cd daemon && uv sync`
Expected: resolves and installs `keyring` and `python-multipart` with no errors.

- [ ] **Step 2: Write the failing store tests**

Create `daemon/tests/test_store_v2.py`:

```python
from oversight.store import Store


def _store(tmp_path):
    return Store(tmp_path / "t.db")


def _plan():
    steps = [{"id": f"stp_{i}", "index": i, "title": f"T{i}", "description": "d",
              "glyph": "generic"} for i in (1, 2)]
    scores = [{"step_id": f"stp_{i}", "dimension": "reversibility", "label": "x",
               "position": 0.1 * i, "confidence": 0.5, "rationale": "r"} for i in (1, 2)]
    return steps, scores


def test_attachment_dedupe_and_link(tmp_path):
    s = _store(tmp_path)
    a = s.add_attachment("abc", "image/png", 10, "/x/a.png")
    assert s.add_attachment("abc", "image/png", 10, "/x/a.png") == a
    c = s.add_attachment("def", "image/jpeg", 20, "/x/c.jpg")
    tid = s.create_task("p", None, "live")
    s.link_attachments(tid, [c, a])
    got = s.get_task_attachments(tid)
    assert [g["attachment_id"] for g in got] == [c, a]
    assert (got[0]["mime"], got[0]["bytes"], got[0]["path"]) == ("image/jpeg", 20, "/x/c.jpg")
    assert s.get_attachment(a)["sha256"] == "abc"
    assert s.get_attachment("att_missing") is None


def test_settings_roundtrip(tmp_path):
    s = _store(tmp_path)
    assert s.get_setting("plan_only", False) is False
    s.set_setting("plan_only", True)
    s.set_setting("key_tested", {"anthropic": True})
    s.set_setting("plan_only", True)  # upsert, not a duplicate row
    assert s.get_setting("plan_only") is True
    assert s.get_setting("key_tested") == {"anthropic": True}


def test_frames_seq_is_per_task(tmp_path):
    s = _store(tmp_path)
    t1 = s.create_task("a", None, "live")
    t2 = s.create_task("b", None, "live")
    assert s.add_frame(t1, "run_1", "stp_1", "/f/1.jpg") == 1
    assert s.add_frame(t1, "run_1", "stp_1", "/f/2.jpg") == 2
    assert s.add_frame(t2, "run_2", "stp_9", "/f/3.jpg") == 1
    assert s.get_frame(t1, 2)["path"] == "/f/2.jpg"
    assert s.get_frame(t1, 3) is None


def test_revise_plan_keeps_boundaries_replace_plan_drops_them(tmp_path):
    s = _store(tmp_path)
    tid = s.create_task("p", None, "live")
    steps, scores = _plan()
    s.replace_plan(tid, steps, scores)
    s.put_boundary(tid, "action_uncertainty", "reversibility", [[0, 0], [1, 0], [1, 1]])
    s.revise_plan(tid, steps[:1], scores[:1])
    assert [x["id"] for x in s.get_steps(tid)] == ["stp_1"]
    assert [x["step_id"] for x in s.get_scores(tid)] == ["stp_1"]
    assert len(s.get_boundaries(tid)) == 1
    s.replace_plan(tid, steps, scores)
    assert s.get_boundaries(tid) == []


def test_update_step_keeps_first_edited_from_and_replaces_scores(tmp_path):
    s = _store(tmp_path)
    tid = s.create_task("p", None, "live")
    steps, scores = _plan()
    s.replace_plan(tid, steps, scores)
    s.update_step("stp_1", "New", "nd", "T1")
    s.update_step("stp_1", "Newer", "nd2", "New")
    st1 = s.get_steps(tid)[0]
    assert (st1["title"], st1["description"], st1["edited_from"]) == ("Newer", "nd2", "T1")
    assert st1["revision"] == 2
    s.replace_step_scores("stp_1", [{"step_id": "stp_1", "dimension": "verifiability",
                                     "label": "y", "position": 0.7, "confidence": 0.9,
                                     "rationale": "q"}])
    mine = [x for x in s.get_scores(tid) if x["step_id"] == "stp_1"]
    assert [m["dimension"] for m in mine] == ["verifiability"]
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd daemon && uv run pytest tests/test_store_v2.py -q`
Expected: FAIL with `AttributeError: 'Store' object has no attribute 'add_attachment'`.

- [ ] **Step 4: Implement the store schema and methods**

In `daemon/oversight/store.py`, append these tables to the end of the `SCHEMA` string, just before its closing `"""`:

```sql
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attachments (
    task_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (task_id, attachment_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS frames (
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
);
```

Replace the existing `replace_plan` method with this version, which delegates to a shared writer, and add `revise_plan` right after it:

```python
    def replace_plan(self, task_id: str, steps: list[dict], scores: list[dict]) -> None:
        """Swap in a new plan. Also drops the task's stored boundaries (see below)."""
        self._write_plan(task_id, steps, scores, keep_boundaries=False)

    def revise_plan(self, task_id: str, steps: list[dict], scores: list[dict]) -> None:
        """Swap in a revised plan (re-propose). Boundaries are KEPT: kept steps keep their
        scores, so the user's polygon still means what it meant; new steps are pending
        until the polygon or a check approves them, exactly like any other step."""
        self._write_plan(task_id, steps, scores, keep_boundaries=True)

    def _write_plan(self, task_id: str, steps: list[dict], scores: list[dict],
                    keep_boundaries: bool) -> None:
        with self._lock:
            self.db.execute("BEGIN")
            try:
                old = [r["id"] for r in self.db.execute(
                    "SELECT id FROM steps WHERE task_id=?", (task_id,))]
                for sid in old:
                    self.db.execute("DELETE FROM scores WHERE step_id=?", (sid,))
                self.db.execute("DELETE FROM steps WHERE task_id=?", (task_id,))
                if not keep_boundaries:
                    # Polygons were drawn against the old plan's scores. Keeping them would let
                    # a run with `boundaries` omitted approve new steps nobody looked at. Runs
                    # keep their own copy of the boundaries they used, so history survives.
                    self.db.execute("DELETE FROM boundaries WHERE task_id=?", (task_id,))
                for s in steps:
                    self.db.execute(
                        "INSERT INTO steps (id, task_id, idx, title, description, glyph, status, "
                        "edited_from, revision) VALUES (?,?,?,?,?,?,?,?,?)",
                        (s["id"], task_id, s["index"], s["title"], s["description"], s["glyph"],
                         s.get("status", "pending"), s.get("edited_from"), s.get("revision", 0)))
                for sc in scores:
                    self.db.execute(
                        "INSERT INTO scores (step_id, dimension, label, position, confidence, "
                        "rationale) VALUES (?,?,?,?,?,?)",
                        (sc["step_id"], sc["dimension"], sc["label"], sc["position"],
                         sc["confidence"], sc["rationale"]))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise

    def update_step(self, step_id: str, title: str, description: str,
                    edited_from: str | None) -> None:
        """User edit. `edited_from` keeps the FIRST original title across repeated edits."""
        self._x("UPDATE steps SET title=?, description=?, edited_from=COALESCE(edited_from, ?), "
                "revision=revision+1 WHERE id=?", (title, description, edited_from, step_id))

    def replace_step_scores(self, step_id: str, scores: list[dict]) -> None:
        with self._lock:
            self.db.execute("BEGIN")
            try:
                self.db.execute("DELETE FROM scores WHERE step_id=?", (step_id,))
                for sc in scores:
                    self.db.execute(
                        "INSERT INTO scores (step_id, dimension, label, position, confidence, "
                        "rationale) VALUES (?,?,?,?,?,?)",
                        (step_id, sc["dimension"], sc["label"], sc["position"],
                         sc["confidence"], sc["rationale"]))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
```

Add these sections at the end of the `Store` class:

```python
    # ------------------------------------------------------------ attachments
    def add_attachment(self, sha256: str, mime: str, size: int, path: str) -> str:
        with self._lock:
            row = self.db.execute("SELECT id FROM attachments WHERE sha256=?",
                                  (sha256,)).fetchone()
            if row is not None:
                return str(row["id"])
            aid = new_id("att")
            self.db.execute(
                "INSERT INTO attachments (id, sha256, mime, bytes, path, created_at) "
                "VALUES (?,?,?,?,?,?)", (aid, sha256, mime, size, path, now_iso()))
            return aid

    def get_attachment(self, attachment_id: str) -> dict | None:
        rows = self._q("SELECT * FROM attachments WHERE id=?", (attachment_id,))
        return dict(rows[0]) if rows else None

    def link_attachments(self, task_id: str, attachment_ids: list[str]) -> None:
        with self._lock:
            for i, aid in enumerate(attachment_ids):
                self.db.execute("INSERT OR IGNORE INTO task_attachments (task_id, attachment_id, "
                                "ord) VALUES (?,?,?)", (task_id, aid, i))

    def get_task_attachments(self, task_id: str) -> list[dict]:
        rows = self._q("SELECT a.id, a.mime, a.bytes, a.path FROM task_attachments ta "
                       "JOIN attachments a ON a.id=ta.attachment_id WHERE ta.task_id=? "
                       "ORDER BY ta.ord", (task_id,))
        return [{"attachment_id": r["id"], "mime": r["mime"], "bytes": r["bytes"],
                 "path": r["path"]} for r in rows]

    # ------------------------------------------------------------ settings
    def get_setting(self, key: str, default: Any = None) -> Any:
        rows = self._q("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    def set_setting(self, key: str, value: Any) -> None:
        self._x("INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))

    # ------------------------------------------------------------ frames
    def add_frame(self, task_id: str, run_id: str, step_id: str, path: str) -> int:
        with self._lock:
            row = self.db.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM frames WHERE task_id=?",
                                  (task_id,)).fetchone()
            seq = int(row["m"]) + 1
            self.db.execute("INSERT INTO frames (task_id, seq, run_id, step_id, path, created_at) "
                            "VALUES (?,?,?,?,?,?)", (task_id, seq, run_id, step_id, path, now_iso()))
            return seq

    def get_frame(self, task_id: str, seq: int) -> dict | None:
        rows = self._q("SELECT * FROM frames WHERE task_id=? AND seq=?", (task_id, seq))
        return dict(rows[0]) if rows else None
```

- [ ] **Step 5: Run the store tests to verify they pass**

Run: `cd daemon && uv run pytest tests/test_store_v2.py -q`
Expected: `5 passed`.

- [ ] **Step 6: Commit**

```bash
git add daemon/pyproject.toml daemon/uv.lock daemon/oversight/store.py daemon/tests/test_store_v2.py
git commit -m "daemon: store v2 (attachments, settings, frames, revise_plan, step edits)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

- [ ] **Step 7: Write the failing routes and fixtures tests**

Create `daemon/tests/test_routes_v2.py`:

```python
import asyncio

import pytest
from fastapi.testclient import TestClient

from oversight import fixtures
from oversight.api import create_app
from oversight.llm import ImageInput, StructuredLLM
from oversight.settings import Settings


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def test_scores_for_steps_fixture_and_synthetic():
    steps = [{"id": "a", "index": 1, "title": fixtures.STEPS[0][0]},
             {"id": "b", "index": 2, "title": "Something new"}]
    sc = fixtures.scores_for_steps(steps)
    assert len(sc) == 20
    assert [x.to_api() for x in sc] == [x.to_api() for x in fixtures.scores_for_steps(steps)]
    assert [x for x in sc if x.step_id == "a"] == fixtures.fixture_scores({1: "a"})
    assert all(0.0 <= x.position <= 1.0 for x in sc)


def test_health_has_setup_fields(client):
    h = client.get("/health").json()
    assert h["setup_complete"] is False and h["plan_only"] is False
    client.app.state.oversight.store.set_setting("setup_complete", True)
    assert client.get("/health").json()["setup_complete"] is True


def test_task_attachments_validation(client):
    store = client.app.state.oversight.store
    aid = store.add_attachment("s1", "image/png", 3, "/nope.png")
    r = client.post("/task", json={"prompt": "p", "attachment_ids": [aid]})
    assert r.status_code == 200
    tid = r.json()["task_id"]
    got = client.get(f"/task/{tid}").json()["task"]["attachments"]
    assert got == [{"attachment_id": aid, "mime": "image/png", "bytes": 3}]
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ["att_x"]}).status_code == 400
    ids = [store.add_attachment(f"h{i}", "image/png", 1, "/n") for i in range(5)]
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ids}).status_code == 400
    # missing files are skipped, never crash planning
    assert client.app.state.ctx.load_images(tid) == []


def test_ctx_score_steps_fixture_mode(client):
    ctx = client.app.state.ctx
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    out = asyncio.run(ctx.score_steps(tid, "p", [
        {"id": "s1", "index": 1, "title": "Brand new step", "description": "d"}]))
    assert len(out) == 10 and {o["step_id"] for o in out} == {"s1"}


def test_llm_and_planner_accept_images_param():
    # Signature only: track D2 replaces the Wave 0 gate without editing this frozen file.
    import inspect
    from oversight.planner import plan_task
    assert "images" in inspect.signature(StructuredLLM.call).parameters
    assert "images" in inspect.signature(plan_task).parameters
    assert ImageInput("image/png", b"x").mime == "image/png"
```

Run: `cd daemon && uv run pytest tests/test_routes_v2.py -q`
Expected: FAIL (`ImportError: cannot import name 'ImageInput'`).

- [ ] **Step 8: Add `ImageInput` and the gated `images=` parameter**

In `daemon/oversight/llm.py`, change `from typing import Any` to:

```python
from collections.abc import Sequence
from typing import Any
```

Add this after the `CallRecord` dataclass:

```python
@dataclass(frozen=True)
class ImageInput:
    """One user-attached image for a structured call (track D2 builds the blocks)."""

    mime: str  # image/png | image/jpeg | image/webp
    data: bytes
```

Change the `call` signature and add the gate as its first statement:

```python
    async def call(self, *, scope: str, system: str, user: str, schema: dict,
                   schema_name: str, effort: str = "low",
                   max_tokens: int = 8000,
                   images: Sequence[ImageInput] = ()) -> tuple[dict, CallRecord]:
        if images:
            # Wave 0 gate. Track D2 replaces this with Anthropic/OpenAI image blocks.
            raise LLMError("image input not implemented")
```

(The existing body continues unchanged after these lines.)

In `daemon/oversight/planner.py`, change the import line to `from .llm import CallRecord, ImageInput, LLMError, StructuredLLM`. Then change `plan_task`:

```python
async def plan_task(llm: StructuredLLM, prompt: str, selected_app: str | None,
                    on_call=None, images: Sequence[ImageInput] = ()) -> list[PlannedStep]:
```

Pass the images through in its `llm.call(...)`:

```python
            data, rec = await llm.call(scope="plan", system=SYSTEM, user=user,
                                       schema=PLAN_SCHEMA, schema_name="plan",
                                       effort="medium", max_tokens=8000, images=images)
```

Add `from collections.abc import Sequence` under `from dataclasses import dataclass`.

- [ ] **Step 9: Add fixture scoring for arbitrary steps**

In `daemon/oversight/fixtures.py`, replace the import line with:

```python
import hashlib

from .dimensions import load_dimensions
from .scorer import DimensionScore, Verdict, verdicts_to_scores
```

Append at the end of the file:

```python
def synthetic_scores(step_id: str, title: str) -> list[DimensionScore]:
    """Deterministic made-up scores for a step that is not in the fixture plan
    (fixture-mode re-propose and edit). Same title -> same point, always."""
    verdicts: dict[str, Verdict] = {}
    for d in load_dimensions():
        h = int(hashlib.sha256(f"{title}|{d.key}".encode()).hexdigest(), 16)
        verdicts[d.key] = Verdict(d.labels[h % len(d.labels)], ((h >> 8) % 100) / 100, 0.5,
                                  "Synthetic fixture score (fixtures mode).")
    return verdicts_to_scores(step_id, verdicts)


def scores_for_steps(steps: list[dict]) -> list[DimensionScore]:
    """Fixture-mode scoring for any steps: fixture titles get their authored scores."""
    by_title = {t: i + 1 for i, (t, _d, _g) in enumerate(STEPS)}
    out: list[DimensionScore] = []
    for s in steps:
        idx = by_title.get(s["title"])
        out.extend(verdicts_to_scores(s["id"], SCORES[idx]) if idx is not None
                   else synthetic_scores(s["id"], s["title"]))
    return out
```

- [ ] **Step 10: Create the routes package with stubs**

Create `daemon/oversight/routes/__init__.py`:

```python
"""Feature route modules. Each exposes `register(app, ctx)`; api.create_app calls them."""
```

Create `daemon/oversight/routes/ctx.py`:

```python
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
```

Create each of `daemon/oversight/routes/setup.py`, `routes/attachments.py`, `routes/revise.py`, and `routes/frames.py` with this content. Substitute the owner and endpoint list from the table below the code:

```python
"""<FEATURE>. Implemented by track <OWNER>; Wave 0 leaves it empty."""

from __future__ import annotations

from fastapi import FastAPI

from .ctx import Ctx


def register(app: FastAPI, ctx: Ctx) -> None:
    """Stub. Track <OWNER> adds: <ENDPOINTS>."""
    return None
```

| File | FEATURE | OWNER | ENDPOINTS |
|---|---|---|---|
| `setup.py` | First-run setup and settings | D1 | GET /setup/status, PUT /setup/key, POST /setup/driver/install, POST /setup/driver/start, POST /setup/permissions/open, POST /setup/self-test, POST /setup/complete, GET/PUT /settings |
| `attachments.py` | Image attachments | D2 | POST /attachments, GET /attachments/{id} |
| `revise.py` | Re-propose and step edit | D3 | POST /task/{id}/repropose, PATCH /task/{id}/step/{step_id} |
| `frames.py` | Agent desk frames | D4 | GET /task/{id}/frames/{seq}.jpg |

- [ ] **Step 11: Wire `api.py`**

Make these edits in `daemon/oversight/api.py`:

(a) Imports. Replace `from .llm import CallRecord, LLMError, StructuredLLM` with:

```python
from pathlib import Path

from .llm import CallRecord, ImageInput, LLMError, StructuredLLM
from .routes import attachments as attachments_routes
from .routes import frames as frames_routes
from .routes import revise as revise_routes
from .routes import setup as setup_routes
from .routes.ctx import Ctx
```

Add `from collections.abc import Awaitable, Callable` to the stdlib imports.

(b) `TaskBody` gains a field:

```python
class TaskBody(BaseModel):
    prompt: str
    selected_app: str | None = None
    attachment_ids: list[str] = []
```

(c) Add `MAX_ATTACHMENTS = 4` right below `log = logging.getLogger("oversight")`.

(d) In `/health`, add these keys to the returned dict, after `"status_line": status_line,`:

```python
            "setup_complete": bool(store.get_setting("setup_complete", False)),
            "plan_only": bool(store.get_setting("plan_only", False)),
```

(e) Replace the body of `create_task` with:

```python
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
```

(f) In `get_task`, replace `"task": task,` with:

```python
            "task": {**task, "attachments": [
                {k: a[k] for k in ("attachment_id", "mime", "bytes")}
                for a in store.get_task_attachments(task_id)]},
```

(g) Add `score_steps` and `load_images` right after the `progress` helper, then rewrite `plan_live` to use them:

```python
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
        ctx_views = [StepView(s["id"], s["index"], s["title"], s["description"])
                     for s in (context or steps)]
        wanted = {s["id"] for s in steps}

        async def one(v: StepView) -> list:
            res = await scorer.score(prompt, v, ctx_views)
            if on_done:
                await on_done(v)
            return res

        results = await asyncio.gather(*(one(v) for v in ctx_views if v.id in wanted))
        return [sc.to_api() for r in results for sc in r]

    def load_images(task_id: str) -> list[ImageInput]:
        out = []
        for a in store.get_task_attachments(task_id):
            p = Path(a["path"])
            if p.is_file():
                out.append(ImageInput(a["mime"], p.read_bytes()))
        return out

    async def plan_live(task_id: str, prompt: str, selected_app: str | None
                        ) -> tuple[list[dict], list[dict]]:
        assert st.llm is not None

        async def on_call(rec: CallRecord) -> None:
            await record_call(task_id, None, rec)

        await progress(task_id, "planning", "Generating plan.", 0, 0)
        planned = await plan_task(st.llm, prompt, selected_app, on_call=on_call,
                                  images=load_images(task_id))
        steps = [{"id": new_id("stp"), "task_id": task_id, "index": i + 1, "title": p.title,
                  "description": p.description, "glyph": p.glyph, "status": "pending",
                  "edited_from": None, "revision": 0} for i, p in enumerate(planned)]
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
```

Delete the old `plan_live` body. `score_plan` is no longer imported by `api.py`; remove it from the `from .scorer import …` line.

(h) Just before `return app` at the end of `create_app`:

```python
    ctx = Ctx(st=st, record_call=record_call, progress=progress,
              scores_snapshot=scores_snapshot, score_steps=score_steps,
              load_images=load_images)
    app.state.ctx = ctx
    for mod in (setup_routes, attachments_routes, revise_routes, frames_routes):
        mod.register(app, ctx)
```

- [ ] **Step 12: Run the whole daemon suite**

Run: `cd daemon && uv run pytest -q`
Expected: all pass, including the 5 new tests in `test_routes_v2.py` and the existing `test_api.py`.

- [ ] **Step 13: Commit**

```bash
git add daemon/oversight daemon/tests/test_routes_v2.py
git commit -m "daemon: route ctx, feature stubs, attachments on tasks, score_steps, image param" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task W0-2: UI contracts

**Files:**
- Modify: `app/package.json` (devDependency `@playwright/test`, script `e2e`), `app/package-lock.json`
- Create: `app/playwright.config.ts`, `app/e2e/.gitkeep`
- Create: `app/src/api/errors.ts`
- Modify: `app/src/api/types.ts` (C1), `app/src/api/client.ts` (C2), `app/src/api/mock.ts` (minimal C2 implementations), `app/src/lib/tauri.ts` (C7 stubs)
- Test: `app/tests/contracts.test.mts`

**Interfaces:**
- Consumes: the existing `types.ts`, `client.ts`, and `mock.ts`.
- Produces: C1, C2, and C7 exactly as written in the master plan. `HttpError` moves to `api/errors.ts` and is re-exported from `client.ts`.

- [ ] **Step 1: Add Playwright**

Run:

```bash
cd app && npm install --save-dev @playwright/test@^1.56 && npx playwright install chromium
```

Expected: `package.json` gains `@playwright/test`, and the browser is already cached or downloads.

In `app/package.json` `scripts`, add `"e2e": "playwright test"`.

Create `app/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

// Each worktree runs its own server on its own port (see the E2E port table in the
// master plan), so parallel tracks never test each other's code.
const PORT = Number(process.env.E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { VITE_MOCK: "1" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
```

Create the empty file `app/e2e/.gitkeep`.

- [ ] **Step 2: Write the failing contract test**

Create `app/tests/contracts.test.mts`:

```ts
// Run: npm test. Pins the frozen event-kind list (contract C1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_KINDS } from "../src/api/types.ts";

test("EVENT_KINDS includes the redesign kinds, in order, once each", () => {
  for (const k of ["plan_revised", "frame", "run_recap"]) assert.ok(EVENT_KINDS.includes(k as never), k);
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length);
});
```

Run: `cd app && npm test`
Expected: FAIL on `plan_revised`.

- [ ] **Step 3: Extend `types.ts`**

In `app/src/api/types.ts`:
1. Append every declaration from master-plan Contract C1 verbatim, starting at the `export type Provider` line.
2. Add to `interface Health`: `setup_complete: boolean;`, `plan_only: boolean;`, and `cua_driver_detail?: string;`.
3. Add to `interface StepResultPayload`: `actions?: number;` and `duration_ms?: number;`.
4. Change `DecisionBody.source` to `source: DecisionSource;`.
5. Add `revision?: number;` to `PlanResponse`, and widen `CostPayload.scope` to `"plan" | "score" | "run" | "recap" | "revise" | "setup"`.
6. Extend `EventKind` with `| "plan_revised" | "frame" | "run_recap"`, and append `"plan_revised", "frame", "run_recap"` to the end of `EVENT_KINDS`.

- [ ] **Step 4: Move `HttpError` and extend the client**

Create `app/src/api/errors.ts`:

```ts
export class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body?.error ?? `HTTP ${status}`));
  }
}
```

In `app/src/api/client.ts`:
1. Delete the `HttpError` class.
2. Add `import { HttpError } from "./errors";` and `export { HttpError } from "./errors";`.
3. Add the C1 types to the type import list.
4. Replace the `DaemonApi` interface with the existing members plus all C2 members. `createTask` takes the new signature.

In `createHttpDaemon`, replace `createTask` and add the new members after `stop`:

```ts
    createTask: (prompt, selectedApp = null, attachmentIds = []) =>
      request(base, "/task", json("POST", { prompt, selected_app: selectedApp, attachment_ids: attachmentIds })),
    listTasks: async () => (await request<{ tasks: TaskSummary[] }>(base, "/tasks")).tasks,
    getTask: (taskId) => request<TaskDetail>(base, `/task/${taskId}`),
    async uploadAttachment(file, name) {
      const fd = new FormData();
      fd.append("file", file, name);
      const res = await fetch(`${base}/attachments`, { method: "POST", body: fd });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text };
      }
      if (!res.ok) throw new HttpError(res.status, body);
      return body as unknown as Attachment;
    },
    attachmentUrl: (id) => `${base}/attachments/${id}`,
    repropose: (taskId, instruction) => request<PlanResponse>(base, `/task/${taskId}/repropose`, json("POST", { instruction })),
    editStep: (taskId, stepId, patch) => request<{ step: Step; scores: Score[] }>(base, `/task/${taskId}/step/${stepId}`, json("PATCH", patch)),
    frameUrl: (taskId, seq) => `${base}/task/${taskId}/frames/${seq}.jpg`,
    setupStatus: () => request<SetupStatus>(base, "/setup/status", { timeoutMs: 8000 }),
    setKey: (provider, key) => request(base, "/setup/key", json("PUT", { provider, key })),
    installDriver: () => request(base, "/setup/driver/install", json("POST", {})),
    startDriver: () => request(base, "/setup/driver/start", json("POST", {})),
    openPermission: (which) => request(base, "/setup/permissions/open", json("POST", { which })),
    selfTest: () => request(base, "/setup/self-test", json("POST", {})),
    completeSetup: () => request(base, "/setup/complete", json("POST", {})),
    getSettings: () => request<AppSettings>(base, "/settings"),
    putSettings: (patch) => request<AppSettings>(base, "/settings", json("PUT", patch)),
```

- [ ] **Step 5: Give the mock minimal working implementations (U8 deepens them)**

In `app/src/api/mock.ts`:
1. Import `HttpError` from `./errors` and `splitPairKey` from `../lib/approval`. Add the C1 types to the type import.
2. Extend `MockTask` with `createdAt: string; attachments: Attachment[]; runs: RunRecord[]; revision: number;`.
3. In `createMockDaemon`, add next to `tasks`:

```ts
  const blobs = new Map<string, { att: Attachment; url: string }>();
  const settings: AppSettings = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    plan_only: false,
    models: { anthropic: ["claude-sonnet-5-5", "claude-opus-5-5"], openai: ["gpt-5.5"] },
  };
```

4. In `health()`, add `setup_complete: true, plan_only: settings.plan_only,`.
5. Replace `createTask`:

```ts
    async createTask(prompt: string, _selectedApp?: string | null, attachmentIds: string[] = []) {
      if (attachmentIds.length > 4) throw new HttpError(400, { error: "at most 4 images per task" });
      const unknown = attachmentIds.filter((a) => !blobs.has(a));
      if (unknown.length) throw new HttpError(400, { error: "unknown attachment ids", unknown });
      const id = rid("tsk");
      tasks.set(id, {
        id, prompt, steps: [], scores: [], boundaries: {}, decisions: [], events: [],
        listeners: new Set(), stop: false, running: false,
        createdAt: new Date().toISOString(),
        attachments: attachmentIds.map((a) => blobs.get(a)!.att),
        runs: [], revision: 0,
      });
      return { task_id: id };
    },
```

6. In `run`, right before `void simulateRun(...)`, record the run:

```ts
      t.runs.push({ id: runId, task_id: t.id, status: "running", exec_mode: "simulated", approved: expected,
        removed: [...body.removed_step_ids], started_at: new Date().toISOString(), finished_at: null, final: null });
```

7. In `simulateRun`, replace the final `emit(t, "final_result", …)` call with code that builds the payload, stores it on the run record, then emits:

```ts
    const final = stopped
      ? { status: "stopped" as const, message: "Run stopped by the user. Remaining approved steps were not attempted.", attempted, completed }
      : { status: "completed" as const, message: "All approved steps were attempted.", attempted, completed };
    const rec = t.runs.find((r) => r.id === runId);
    if (rec) Object.assign(rec, { status: final.status, finished_at: new Date().toISOString(), final });
    emit(t, "final_result", final, runId);
```

8. Add the new members after `stop`:

```ts
    async listTasks() {
      return [...tasks.values()].reverse().map((t) => ({ id: t.id, prompt: t.prompt, created_at: t.createdAt, step_count: t.steps.length }));
    },
    async getTask(taskId: string) {
      const t = getTask(taskId);
      return {
        task: { id: t.id, prompt: t.prompt, selected_app: null, created_at: t.createdAt, mode: "fixtures", attachments: t.attachments },
        steps: t.steps.map((s) => ({ ...s })),
        scores: t.scores.map((s) => ({ ...s })),
        boundaries: Object.entries(t.boundaries).map(([k, polygon]) => {
          const [x_dim, y_dim] = splitPairKey(k);
          return { x_dim, y_dim, polygon };
        }),
        runs: t.runs.map((r) => ({ ...r })),
        cost_usd: costTotal,
      };
    },
    async uploadAttachment(file: Blob) {
      const mime = file.type as ImageMime;
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
        throw new HttpError(400, { error: `Unsupported image type ${file.type || "unknown"}. Use PNG, JPEG or WebP.` });
      if (file.size === 0) throw new HttpError(400, { error: "The file is empty." });
      if (file.size > 5 * 1024 * 1024) throw new HttpError(413, { error: "Images must be 5 MB or smaller." });
      const att: Attachment = { attachment_id: rid("att"), mime, bytes: file.size };
      blobs.set(att.attachment_id, { att, url: URL.createObjectURL(file) });
      return att;
    },
    attachmentUrl: (id: string) => blobs.get(id)?.url ?? "",
    async repropose(taskId: string, instruction: string | null) {
      const t = getTask(taskId);
      t.revision += 1;
      emit(t, "plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: t.steps.length });
      await sleep(400);
      emit(t, "plan_revised", { revision: t.revision, instruction, changed_step_ids: [], added_step_ids: [], dropped_step_ids: [] });
      emit(t, "plan_progress", { stage: "done", message: "Plan revised.", done: t.steps.length, total: t.steps.length });
      return { task_id: taskId, steps: t.steps.map((s) => ({ ...s })), scores: t.scores.map((s) => ({ ...s })), revision: t.revision };
    },
    async editStep(taskId: string, stepId: string, patch: { title?: string; description?: string }) {
      const t = getTask(taskId);
      const s = t.steps.find((x) => x.id === stepId);
      if (!s) throw new HttpError(404, { error: "step not found in task" });
      if (!patch.title?.trim() && !patch.description?.trim()) throw new HttpError(400, { error: "nothing to change" });
      s.edited_from = s.edited_from ?? s.title;
      if (patch.title?.trim()) s.title = patch.title.trim();
      if (patch.description?.trim()) s.description = patch.description.trim();
      return { step: { ...s }, scores: t.scores.filter((x) => x.step_id === stepId).map((x) => ({ ...x })) };
    },
    frameUrl: () => "",
    async setupStatus(): Promise<SetupStatus> {
      return {
        platform: "macos",
        key: { provider: settings.provider, present: true, source: "env", tested: true, warning: null },
        driver: { installed: true, version: "mock", running: true },
        permissions: { accessibility: "granted", screen_recording: "granted" },
        self_test: { passed_at: new Date().toISOString() },
        plan_only: settings.plan_only,
        complete: true,
      };
    },
    async setKey() { return { ok: true, error: null }; },
    async installDriver() { return { ok: true, version: "mock", log_tail: "" }; },
    async startDriver() { return { ok: true, error: null }; },
    async openPermission() { return { ok: true }; },
    async selfTest() { return { ok: true, detail: "mock self-test passed" }; },
    async completeSetup() { return { ok: true }; },
    async getSettings() { return { ...settings, models: { ...settings.models } }; },
    async putSettings(patch: Partial<Pick<AppSettings, "provider" | "model" | "plan_only">>) {
      Object.assign(settings, patch);
      return { ...settings, models: { ...settings.models } };
    },
```

- [ ] **Step 6: Add the Tauri bridge stubs**

Append to `app/src/lib/tauri.ts`:

```ts
export interface SupervisorStatus {
  state: "starting" | "running" | "restarting" | "failed" | "external";
  restarts: number;
  last_error: string | null;
}

/** Daemon supervisor status from the Rust shell. Null outside Tauri. (Track R1 implements.) */
export async function daemonStatus(): Promise<SupervisorStatus | null> {
  return null;
}

/** Last `lines` lines of daemon output captured by the shell. "" outside Tauri. (Track R1.) */
export async function daemonLogTail(_lines: number): Promise<string> {
  return "";
}
```

- [ ] **Step 7: Verify**

Run: `cd app && npm run typecheck && npm test`
Expected: typecheck clean, and every test passes (geometry tests plus `contracts.test.mts`).

- [ ] **Step 8: Commit**

```bash
git add app/package.json app/package-lock.json app/playwright.config.ts app/e2e/.gitkeep app/src/api app/src/lib/tauri.ts app/tests/contracts.test.mts
git commit -m "app: frozen API contracts (types, client, mock minimums, tauri stubs, playwright)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task W0-3: UI skeleton

Starts after W0-1 and W0-2 are merged.

**Files:**
- Create: `app/src/theme/tokens.css`, `app/src/theme/base.css`
- Create: `app/src/state/session.ts`, `app/src/state/useSession.ts`, `app/src/state/useDaemon.ts`, `app/src/screens.ts`
- Move (git mv): `app/src/components/{Header,OversightPanel,PlanPanel,ExecutionView,WhyThisMattered,BoundaryCanvas,Glyph}.tsx` → `app/src/paper/`; `app/src/styles.css` → `app/src/paper/paper.css`
- Create: `app/src/paper/PaperView.tsx`
- Create stubs: `app/src/shell/AppShell.tsx`, `shell/Splash.tsx`, `home/HomeScreen.tsx`, `home/Composer.tsx`, `chat/types.ts`, `chat/eventsToMessages.ts`, `chat/ChatThread.tsx`, `canvas/BoundaryCanvas.tsx`, `workspace/ReviewScreen.tsx`, `workspace/RunScreen.tsx`, `workspace/DeskView.tsx`, `setup/SetupWizard.tsx`
- Rewrite: `app/src/App.tsx`, `app/src/main.tsx`
- Test: `app/tests/session.test.mts`, `app/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: C1, C2, and C7 from W0-2.
- Produces: C5, C6 (as stubs with exact exports), and C8 (test ids used by the stubs).

- [ ] **Step 1: Theme**

Create `app/src/theme/tokens.css`:

```css
/* Graphite (spec: Decisions). Dark first, light follows the OS. Only global tokens live here. */
:root {
  color-scheme: dark;
  --bg: #141414;
  --surface: #1c1c1c;
  --raised: #262626;
  --line: #303030;
  --text: #ececec;
  --text-2: #a3a3a3;
  --text-3: #8f8f8f;
  --accent: #9d8cff;
  --accent-ink: #141414;
  --accent-soft: rgba(157, 140, 255, 0.16);
  --ok: #5fc48a;
  --ok-soft: rgba(95, 196, 138, 0.14);
  --pend: #e8a948;
  --pend-soft: rgba(232, 169, 72, 0.14);
  --rm: #e46a5c;
  --rm-soft: rgba(228, 106, 92, 0.14);
  --grid: #242424;
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-xl: 26px;
  --r-pill: 999px;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;
  --fs-lg: 15px;
  --fs-xl: 26px;
  --rail-w: 52px;
  --chat-w: 340px;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --dur: 140ms;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fafafa;
    --surface: #ffffff;
    --raised: #f0f0f0;
    --line: #e3e3e3;
    --text: #1a1a1a;
    --text-2: #5c5c5c;
    --text-3: #7a7a7a;
    --accent: #6e5bf0;
    --accent-ink: #ffffff;
    --accent-soft: rgba(110, 91, 240, 0.12);
    --ok: #23874e;
    --ok-soft: rgba(35, 135, 78, 0.12);
    --pend: #b8740c;
    --pend-soft: rgba(184, 116, 12, 0.12);
    --rm: #c2412f;
    --rm-soft: rgba(194, 65, 47, 0.12);
    --grid: #ececec;
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  }
}
```

Create `app/src/theme/base.css`:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
html,
body,
#root {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: var(--fs-md);
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
button,
input,
textarea,
select {
  font: inherit;
  color: inherit;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
::selection {
  background: var(--accent-soft);
}
```

- [ ] **Step 2: Move the old UI into `paper/` and scope its CSS**

```bash
cd app/src
mkdir -p paper
for f in Header OversightPanel PlanPanel ExecutionView WhyThisMattered BoundaryCanvas Glyph; do git mv components/$f.tsx paper/$f.tsx; done
git mv styles.css paper/paper.css
rmdir components
```

The relative imports inside the moved files (`../api/...`, `../lib/...`, `./Glyph`) stay valid, because `paper/` sits at the same depth as `components/`.

In `app/src/paper/paper.css`, replace everything from line 1 down to and including the `html.tauri body { … }` rule (the last line before `.mono {`) with:

```css
/* Paper view: the source-video replica (docs/02). Every global rule is scoped to
   .paper-root so it never touches the Graphite UI. Class rules below stay global
   but only Paper components use these class names (new UI uses CSS Modules). */

.paper-root {
  --approved: #3cc95b;
  --approved-soft: rgba(60, 201, 91, 0.16);
  --pending: #f2922f;
  --removed: #8d9499;
  --danger: #ef4b4b;
  --accent: #2f7cf6;
  --info: #5aa7ff;
  --muted-dot: #a0a7ad;
  --text: rgba(255, 255, 255, 0.92);
  --text-2: rgba(235, 242, 247, 0.66);
  --text-3: rgba(235, 242, 247, 0.46);
  --line: rgba(255, 255, 255, 0.1);
  --card: rgba(255, 255, 255, 0.055);
  --card-hi: rgba(255, 255, 255, 0.085);
  --bg-a: #22495a;
  --bg-b: #1e3a48;
  --bg-c: #2a5654;
  color-scheme: dark;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  height: 100%;
  background: radial-gradient(120% 90% at 85% 100%, var(--bg-c) 0%, transparent 60%),
    linear-gradient(160deg, var(--bg-a) 0%, var(--bg-b) 55%, #1c3540 100%);
  background-color: var(--bg-b);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}

html.tauri .paper-root {
  background: radial-gradient(120% 90% at 85% 100%, rgba(42, 86, 84, 0.55) 0%, transparent 60%),
    linear-gradient(160deg, rgba(34, 73, 90, 0.78) 0%, rgba(30, 58, 72, 0.82) 55%, rgba(28, 53, 64, 0.86) 100%);
}
```

- [ ] **Step 3: Write the failing session reducer tests**

Create `app/tests/session.test.mts`:

```ts
// Run: npm test. Pure reducer for the session layer (contract C5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialSession, sessionReducer, type SessionState } from "../src/state/session.ts";
import type { OversightEvent, Step, TaskDetail } from "../src/api/types.ts";

const step = (i: number, status: Step["status"] = "pending"): Step => ({
  id: `s${i}`, task_id: "t", index: i, title: `T${i}`, description: "d", glyph: "generic",
  status, edited_from: null, revision: 0,
});
const ev = (seq: number, kind: OversightEvent["kind"], run_id: string | null = null, payload = {}): OversightEvent => ({
  kind, task_id: "t", run_id, seq, ts: "2026-10-02T00:00:00Z", payload,
});
const review = (): SessionState =>
  sessionReducer(sessionReducer(initialSession, { type: "start_task", taskId: "t", prompt: "p", attachments: [] }),
    { type: "plan_loaded", steps: [step(2), step(1)], scores: [] });

test("start_task then plan_loaded: review with steps sorted by index", () => {
  const s = review();
  assert.equal(s.phase, "review");
  assert.deepEqual(s.steps.map((x) => x.id), ["s1", "s2"]);
});

test("event dedupe by seq, and final_result of the current run ends the run", () => {
  let s = sessionReducer(review(), { type: "run_started", run: { runId: "r1", approvedIds: ["s1"], removedIds: [] } });
  s = sessionReducer(s, { type: "event", event: ev(1, "step_started", "r1") });
  s = sessionReducer(s, { type: "event", event: ev(1, "step_started", "r1") });
  assert.equal(s.events.length, 1);
  s = sessionReducer(s, { type: "event", event: ev(2, "final_result", "r_other") });
  assert.equal(s.phase, "running");
  s = sessionReducer(s, { type: "event", event: ev(3, "final_result", "r1") });
  assert.equal(s.phase, "done");
});

test("remove clears checked; restore brings back pending; check_all skips removed", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "remove", stepId: "s1" });
  assert.ok(!s.checked.has("s1") && s.removed.has("s1"));
  s = sessionReducer(s, { type: "check_all" });
  assert.deepEqual([...s.checked], ["s2"]);
  s = sessionReducer(s, { type: "restore", stepId: "s1" });
  assert.ok(!s.removed.has("s1"));
});

test("plan_revised filters vanished ids and keeps polygons", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "remove", stepId: "s2" });
  s = sessionReducer(s, { type: "set_polygon", key: "a|b", polygon: [[0, 0], [1, 0], [1, 1]] });
  s = sessionReducer(s, { type: "select", stepId: "s2" });
  s = sessionReducer(s, { type: "plan_revised", steps: [step(1, "approved"), step(3)], scores: [] });
  assert.deepEqual([...s.checked], ["s1"]);
  assert.equal(s.removed.size, 0);
  assert.equal(s.selectedId, null);
  assert.ok(s.polygons["a|b"]);
});

test("plan_revised drops checks on steps the daemon reset; step_edited unchecks", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "check", stepId: "s2", on: true });
  s = sessionReducer(s, { type: "plan_revised", steps: [step(1, "approved"), step(2, "pending")], scores: [] });
  assert.deepEqual([...s.checked], ["s1"]);
  s = sessionReducer(s, { type: "step_edited", step: step(1, "pending"), scores: [] });
  assert.equal(s.checked.size, 0);
});

test("load_task maps a finished task to done with its run and boundaries", () => {
  const detail: TaskDetail = {
    task: { id: "t", prompt: "p", selected_app: null, created_at: "", mode: "live", attachments: [] },
    steps: [step(1, "approved"), step(2, "removed")],
    scores: [],
    boundaries: [{ x_dim: "a", y_dim: "b", polygon: [[0, 0], [1, 0], [1, 1]] }, { x_dim: "c", y_dim: "d", polygon: [] }],
    runs: [{ id: "r1", task_id: "t", status: "completed", exec_mode: "simulated", approved: ["s1"], removed: ["s2"], started_at: "", finished_at: "x", final: null }],
    cost_usd: 0,
  };
  const s = sessionReducer(initialSession, { type: "load_task", detail });
  assert.equal(s.phase, "done");
  assert.equal(s.run?.runId, "r1");
  assert.deepEqual(Object.keys(s.polygons), ["a|b"]);
  assert.ok(s.checked.has("s1") && s.removed.has("s2"));
});
```

Run: `cd app && npm test`
Expected: FAIL (`Cannot find module '../src/state/session.ts'`).

- [ ] **Step 4: Implement the pure reducer**

Create `app/src/state/session.ts`:

```ts
// The one source of truth for a task in the UI. Pure: no fetches, no value imports
// from relative modules (node --test runs this file directly).
import type { Attachment, OversightEvent, Point, Score, Step, TaskDetail } from "../api/types";

export type Phase = "home" | "planning" | "review" | "running" | "done";
export interface RunError { status: number; error: string; expected?: string[]; got?: string[] }
export interface RunInfo { runId: string; approvedIds: string[]; removedIds: string[] }
type PolygonMap = Record<string, Point[]>;

export interface SessionState {
  phase: Phase;
  taskId: string | null;
  prompt: string;
  attachments: Attachment[];
  steps: Step[];
  scores: Score[];
  axes: { x: string; y: string };
  polygons: PolygonMap;
  checked: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  selectedId: string | null;
  events: OversightEvent[];
  run: RunInfo | null;
  runError: RunError | null;
  planError: string | null;
  busy: "revising" | "starting_run" | null;
  notice: string | null;
}

export const DEFAULT_AXES = { x: "action_uncertainty", y: "reversibility" };
const EMPTY: ReadonlySet<string> = new Set();

export const initialSession: SessionState = {
  phase: "home",
  taskId: null,
  prompt: "",
  attachments: [],
  steps: [],
  scores: [],
  axes: DEFAULT_AXES,
  polygons: {},
  checked: EMPTY,
  removed: EMPTY,
  selectedId: null,
  events: [],
  run: null,
  runError: null,
  planError: null,
  busy: null,
  notice: null,
};

export type SessionAction =
  | { type: "reset" }
  | { type: "start_task"; taskId: string; prompt: string; attachments: Attachment[] }
  | { type: "plan_loaded"; steps: Step[]; scores: Score[] }
  | { type: "plan_failed"; error: string }
  | { type: "retry_plan" }
  | { type: "load_task"; detail: TaskDetail }
  | { type: "event"; event: OversightEvent }
  | { type: "set_axes"; x: string; y: string }
  | { type: "set_polygon"; key: string; polygon: Point[] | null }
  | { type: "check"; stepId: string; on: boolean }
  | { type: "remove"; stepId: string }
  | { type: "restore"; stepId: string }
  | { type: "check_all" }
  | { type: "select"; stepId: string | null }
  | { type: "busy"; busy: SessionState["busy"] }
  | { type: "plan_revised"; steps: Step[]; scores: Score[] }
  | { type: "step_edited"; step: Step; scores: Score[] }
  | { type: "run_started"; run: RunInfo }
  | { type: "run_failed"; error: RunError }
  | { type: "notice"; text: string | null };

const byIndex = (steps: Step[]) => [...steps].sort((a, b) => a.index - b.index);
const without = (set: ReadonlySet<string>, id: string) => {
  if (!set.has(id)) return set;
  const n = new Set(set);
  n.delete(id);
  return n;
};
const withId = (set: ReadonlySet<string>, id: string) => (set.has(id) ? set : new Set(set).add(id));
const keepIds = (set: ReadonlySet<string>, ids: Set<string>) => new Set([...set].filter((x) => ids.has(x)));

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "reset":
      return { ...initialSession, axes: s.axes };
    case "start_task":
      return { ...initialSession, axes: s.axes, phase: "planning", taskId: a.taskId, prompt: a.prompt, attachments: a.attachments };
    case "plan_loaded":
      return { ...s, phase: "review", steps: byIndex(a.steps), scores: a.scores, planError: null };
    case "plan_failed":
      return { ...s, planError: a.error };
    case "retry_plan":
      return { ...s, planError: null };
    case "load_task": {
      const d = a.detail;
      const steps = byIndex(d.steps);
      const polygons: PolygonMap = {};
      for (const b of d.boundaries) if (b.polygon.length >= 3) polygons[`${b.x_dim}|${b.y_dim}`] = b.polygon;
      const last = d.runs.length ? d.runs[d.runs.length - 1] : null;
      const run = last ? { runId: last.id, approvedIds: last.approved, removedIds: last.removed } : null;
      const phase: Phase = last ? (last.finished_at ? "done" : "running") : steps.length ? "review" : "planning";
      return {
        ...initialSession,
        axes: s.axes,
        phase,
        taskId: d.task.id,
        prompt: d.task.prompt,
        attachments: d.task.attachments ?? [],
        steps,
        scores: d.scores,
        polygons,
        checked: new Set(steps.filter((x) => x.status === "approved").map((x) => x.id)),
        removed: new Set(steps.filter((x) => x.status === "removed").map((x) => x.id)),
        run,
        planError: steps.length ? null : "This task has no plan yet.",
      };
    }
    case "event": {
      const last = s.events[s.events.length - 1];
      if (last && last.seq >= a.event.seq) return s;
      const events = [...s.events, a.event];
      const ended = a.event.kind === "final_result" && s.run !== null && a.event.run_id === s.run.runId;
      return { ...s, events, phase: ended ? "done" : s.phase };
    }
    case "set_axes":
      return { ...s, axes: { x: a.x, y: a.y } };
    case "set_polygon": {
      const polygons = { ...s.polygons };
      if (a.polygon && a.polygon.length) polygons[a.key] = a.polygon;
      else delete polygons[a.key];
      return { ...s, polygons };
    }
    case "check":
      return { ...s, checked: a.on ? withId(s.checked, a.stepId) : without(s.checked, a.stepId), runError: null };
    case "remove":
      return { ...s, removed: withId(s.removed, a.stepId), checked: without(s.checked, a.stepId), runError: null };
    case "restore":
      return { ...s, removed: without(s.removed, a.stepId) };
    case "check_all":
      return { ...s, checked: new Set(s.steps.filter((x) => !s.removed.has(x.id)).map((x) => x.id)), runError: null };
    case "select":
      return { ...s, selectedId: a.stepId };
    case "busy":
      return { ...s, busy: a.busy };
    case "plan_revised": {
      // The daemon resets rewritten steps to pending and keeps statuses of unchanged ones,
      // so trust its statuses: a check survives only on a step it still has approved.
      const ids = new Set(a.steps.map((x) => x.id));
      const approved = new Set(a.steps.filter((x) => x.status === "approved").map((x) => x.id));
      const removedNow = new Set(a.steps.filter((x) => x.status === "removed").map((x) => x.id));
      return {
        ...s,
        phase: "review",
        steps: byIndex(a.steps),
        scores: a.scores,
        checked: keepIds(s.checked, approved),
        removed: keepIds(s.removed, removedNow),
        selectedId: s.selectedId && ids.has(s.selectedId) ? s.selectedId : null,
        busy: null,
        planError: null,
      };
    }
    case "step_edited":
      // An edited step is re-scored and pending again on the daemon: uncheck it here too.
      return {
        ...s,
        checked: without(s.checked, a.step.id),
        steps: s.steps.map((x) => (x.id === a.step.id ? a.step : x)),
        scores: [...s.scores.filter((x) => x.step_id !== a.step.id), ...a.scores],
      };
    case "run_started":
      return { ...s, phase: "running", run: a.run, busy: null, runError: null };
    case "run_failed":
      return { ...s, runError: a.error, busy: null };
    case "notice":
      return { ...s, notice: a.text };
  }
}
```

Run: `cd app && npm test`
Expected: all pass.

- [ ] **Step 5: Implement `useDaemon` and `useSession`**

Create `app/src/state/useDaemon.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectDaemon, type DaemonApi } from "../api/client";
import type { Dimension, Health } from "../api/types";

export interface DaemonConn {
  api: DaemonApi | null;
  health: Health | null;
  reachable: boolean;
  dims: Dimension[];
  refreshHealth(): Promise<void>;
}

export function useDaemon(): DaemonConn {
  const [api, setApi] = useState<DaemonApi | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState(true);
  const [dims, setDims] = useState<Dimension[]>([]);

  useEffect(() => {
    let alive = true;
    void connectDaemon().then((a) => alive && setApi(a));
    return () => {
      alive = false;
    };
  }, []);

  const refreshHealth = useCallback(async () => {
    if (!api) return;
    try {
      setHealth(await api.health());
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 5000);
    return () => clearInterval(t);
  }, [api, refreshHealth]);

  // Load (and after an outage, re-load) the ten dimensions.
  useEffect(() => {
    if (!api || dims.length || !reachable) return;
    api.dimensions().then(setDims, () => undefined);
  }, [api, dims.length, reachable, health]);

  return useMemo(() => ({ api, health, reachable, dims, refreshHealth }), [api, health, reachable, dims, refreshHealth]);
}
```

Create `app/src/state/useSession.ts`:

```ts
// Every daemon call the screens make goes through here (the daemon owns logic;
// screens render and capture gestures). Actions are stable for the session's life.
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { DaemonApi } from "../api/client";
import type { Attachment, DecisionAction, DecisionSource, Point, RunBody } from "../api/types";
import { classify, indexScores, pairKey, splitPairKey, type Classification, type ScoreIndex } from "../lib/approval";
import { initialSession, sessionReducer, type SessionState } from "./session";

export interface Counts { approved: number; pending: number; removed: number }

export interface SessionActions {
  submit(prompt: string, attachments: Attachment[]): Promise<void>;
  retryPlan(): Promise<void>;
  revise(instruction: string): Promise<void>;
  editStep(stepId: string, patch: { title?: string; description?: string }): Promise<void>;
  check(stepId: string, on: boolean, source?: DecisionSource): void;
  remove(stepId: string, source?: DecisionSource): void;
  restore(stepId: string): void;
  approveAll(): void;
  select(stepId: string | null): void;
  setAxes(x: string, y: string): void;
  onPolygonChange(poly: Point[] | null, final: boolean): void;
  run(): Promise<void>;
  skipUndecidedAndRun(): Promise<void>;
  stop(): Promise<void>;
  newTask(): void;
  openTask(taskId: string): Promise<void>;
  dismissNotice(): void;
}

export interface Session {
  state: SessionState;
  cls: Classification;
  counts: Counts;
  idx: ScoreIndex;
  canRun: boolean;
  actions: SessionActions;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useSession(api: DaemonApi | null): Session {
  const [state, dispatch] = useReducer(sessionReducer, initialSession);
  const ref = useRef(state);
  ref.current = state;
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!api || !state.taskId) return;
    return api.subscribe(state.taskId, 0, (event) => dispatch({ type: "event", event }));
  }, [api, state.taskId]);

  const idx = useMemo(() => indexScores(state.scores), [state.scores]);
  const raw = useMemo(
    () => classify(state.steps, idx, state.polygons, state.checked, state.removed),
    [state.steps, idx, state.polygons, state.checked, state.removed],
  );
  // Keep identity while the result is unchanged so lists don't re-render on every pointermove.
  const stable = useRef({ cls: raw, steps: state.steps });
  if (stable.current.steps !== state.steps || stable.current.cls.signature !== raw.signature) stable.current = { cls: raw, steps: state.steps };
  const cls = stable.current.cls;
  const clsRef = useRef(cls);
  clsRef.current = cls;
  const counts = useMemo(() => ({ approved: cls.approved, pending: cls.pending, removed: cls.removed }), [cls]);
  const canRun = state.phase === "review" && state.steps.length > 0 && cls.pending === 0 && cls.approved > 0 && state.busy === null;

  const actions = useMemo<SessionActions>(() => {
    const notice = (text: string) => dispatch({ type: "notice", text });
    const putTimers: Record<string, ReturnType<typeof setTimeout>> = {};

    const decide = (stepId: string, action: DecisionAction, source: DecisionSource): Promise<void> => {
      const a = apiRef.current;
      const t = ref.current.taskId;
      if (!a || !t) return Promise.resolve();
      return a.decision(t, { step_id: stepId, action, source }).then(
        () => undefined,
        (e) => notice(`Saving your decision failed: ${msg(e)}`),
      );
    };

    const planNow = async (taskId: string) => {
      const a = apiRef.current;
      if (!a) return;
      await new Promise((r) => setTimeout(r, 30)); // let the SSE subscription attach first
      try {
        const plan = await a.plan(taskId);
        if (ref.current.taskId === taskId) dispatch({ type: "plan_loaded", steps: plan.steps, scores: plan.scores });
      } catch (e) {
        if (ref.current.taskId === taskId) dispatch({ type: "plan_failed", error: `Planning failed: ${msg(e)}` });
      }
    };

    const startRun = async (removed: ReadonlySet<string>, c: Classification) => {
      const s = ref.current;
      const a = apiRef.current;
      if (!a || !s.taskId) return;
      const approved = s.steps.filter((st) => !removed.has(st.id) && c.status[st.id] === "approved").map((st) => st.id);
      if (!approved.length) return notice("Nothing is approved yet.");
      const body: RunBody = {
        approved_step_ids: approved,
        checked_step_ids: [...s.checked].filter((id) => !removed.has(id)),
        removed_step_ids: [...removed],
        boundaries: Object.entries(s.polygons)
          .filter(([, p]) => p.length >= 3)
          .map(([k, polygon]) => {
            const [x_dim, y_dim] = splitPairKey(k);
            return { x_dim, y_dim, polygon };
          }),
      };
      dispatch({ type: "busy", busy: "starting_run" });
      const r = await a.run(s.taskId, body);
      if (r.ok) dispatch({ type: "run_started", run: { runId: r.run_id, approvedIds: approved, removedIds: body.removed_step_ids } });
      else dispatch({ type: "run_failed", error: { status: r.status, error: r.error, expected: r.expected, got: r.got } });
    };

    return {
      async submit(prompt, attachments) {
        const a = apiRef.current;
        const text = prompt.trim();
        if (!a || !text) return;
        try {
          const { task_id } = await a.createTask(text, null, attachments.map((x) => x.attachment_id));
          dispatch({ type: "start_task", taskId: task_id, prompt: text, attachments });
          await planNow(task_id);
        } catch (e) {
          notice(`Couldn't start the task: ${msg(e)}`);
        }
      },
      async retryPlan() {
        const t = ref.current.taskId;
        if (!t) return;
        dispatch({ type: "retry_plan" });
        await planNow(t);
      },
      async revise(instruction) {
        const a = apiRef.current;
        const t = ref.current.taskId;
        if (!a || !t || !instruction.trim()) return;
        dispatch({ type: "busy", busy: "revising" });
        try {
          const p = await a.repropose(t, instruction.trim());
          dispatch({ type: "plan_revised", steps: p.steps, scores: p.scores });
        } catch (e) {
          dispatch({ type: "busy", busy: null });
          notice(`Revising the plan failed: ${msg(e)}`);
        }
      },
      async editStep(stepId, patch) {
        const a = apiRef.current;
        const t = ref.current.taskId;
        if (!a || !t) return;
        try {
          const r = await a.editStep(t, stepId, patch);
          dispatch({ type: "step_edited", step: r.step, scores: r.scores });
        } catch (e) {
          notice(`Editing the step failed: ${msg(e)}`);
        }
      },
      check(stepId, on, source = "step_list") {
        dispatch({ type: "check", stepId, on });
        void decide(stepId, on ? "check" : "uncheck", source);
      },
      remove(stepId, source = "step_list") {
        dispatch({ type: "remove", stepId });
        void decide(stepId, "remove", source);
      },
      restore(stepId) {
        dispatch({ type: "restore", stepId });
        void decide(stepId, "restore", "step_list");
      },
      approveAll() {
        const s = ref.current;
        const todo = s.steps.filter((x) => !s.removed.has(x.id) && !s.checked.has(x.id));
        dispatch({ type: "check_all" });
        todo.forEach((x) => void decide(x.id, "check", "step_list"));
      },
      select(stepId) {
        dispatch({ type: "select", stepId });
      },
      setAxes(x, y) {
        dispatch({ type: "set_axes", x, y });
      },
      onPolygonChange(poly, final) {
        const k = pairKey(ref.current.axes.x, ref.current.axes.y);
        dispatch({ type: "set_polygon", key: k, polygon: poly });
        if (!final) return;
        clearTimeout(putTimers[k]);
        putTimers[k] = setTimeout(() => {
          const a = apiRef.current;
          const t = ref.current.taskId;
          if (!a || !t) return;
          const [x_dim, y_dim] = splitPairKey(k);
          a.putBoundary(t, { x_dim, y_dim, polygon: poly && poly.length >= 3 ? poly : [] }).catch((e) =>
            notice(`Saving the boundary failed: ${msg(e)}`),
          );
        }, 250);
      },
      async run() {
        const s = ref.current;
        const c = clsRef.current;
        if (s.phase !== "review" || c.pending > 0 || s.busy) return;
        await startRun(s.removed, c);
      },
      async skipUndecidedAndRun() {
        const s = ref.current;
        const c = clsRef.current;
        if (s.phase !== "review" || s.busy) return;
        const pending = s.steps.filter((st) => c.status[st.id] === "pending").map((st) => st.id);
        pending.forEach((id) => dispatch({ type: "remove", stepId: id }));
        await Promise.all(pending.map((id) => decide(id, "remove", "skip_undecided")));
        await startRun(new Set([...s.removed, ...pending]), c);
      },
      async stop() {
        const a = apiRef.current;
        const t = ref.current.taskId;
        if (!a || !t) return;
        try {
          await a.stop(t);
        } catch (e) {
          notice(`Stopping failed: ${msg(e)}`);
        }
      },
      newTask() {
        Object.values(putTimers).forEach(clearTimeout);
        dispatch({ type: "reset" });
      },
      async openTask(taskId) {
        const a = apiRef.current;
        if (!a) return;
        try {
          dispatch({ type: "load_task", detail: await a.getTask(taskId) });
        } catch (e) {
          notice(`Couldn't open that task: ${msg(e)}`);
        }
      },
      dismissNotice() {
        dispatch({ type: "notice", text: null });
      },
    };
  }, []);

  return useMemo(() => ({ state, cls, counts, idx, canRun, actions }), [state, cls, counts, idx, canRun, actions]);
}
```

Create `app/src/screens.ts`:

```ts
import type { DaemonApi } from "./api/client";
import type { DaemonConn } from "./state/useDaemon";
import type { Session } from "./state/useSession";

export type SetupStepKey = "welcome" | "key" | "driver" | "permissions" | "selftest";

export interface ScreenProps {
  api: DaemonApi;
  conn: DaemonConn;
  session: Session;
  openSetup: (step?: SetupStepKey) => void;
  paperView: boolean;
  setPaperView: (on: boolean) => void;
}
```

- [ ] **Step 6: Create the stubs (exact exports from C6, test ids from C8)**

Each stub begins with the comment `// Wave 0 stub. Track <ID> replaces this file; keep the exports and data-testids.`

`app/src/chat/types.ts`: copy the `ChatMessage` and `ChatInput` declarations from master C6 verbatim, with these imports:

```ts
import type { Attachment, FinalResultPayload, OversightEvent, RunRecapPayload, Step } from "../api/types";
```

`app/src/chat/eventsToMessages.ts` (track U2):

```ts
import type { FinalResultPayload } from "../api/types";
import type { ChatInput, ChatMessage } from "./types";

export function eventsToMessages(input: ChatInput): ChatMessage[] {
  const out: ChatMessage[] = [{ kind: "user", id: "user", text: input.prompt, attachments: input.attachments }];
  if (input.planError) out.push({ kind: "plan_error", id: "plan-error", error: input.planError });
  for (const ev of input.events) {
    if (ev.kind !== "final_result") continue;
    const f = ev.payload as unknown as FinalResultPayload;
    out.push({ kind: "recap", id: `recap-${ev.seq}`, recap: { headline: f.message, done: [], skipped: [], source: "fallback" }, final: f, costUsd: 0, actions: 0, durationMs: null });
  }
  return out;
}
```

`app/src/chat/ChatThread.tsx` (track U2):

```tsx
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { Counts } from "../state/useSession";
import type { ChatMessage } from "./types";

export interface ChatThreadProps {
  api: DaemonApi;
  messages: ChatMessage[];
  counts: Counts | null;
  meta: string | null;
  events: OversightEvent[];
  steps: Step[];
  onRetryPlan?: () => void;
}

export function ChatThread({ messages, onRetryPlan }: ChatThreadProps) {
  return (
    <div data-testid="chat-thread" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, overflow: "auto" }}>
      {messages.map((m) =>
        m.kind === "user" ? (
          <div key={m.id} data-testid="chat-msg-user">{m.text}</div>
        ) : m.kind === "recap" ? (
          <div key={m.id} data-testid="chat-recap">{m.recap.headline}</div>
        ) : m.kind === "plan_error" ? (
          <div key={m.id} data-testid="chat-plan-error">
            {m.error} {onRetryPlan && <button data-testid="chat-retry" onClick={onRetryPlan}>Try again</button>}
          </div>
        ) : null,
      )}
    </div>
  );
}
```

`app/src/home/Composer.tsx` (track U1). Copy `ComposerProps` from C6 verbatim, then:

```tsx
export function Composer(p: ComposerProps) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 12 }}>
      <textarea
        data-testid="composer-input"
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !p.disabledReason && !p.running) {
            e.preventDefault();
            p.onSend();
          }
        }}
        style={{ flex: 1 }}
      />
      {p.running ? (
        <button data-testid="composer-stop" onClick={p.onStop}>Stop</button>
      ) : (
        <button data-testid="composer-send" disabled={!!p.disabledReason || !p.value.trim()} onClick={p.onSend}>Send</button>
      )}
    </div>
  );
}
```

with imports `import type { DaemonApi } from "../api/client"; import type { Attachment } from "../api/types";`.

`app/src/home/HomeScreen.tsx` (track U1):

```tsx
import { useState } from "react";
import type { Attachment } from "../api/types";
import type { ScreenProps } from "../screens";
import { Composer } from "./Composer";

export function HomeScreen({ api, session }: ScreenProps) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div style={{ width: 640 }}>
        <h1>What should the agent do?</h1>
        <Composer api={api} value={text} onChange={setText} attachments={atts} onAttachmentsChange={setAtts} allowAttachments
          providerLabel="Anthropic" placeholder="Describe a task…" size="hero" disabledReason={null} running={false}
          onSend={() => void session.actions.submit(text, atts)} />
      </div>
    </div>
  );
}
```

`app/src/shell/AppShell.tsx` (track U1):

```tsx
import type { ReactNode } from "react";
import type { ScreenProps } from "../screens";

export function AppShell({ session, children }: ScreenProps & { children: ReactNode }) {
  const { state, actions } = session;
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <nav style={{ width: "var(--rail-w)", borderRight: "1px solid var(--line)" }}>
        <button data-testid="new-task" onClick={actions.newTask}>+</button>
      </nav>
      <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {state.notice && (
          <div data-testid="notice">
            {state.notice} <button data-testid="notice-dismiss" onClick={actions.dismissNotice}>Dismiss</button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
```

`app/src/shell/Splash.tsx` (track U1):

```tsx
import type { DaemonConn } from "../state/useDaemon";

export function Splash(_props: { conn: DaemonConn }) {
  return <div data-testid="splash" style={{ display: "grid", placeItems: "center", height: "100%" }}>Starting…</div>;
}
```

`app/src/canvas/BoundaryCanvas.tsx` (track U3). Copy `BoundaryCanvasProps` from C6 verbatim, then:

```tsx
import { memo } from "react";
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import { BoundaryCanvas as PaperCanvas } from "../paper/BoundaryCanvas";

// Wave 0 adapter: renders the Paper canvas (scoped styles) until track U3 replaces this file.
export const BoundaryCanvas = memo(function BoundaryCanvas(p: BoundaryCanvasProps) {
  return (
    <div className="paper-root" style={{ height: "100%", background: "transparent" }}>
      <PaperCanvas steps={p.steps} idx={p.idx} xDim={p.xDim} yDim={p.yDim} polygon={p.polygon} status={p.status}
        selectedId={p.selectedId} onSelect={p.onSelect} onPolygonChange={p.onPolygonChange} />
    </div>
  );
});
```

Also add `import "../paper/paper.css";` at the top of this adapter.

`app/src/workspace/ReviewScreen.tsx` (track U4):

```tsx
import { useMemo } from "react";
import { BoundaryCanvas } from "../canvas/BoundaryCanvas";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { pairKey } from "../lib/approval";
import type { ScreenProps } from "../screens";

export function ReviewScreen({ api, conn, session }: ScreenProps) {
  const { state, cls, counts, idx, canRun, actions } = session;
  const xDim = conn.dims.find((d) => d.key === state.axes.x);
  const yDim = conn.dims.find((d) => d.key === state.axes.y);
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: state.planError }),
    [state.prompt, state.attachments, state.steps, state.events, state.planError],
  );
  const live = state.steps.length - counts.removed;
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ width: "var(--chat-w)", borderRight: "1px solid var(--line)" }}>
        <ChatThread api={api} messages={messages} counts={counts} meta={null} events={state.events} steps={state.steps} onRetryPlan={() => void actions.retryPlan()} />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ flex: 1, minHeight: 300 }}>
          {state.phase === "review" && xDim && yDim && (
            <BoundaryCanvas steps={state.steps} idx={idx} xDim={xDim} yDim={yDim}
              polygon={state.polygons[pairKey(state.axes.x, state.axes.y)] ?? null} status={cls.status}
              selectedId={state.selectedId} hoveredId={null} onSelect={actions.select} onHover={() => undefined}
              onPolygonChange={actions.onPolygonChange} onApprove={(id) => actions.check(id, true, "fan_out")}
              onRemove={(id) => actions.remove(id, "fan_out")} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: 12 }}>
          <button data-testid="approve-all" onClick={actions.approveAll}>Approve all {live}</button>
          <button data-testid="run-primary" disabled={!canRun} onClick={() => void actions.run()}>Approve &amp; run</button>
        </div>
      </div>
    </div>
  );
}
```

`app/src/workspace/RunScreen.tsx` (track U5):

```tsx
import { useMemo } from "react";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import type { ScreenProps } from "../screens";

export function RunScreen({ api, session }: ScreenProps) {
  const { state, actions } = session;
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: null }),
    [state.prompt, state.attachments, state.steps, state.events],
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatThread api={api} messages={messages} counts={null} meta={null} events={state.events} steps={state.steps} />
      {state.phase === "running" && <button data-testid="composer-stop" onClick={() => void actions.stop()}>Stop</button>}
    </div>
  );
}
```

`app/src/workspace/DeskView.tsx` (track U5):

```tsx
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { RunInfo } from "../state/session";

export function DeskView(_p: { api: DaemonApi; taskId: string; events: OversightEvent[]; steps: Step[]; run: RunInfo }) {
  return <div data-testid="desk-view">Agent's desk</div>;
}
```

`app/src/setup/SetupWizard.tsx` (track U6):

```tsx
import type { DaemonApi } from "../api/client";
import type { SetupStepKey } from "../screens";

export function SetupWizard({ api, onClose }: { api: DaemonApi; initialStep?: SetupStepKey; onClose: () => void }) {
  return (
    <div data-testid="setup-wizard" style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <button data-testid="setup-done" onClick={() => void api.completeSetup().then(onClose)}>Finish setup</button>
    </div>
  );
}
```

- [ ] **Step 7: PaperView (the old App, on the shared session)**

Create `app/src/paper/PaperView.tsx`:

```tsx
// Paper view: the source-video layout (docs/02) on the shared session store.
import { useMemo, useState } from "react";
import { DEFAULT_TASK } from "../api/fixtures";
import type { CostPayload, PlanProgressPayload } from "../api/types";
import type { ScreenProps } from "../screens";
import { ExecutionView } from "./ExecutionView";
import { Icon } from "./Glyph";
import { Header, Tabs, TaskCard } from "./Header";
import { OversightPanel } from "./OversightPanel";
import { PlanPanel } from "./PlanPanel";
import "./paper.css";

export function PaperView({ api, conn, session, setPaperView }: ScreenProps) {
  const { state, cls, counts, idx, canRun, actions } = session;
  const [draft, setDraft] = useState(DEFAULT_TASK);
  const [stopping, setStopping] = useState(false);

  const planProgress = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "plan_progress") return state.events[i].payload as unknown as PlanProgressPayload;
    return null;
  }, [state.events]);
  const cost = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "cost") return (state.events[i].payload as unknown as CostPayload).usd_total;
    return conn.health?.cost_usd_total ?? 0;
  }, [state.events, conn.health]);

  const phase = state.phase === "home" ? "idle" : state.phase === "planning" ? "planning" : "review";
  const indexOf = (id: string) => state.steps.find((s) => s.id === id)?.index ?? id;
  const runErr = state.runError;

  return (
    <div className="paper-root">
      <div className={`app${api.mode === "mock" ? " is-mock" : ""}`}>
        <button className="link-btn" data-testid="paper-exit" style={{ position: "absolute", top: 12, right: 16 }} onClick={() => setPaperView(false)}>
          Exit Paper view
        </button>
        <Header health={conn.health} mode={api.mode} reachable={conn.reachable} cost={cost} />
        {state.notice && (
          <div className="notice" role="status">
            {state.notice}
            <button className="link-btn" onClick={actions.dismissNotice}>Dismiss</button>
          </div>
        )}
        {(state.phase === "running" || state.phase === "done") && state.run ? (
          <div className="exec-scroll">
            <ExecutionView steps={state.steps} approvedIds={state.run.approvedIds} removedIds={state.run.removedIds} runId={state.run.runId}
              events={state.events} idx={idx} dims={conn.dims}
              onStop={() => { setStopping(true); void actions.stop(); }}
              onNewTask={() => { setStopping(false); actions.newTask(); }} stopping={stopping} />
          </div>
        ) : (
          <>
            <div className="top">
              <Tabs />
              <TaskCard prompt={state.phase === "home" ? draft : state.prompt} setPrompt={setDraft} editable={state.phase === "home"}
                phase={phase} progress={planProgress} error={state.planError} onGenerate={() => void actions.submit(draft, [])} />
            </div>
            {state.phase === "review" && conn.dims.length > 0 && (
              <>
                <main className="columns">
                  <div className="col col-left">
                    <OversightPanel dims={conn.dims} steps={state.steps} idx={idx} xKey={state.axes.x} yKey={state.axes.y}
                      setAxes={actions.setAxes} polygons={state.polygons} status={cls.status} counts={counts}
                      selectedId={state.selectedId} onSelect={actions.select} onPolygonChange={actions.onPolygonChange} />
                  </div>
                  <div className="col col-right">
                    <PlanPanel steps={state.steps} status={cls.status} checked={state.checked} inside={cls.inside}
                      selectedId={state.selectedId} onSelect={actions.select}
                      onCheck={(id, on) => actions.check(id, on, "plan_panel")} onRemove={(id) => actions.remove(id, "plan_panel")}
                      onRestore={actions.restore} onSelectAll={actions.approveAll} />
                  </div>
                </main>
                <footer className="footer">
                  {runErr && (
                    <div className="run-error" role="alert" data-testid="run-error">
                      <b>{runErr.status === 409 ? "409 Conflict, nothing ran." : `Run failed (${runErr.status || "network"}).`}</b> {runErr.error}
                      {runErr.expected && (
                        <span className="mono"> expected [{runErr.expected.map(indexOf).join(", ")}] got [{(runErr.got ?? []).map(indexOf).join(", ")}]</span>
                      )}
                    </div>
                  )}
                  <div className="footer-row">
                    <button className="btn" data-testid="start-over" onClick={actions.newTask}>Start over</button>
                    <div className="footer-right">
                      <button className="btn" disabled data-testid="repropose">{Icon.refresh(13)} Re-propose plan</button>
                      <button className="btn btn-primary" data-testid="approve-run" disabled={!canRun} onClick={() => void actions.run()}>
                        {Icon.play(11)} {state.busy === "starting_run" ? "Starting..." : "Approve & Run"}
                      </button>
                    </div>
                  </div>
                  {!canRun && <div className="hint">Select all actions (draw a region or check them) to enable Approve &amp; Run.</div>}
                </footer>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

If `ExecutionView` or `PlanPanel` prop names differ from what this file passes, the typecheck in Step 9 shows it. Match the props those components already declare. Don't change the components.

- [ ] **Step 8: App and main**

Replace `app/src/App.tsx` entirely:

```tsx
import { useEffect, useState } from "react";
import { setAlwaysOnTop } from "./lib/tauri";
import { HomeScreen } from "./home/HomeScreen";
import { PaperView } from "./paper/PaperView";
import type { ScreenProps, SetupStepKey } from "./screens";
import { SetupWizard } from "./setup/SetupWizard";
import { AppShell } from "./shell/AppShell";
import { Splash } from "./shell/Splash";
import { useDaemon } from "./state/useDaemon";
import { useSession } from "./state/useSession";
import { ReviewScreen } from "./workspace/ReviewScreen";
import { RunScreen } from "./workspace/RunScreen";

export default function App() {
  const conn = useDaemon();
  const session = useSession(conn.api);
  const [paperView, setPaperView] = useState(() => new URLSearchParams(location.search).has("paper"));
  const [setupOpen, setSetupOpen] = useState<{ step?: SetupStepKey } | null>(null);
  const phase = session.state.phase;

  // Float above the agent's desk while it works (Tauri only, guarded).
  useEffect(() => {
    void setAlwaysOnTop(phase === "running");
  }, [phase]);

  if (!conn.api) return <Splash conn={conn} />;
  const needsSetup = conn.health !== null && !conn.health.setup_complete;
  if (setupOpen || needsSetup) {
    return (
      <SetupWizard api={conn.api} initialStep={setupOpen?.step}
        onClose={() => { setSetupOpen(null); void conn.refreshHealth(); }} />
    );
  }
  const props: ScreenProps = {
    api: conn.api, conn, session, paperView, setPaperView,
    openSetup: (step) => setSetupOpen({ step }),
  };
  if (paperView) return <PaperView {...props} />;
  const screen = phase === "home" ? <HomeScreen {...props} /> : phase === "running" || phase === "done" ? <RunScreen {...props} /> : <ReviewScreen {...props} />;
  return <AppShell {...props}>{screen}</AppShell>;
}
```

Replace `app/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/tauri";
import "./theme/tokens.css";
import "./theme/base.css";

if (isTauri()) document.documentElement.classList.add("tauri");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 9: Typecheck and unit tests**

Run: `cd app && npm run typecheck && npm test`
Expected: clean. Fix only the files this task created or moved.

- [ ] **Step 10: Write the smoke e2e and run it**

Create `app/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// The whole spine on the mock daemon. Every Wave 1 track keeps this green.
test("home → plan → approve all → run → recap", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 45_000 });
});

test("paper view still runs the source flow", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Select All" }).click();
  await page.getByTestId("approve-run").click();
  await expect(page.getByText("All approved steps were attempted.")).toBeVisible({ timeout: 45_000 });
});
```

Run: `cd app && E2E_PORT=1430 npx playwright test e2e/smoke.spec.ts`
Expected: `2 passed`.

- [ ] **Step 11: Commit**

```bash
git add -A app/src app/tests/session.test.mts app/e2e/smoke.spec.ts
git commit -m "app: skeleton (graphite theme, session layer, screen stubs, paper view moved)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

**Wave 0 exit check (orchestrator, on `ui-redesign` after merging all three):**
1. `cd daemon && uv run pytest -q`
2. `cd app && npm run typecheck && npm test && E2E_PORT=1430 npx playwright test`

All green. Then create the Wave 1 worktrees.
