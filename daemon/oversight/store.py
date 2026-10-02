"""SQLite store. Everything is persisted and replayable via GET /task/{id}."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    selected_app TEXT,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'live'
);
CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    glyph TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    edited_from TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    app_name TEXT,
    app_bundle TEXT
);
CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id, idx);
CREATE TABLE IF NOT EXISTS scores (
    step_id TEXT NOT NULL REFERENCES steps(id),
    dimension TEXT NOT NULL,
    label TEXT NOT NULL,
    position REAL NOT NULL,
    confidence REAL NOT NULL,
    rationale TEXT NOT NULL,
    PRIMARY KEY (step_id, dimension)
);
CREATE TABLE IF NOT EXISTS score_cache (
    hash TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    verdicts TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boundaries (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    name TEXT,
    x_dim TEXT NOT NULL,
    y_dim TEXT NOT NULL,
    polygon TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS boundaries_pair ON boundaries(task_id, x_dim, y_dim);
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    action TEXT NOT NULL,
    source TEXT NOT NULL,
    run_id TEXT,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    exec_mode TEXT NOT NULL,
    approved TEXT NOT NULL,
    removed TEXT NOT NULL,
    boundaries TEXT NOT NULL,
    final TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    ts TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    run_id TEXT,
    scope TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    usd REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
);
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
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _app_cols(app: Any) -> tuple[str | None, str | None]:
    """A step's app as (app_name, app_bundle); None means the agent's browser."""
    if isinstance(app, dict) and app.get("bundle_id"):
        return str(app.get("name") or app["bundle_id"]), str(app["bundle_id"])
    return None, None


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Add columns newer than an existing DB (CREATE TABLE IF NOT EXISTS skips them)."""
        with self._lock:
            have = {r["name"] for r in self.db.execute("PRAGMA table_info(steps)")}
            for col in ("app_name", "app_bundle"):
                if col not in have:
                    self.db.execute(f"ALTER TABLE steps ADD COLUMN {col} TEXT")

    def _q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.db.execute(sql, args).fetchall()

    def _x(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self.db.execute(sql, args)

    # ------------------------------------------------------------ tasks
    def create_task(self, prompt: str, selected_app: str | None, mode: str) -> str:
        tid = new_id("tsk")
        self._x("INSERT INTO tasks (id, prompt, selected_app, created_at, mode) VALUES (?,?,?,?,?)",
                (tid, prompt, selected_app, now_iso(), mode))
        return tid

    def get_task(self, task_id: str) -> dict | None:
        rows = self._q("SELECT * FROM tasks WHERE id=?", (task_id,))
        if not rows:
            return None
        r = rows[0]
        return {"id": r["id"], "prompt": r["prompt"], "selected_app": r["selected_app"],
                "created_at": r["created_at"], "mode": r["mode"]}

    def list_tasks(self) -> list[dict]:
        rows = self._q(
            "SELECT t.id, t.prompt, t.created_at, t.mode, "
            "(SELECT COUNT(*) FROM steps s WHERE s.task_id=t.id) AS step_count "
            "FROM tasks t ORDER BY t.created_at DESC")
        return [dict(r) for r in rows]

    # ------------------------------------------------------------ steps + scores
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
                        "edited_from, revision, app_name, app_bundle) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (s["id"], task_id, s["index"], s["title"], s["description"], s["glyph"],
                         s.get("status", "pending"), s.get("edited_from"), s.get("revision", 0),
                         *_app_cols(s.get("app"))))
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

    def get_steps(self, task_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM steps WHERE task_id=? ORDER BY idx", (task_id,))
        return [{"id": r["id"], "task_id": r["task_id"], "index": r["idx"], "title": r["title"],
                 "description": r["description"], "glyph": r["glyph"], "status": r["status"],
                 "edited_from": r["edited_from"], "revision": r["revision"],
                 "app": ({"name": r["app_name"], "bundle_id": r["app_bundle"]}
                         if r["app_bundle"] else None)} for r in rows]

    def set_step_status(self, step_id: str, status: str) -> None:
        self._x("UPDATE steps SET status=? WHERE id=?", (status, step_id))

    def get_scores(self, task_id: str) -> list[dict]:
        rows = self._q(
            "SELECT sc.* FROM scores sc JOIN steps s ON s.id=sc.step_id "
            "WHERE s.task_id=? ORDER BY s.idx, sc.dimension", (task_id,))
        return [{"step_id": r["step_id"], "dimension": r["dimension"], "label": r["label"],
                 "position": r["position"], "confidence": r["confidence"],
                 "rationale": r["rationale"]} for r in rows]

    def positions_by_step(self, task_id: str) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for sc in self.get_scores(task_id):
            out.setdefault(sc["step_id"], {})[sc["dimension"]] = sc["position"]
        return out

    # ------------------------------------------------------------ score cache
    def cache_get(self, h: str, model: str) -> dict | None:
        rows = self._q("SELECT verdicts FROM score_cache WHERE hash=? AND model=?", (h, model))
        return json.loads(rows[0]["verdicts"]) if rows else None

    def cache_put(self, h: str, model: str, verdicts: dict) -> None:
        self._x("INSERT OR REPLACE INTO score_cache (hash, model, verdicts, created_at) "
                "VALUES (?,?,?,?)", (h, model, json.dumps(verdicts), now_iso()))

    # ------------------------------------------------------------ boundaries
    def put_boundary(self, task_id: str, x_dim: str, y_dim: str,
                     polygon: list[list[float]]) -> str | None:
        """One polygon per axis pair. An empty (or <3 vertex) polygon clears that pair."""
        with self._lock:
            if len(polygon) < 3:
                self.db.execute("DELETE FROM boundaries WHERE task_id=? AND x_dim=? AND y_dim=?",
                                (task_id, x_dim, y_dim))
                return None
            rows = self.db.execute(
                "SELECT id FROM boundaries WHERE task_id=? AND x_dim=? AND y_dim=?",
                (task_id, x_dim, y_dim)).fetchall()
            bid = rows[0]["id"] if rows else new_id("bnd")
            self.db.execute(
                "INSERT OR REPLACE INTO boundaries (id, task_id, name, x_dim, y_dim, polygon, "
                "updated_at) VALUES (?,?,?,?,?,?,?)",
                (bid, task_id, None, x_dim, y_dim, json.dumps(polygon), now_iso()))
            return bid

    def get_boundaries(self, task_id: str | None) -> list[dict]:
        if task_id is None:
            rows = self._q("SELECT * FROM boundaries WHERE task_id IS NULL ORDER BY updated_at")
        else:
            rows = self._q("SELECT * FROM boundaries WHERE task_id=? ORDER BY updated_at",
                           (task_id,))
        return [{"id": r["id"], "task_id": r["task_id"], "name": r["name"], "x_dim": r["x_dim"],
                 "y_dim": r["y_dim"], "polygon": json.loads(r["polygon"]),
                 "updated_at": r["updated_at"]} for r in rows]

    # ------------------------------------------------------------ decisions
    def add_decision(self, task_id: str, step_id: str, action: str, source: str,
                     snapshot: dict, run_id: str | None = None) -> str:
        did = new_id("dec")
        self._x("INSERT INTO decisions (id, task_id, step_id, action, source, run_id, snapshot, "
                "created_at) VALUES (?,?,?,?,?,?,?,?)",
                (did, task_id, step_id, action, source, run_id, json.dumps(snapshot), now_iso()))
        return did

    def get_decisions(self, task_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM decisions WHERE task_id=? ORDER BY created_at", (task_id,))
        return [{**dict(r), "snapshot": json.loads(r["snapshot"])} for r in rows]

    # ------------------------------------------------------------ runs
    def create_run(self, task_id: str, exec_mode: str, approved: list[str], removed: list[str],
                   boundaries: list[dict]) -> str:
        rid = new_id("run")
        self._x("INSERT INTO runs (id, task_id, status, exec_mode, approved, removed, boundaries, "
                "started_at) VALUES (?,?,?,?,?,?,?,?)",
                (rid, task_id, "running", exec_mode, json.dumps(approved), json.dumps(removed),
                 json.dumps(boundaries), now_iso()))
        return rid

    def finish_run(self, run_id: str, status: str, final: dict) -> None:
        self._x("UPDATE runs SET status=?, final=?, finished_at=? WHERE id=?",
                (status, json.dumps(final), now_iso(), run_id))

    def unfinished_runs(self) -> list[dict]:
        """Runs with no finished_at: only possible when the daemon died mid-run."""
        rows = self._q("SELECT id, task_id, removed FROM runs WHERE finished_at IS NULL "
                       "ORDER BY started_at")
        return [{"id": r["id"], "task_id": r["task_id"], "removed": json.loads(r["removed"])}
                for r in rows]

    def get_runs(self, task_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM runs WHERE task_id=? ORDER BY started_at", (task_id,))
        out = []
        for r in rows:
            d = dict(r)
            for k in ("approved", "removed", "boundaries"):
                d[k] = json.loads(d[k])
            d["final"] = json.loads(d["final"]) if d["final"] else None
            out.append(d)
        return out

    # ------------------------------------------------------------ events
    def append_event(self, task_id: str, run_id: str | None, kind: str,
                     payload: dict) -> dict:
        with self._lock:
            row = self.db.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE task_id=?",
                                  (task_id,)).fetchone()
            seq = int(row["m"]) + 1
            ts = now_iso()
            self.db.execute(
                "INSERT INTO events (task_id, seq, run_id, kind, ts, payload) VALUES (?,?,?,?,?,?)",
                (task_id, seq, run_id, kind, ts, json.dumps(payload)))
        return {"kind": kind, "task_id": task_id, "run_id": run_id, "seq": seq, "ts": ts,
                "payload": payload}

    def get_events(self, task_id: str, since: int = 0) -> list[dict]:
        rows = self._q("SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq",
                       (task_id, since))
        return [{"kind": r["kind"], "task_id": r["task_id"], "run_id": r["run_id"],
                 "seq": r["seq"], "ts": r["ts"], "payload": json.loads(r["payload"])}
                for r in rows]

    # ------------------------------------------------------------ llm calls
    def add_llm_call(self, task_id: str | None, run_id: str | None, rec: Any) -> None:
        self._x("INSERT INTO llm_calls (id, task_id, run_id, scope, provider, model, input_tokens, "
                "output_tokens, usd, latency_ms, ok, error, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("llm"), task_id, run_id, rec.scope, rec.provider, rec.model,
                 rec.input_tokens, rec.output_tokens, rec.usd, rec.latency_ms,
                 1 if rec.ok else 0, rec.error, now_iso()))

    def task_cost(self, task_id: str) -> float:
        row = self._q("SELECT COALESCE(SUM(usd), 0) AS s FROM llm_calls WHERE task_id=?",
                      (task_id,))[0]
        return round(float(row["s"]), 6)

    def total_cost(self) -> float:
        row = self._q("SELECT COALESCE(SUM(usd), 0) AS s FROM llm_calls")[0]
        return round(float(row["s"]), 6)

    def get_llm_calls(self, task_id: str) -> list[dict]:
        rows = self._q("SELECT * FROM llm_calls WHERE task_id=? ORDER BY created_at", (task_id,))
        return [dict(r) for r in rows]

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
