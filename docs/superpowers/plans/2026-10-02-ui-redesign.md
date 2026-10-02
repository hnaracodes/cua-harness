# UI Redesign (chat-first oversight): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is built to run as a **multi-agent workflow**: read "Execution model" before starting any task. An agent assigned one task reads this file (Global Constraints, Contracts, Ownership) **and only its own track file**.

**Goal:** Replace the parity-replica UI with a chat-first oversight app. The new app has a ChatGPT-style home, chat-left / workspace-right review with a pan/zoom boundary canvas (stacks + fan-out for ties), a run narrated as chat that ends in a recap, an app-launched daemon with a first-run setup wizard, and a Paper view that keeps the source-video layout.

**Architecture:** The Python daemon keeps all logic and gains additive endpoints (setup, attachments, revise/edit, frames, recap). The React app is split into screen modules (shell, home, chat, workspace, canvas, setup, paper). All screens share one session hook (`state/useSession.ts`) that owns every daemon call. The Rust Tauri shell becomes a daemon supervisor and nothing more. Work is cut into **waves**: Wave 0 freezes contracts and moves files, Wave 1 runs 13 tracks in parallel with disjoint file ownership, and Wave 2 integrates and verifies.

**Tech Stack:** React 19 + TypeScript 5.9 (strict) + Vite 8, CSS Modules, Tauri 2 (Rust), Python 3.12 + FastAPI + SSE + SQLite (uv), `node --test` for pure TS, Playwright for e2e, pytest for the daemon.

**Spec:** `docs/superpowers/specs/2026-10-02-ui-redesign-design.md` (approved). Mockups are in `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/`. Every executor reads the spec section(s) named in its track before writing code.

---

## Global Constraints

Every task's requirements implicitly include every line here.

- **Paths contain spaces.** Always quote: `cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"`.
- **Toolchain:**
  - Node 22.23 and npm.
  - `uv` for Python 3.12. Daemon commands run as `cd daemon && uv run …`.
  - Rust only via the repo-local toolchain: `export CARGO_HOME="$PWD/.toolchain/cargo" RUSTUP_HOME="$PWD/.toolchain/rustup" PATH="$PWD/.toolchain/cargo/bin:$PATH"`, run from `appdev/`.
- **Dependencies are frozen after Wave 0.**
  - Wave 0 adds exactly: `@playwright/test` (npm dev), `keyring>=25.0` and `python-multipart>=0.0.9` (daemon).
  - Track R1 may add exactly `serde = { version = "1", features = ["derive"] }` and `serde_json = "1"` to `Cargo.toml`.
  - No other task adds a dependency. If one seems necessary, stop and report `DEPENDENCY_NEEDED: <name> <why>`.
- **The daemon owns all logic.** UI code renders and captures gestures. Every state change goes through `state/useSession.ts` → `DaemonApi`. No screen calls `fetch` directly.
- **Approval logic exists only in** `app/src/lib/approval.ts` (UI) and `daemon/oversight/approval.py`. Neither file is modified by this plan. Classification always tests the true scored point, never a displayed position.
- **The executor's approved-only assertion** (`executor.assert_step_approved`, `executor.assert_all_approved`) is never weakened, bypassed, or moved.
- **Grid coordinates are normalized 0..1** per dimension. A pan or zoom never changes stored coordinates.
- **Dimension text:** axis names and definitions render exactly as returned by `GET /dimensions`, byte for byte. Never hard-code dimension text in new UI.
- **Every LLM call** goes through `ctx.record_call` (or the existing `record_call`), so cost and latency appear in the UI.
- **Screenshots:** only window-scoped captures. `frames/` serves the exact capture the model saw, converted to JPEG. Never capture the full screen.
- **Styling:** new components use co-located CSS Modules (`Name.module.css`). The only global CSS is `app/src/theme/tokens.css`, `app/src/theme/base.css`, and the scoped `app/src/paper/paper.css`.
- **Graphite tokens:** use these exact values (dark); the light values are in `tokens.css`.

  | Token | Value | Token | Value |
  |---|---|---|---|
  | `--bg` | `#141414` | `--surface` | `#1c1c1c` |
  | `--raised` | `#262626` | `--line` | `#303030` |
  | `--text` | `#ececec` | `--text-2` | `#a3a3a3` |
  | `--text-3` | `#8f8f8f` | `--accent` | `#9d8cff` |
  | `--accent-ink` | `#141414` | `--ok` | `#5fc48a` |
  | `--pend` | `#e8a948` | `--rm` | `#e46a5c` |
  | `--grid` | `#242424` | | |

  Violet (`--accent`) is used only for primary "do this" buttons, the active tool, and focus rings. Green, amber, and red are used only for step status.
- **Copy (exact strings):**
  - Home heading: `What should the agent do?`
  - Primary run button labels: `Approve & run` / `Run {K} approved, skip {M}` / `Fix permissions to run` / `Set up the agent to run this`.
  - Secondary: `Approve all {N}`. Hint: `1 step still needs a decision` / `{M} steps still need a decision`.
  - Coach hint: `Drag a loop to approve · pinch or ⌘-scroll to zoom · two-finger drag or space-drag to pan`.
  - Attachment note: `Sent to {Provider} with your task.` (`Anthropic` / `OpenAI`).
  - Desk pill: `only this window is visible to the model`.
  - Setup skip: `Skip, plan-only mode`.
- **Decision sources** sent to `POST /decision`: `step_list`, `grid`, `fan_out`, `skip_undecided`, `plan_panel` (Paper view only).
- **Commits:** one commit per completed task step block, as each task specifies. Message style: `area: summary`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq
  ```
- **Check commands** (all must pass at every task's end, in the task's worktree):
  - UI: `cd app && npm run typecheck && npm test`
  - Daemon: `cd daemon && uv run pytest -q`
  - E2E (UI tracks): `cd app && npx playwright test e2e/<track>.spec.ts`

## Review Focus

These are the inputs and failure modes the spec implies but no happy-path test exercises, ordered most likely to bite first. Each has a pinning test in the named task.

1. **Replaying an old task** created before the redesign. It has no attachments and no `frame`, `run_recap`, or `plan_revised` events, and its `step_result` lacks `actions` and `duration_ms`. Expected: the chat renders, and a recap is synthesized from `final_result`. *Pinned in U2* (`eventsToMessages: legacy stream`).
2. **Drawing while zoomed in or panned**, including starting a loop on a badge and dragging a handle off the visible area. Expected: every stored vertex is clamped to [0,1]. A badge in view classifies by its true point. Nothing jumps when zoom changes mid-gesture. *Pinned in U3* (`viewport: screenToData clamps under extreme camera`, `e2e canvas: draw at 400% zoom`).
3. **Repropose with mixed state**: steps approved by polygon, checked, removed, and a polygon on a different axis pair. Expected: kept steps keep their id, status, and scores; boundaries survive; new steps are pending; dropped steps disappear from checked and removed. *Pinned in D3* (`test_repropose_preserves_state`) and W0-3 (`session: plan_revised filters vanished ids`).
4. **Bad attachments**: 0-byte file, `.heic`, a 6 MB PNG, a fifth image, the same image twice. Expected: a clear 4xx with a reason, dedupe by sha256 to one stored file, and an inline error on that thumbnail only. *Pinned in D2* (`test_attachment_rejections`) and U1 (`e2e home: rejects bad attachment`).
5. **Daemon goes away mid-session** (laptop sleep, crash, restart). Expected: the SSE stream resumes from the last seq with no duplicate chat messages, the pill shows `Reconnecting…`, and actions surface a notice instead of throwing. *Pinned in W0-3* (`session: event dedupe by seq`) and U1 (`HealthPill reconnecting state` e2e via mock `?down=1`).

---

## Execution model (multi-agent)

### Waves

```
Wave 0  (foundation, contracts frozen here)
  W0-1 daemon-foundation  ─┐
  W0-2 ui-contracts       ─┼─> W0-3 ui-skeleton ──> merge + verify
                           │
Wave 1  (13 parallel tracks, disjoint file ownership)
  Batch A (run first, these are the building blocks):
    D1 daemon-setup   D2 daemon-attachments   D3 daemon-revise   D4 daemon-narration
    R1 tauri-supervisor   U2 ui-chat   U3 ui-canvas   U8 ui-mock
  Batch B (compose the building blocks; may start in parallel with A,
           better results if started after A merges):
    U1 ui-shell-home   U4 ui-review   U5 ui-run   U6 ui-setup-wizard   U7 ui-paper
  ──> merge each track as it passes review, in the order listed above

Wave 2  (integration, sequential)
  W2-1 integration-e2e (full-flow Playwright, feel check, cross-track fixes)
  W2-2 docs (CLAUDE.md decision C, docs/02 label, RUNNING.md)
  W2-3 whole-branch review + human-gate checklist
```

**Decision (2026-10-02): run all 13 Wave 1 tracks at once.** The user explicitly chose this over the default "medium, under 10 agents" workflow guideline. It's safe because Wave 0 leaves working stubs for every interface. Batch A and Batch B still define the **merge order**: merge Batch A tracks first as they pass review, so Batch B reviewers check against real chat, canvas, and mock code.

### Worktrees and merging

- Integration branch: `ui-redesign` (contains the spec and this plan).
- Each task runs in its own worktree:
  ```bash
  cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
  git worktree add ".worktrees/rd-<task-id>" -b "rd/<task-id>" ui-redesign
  cd ".worktrees/rd-<task-id>/app" && npm ci         # UI tasks
  cd ".worktrees/rd-<task-id>/daemon" && uv sync     # daemon tasks
  ```
- A task is done when its own steps pass, the Global check commands pass, and a reviewer agent approved it against its track file and the spec.
- The orchestrator merges done tasks into `ui-redesign` with `git merge --no-ff rd/<task-id>`, in the order listed under Waves. After each merge it runs every check command. A merge conflict means an ownership violation: send the task back. Never resolve such a conflict by hand.
- After all Wave 1 merges, the orchestrator runs the full suite once more before starting Wave 2.

### Ownership rules

1. A task modifies only files in its **Owns** list (see the matrix). It may create new files only inside directories it owns.
2. **Contracts are frozen after Wave 0.** If a task needs a contract change (a type, endpoint shape, prop, or store method), it stops and reports `CONTRACT_CHANGE_NEEDED: <file> <change> <why>`. The orchestrator decides. Tasks never edit a contract file they don't own.
3. Stubs created in Wave 0 are owned by the Wave 1 track that replaces them. That track keeps the exported names and prop types exactly as in Contracts.

### File ownership matrix

| Path | Wave 0 | Wave 1 owner |
|---|---|---|
| `daemon/pyproject.toml`, `daemon/uv.lock` | W0-1 | frozen |
| `daemon/oversight/store.py` | W0-1 | frozen |
| `daemon/oversight/fixtures.py` | W0-1 | frozen |
| `daemon/oversight/api.py` | W0-1 | **D4** (only `_drive` and `_start_run`) |
| `daemon/oversight/routes/ctx.py`, `routes/__init__.py` | W0-1 | frozen |
| `daemon/oversight/routes/setup.py`, `daemon/oversight/setup.py`, `daemon/oversight/settings.py` | W0-1 (stub) | **D1** |
| `daemon/oversight/routes/attachments.py`, `daemon/oversight/llm.py`, `daemon/oversight/planner.py` | W0-1 | **D2** |
| `daemon/oversight/routes/revise.py`, `daemon/oversight/replanner.py` | W0-1 (stub) / new | **D3** |
| `daemon/oversight/routes/frames.py`, `daemon/oversight/recap.py`, `daemon/oversight/executor.py` | W0-1 (stub) / new | **D4** |
| `daemon/tests/test_setup.py` | n/a | D1 |
| `daemon/tests/test_attachments.py` | n/a | D2 |
| `daemon/tests/test_revise.py` | n/a | D3 |
| `daemon/tests/test_narration.py` | n/a | D4 |
| `daemon/tests/test_store_v2.py`, `daemon/tests/test_routes_v2.py` | W0-1 | frozen |
| `app/package.json`, `app/package-lock.json`, `app/playwright.config.ts` | W0-2 | frozen |
| `app/src/api/types.ts`, `app/src/api/client.ts` (all but `connectDaemon`) | W0-2 | frozen |
| `app/src/api/client.ts` `connectDaemon` function only | W0-2 | **R1** |
| `app/src/api/mock.ts`, `app/src/api/fixtures.ts` | W0-2 | **U8** |
| `app/src/lib/tauri.ts`, `app/src-tauri/**` | W0-2 (TS stubs) | **R1** |
| `app/src/theme/**`, `app/src/main.tsx`, `app/src/App.tsx`, `app/src/screens.ts` | W0-3 | frozen (W2-1 may edit) |
| `app/src/state/**` | W0-3 | frozen |
| `app/src/chat/**` | W0-3 (stub) | **U2** |
| `app/src/canvas/**`, `app/src/lib/viewport.ts`, `app/src/lib/stacks.ts` | W0-3 (adapter) | **U3** |
| `app/src/shell/**`, `app/src/home/**` | W0-3 (stub) | **U1** |
| `app/src/workspace/ReviewScreen.tsx`, `workspace/StepList.*`, `workspace/ActionBar.*`, `workspace/AxisPicker.*`, `workspace/Review*.module.css` | W0-3 (stub) | **U4** |
| `app/src/workspace/RunScreen.tsx`, `workspace/DeskView.*`, `workspace/Run*.module.css` | W0-3 (stub) | **U5** |
| `app/src/setup/**` | W0-3 (stub) | **U6** |
| `app/src/paper/**` | W0-3 (moved) | **U7** |
| `app/src/lib/approval.ts`, `app/src/lib/geometry.ts` | frozen | frozen |
| `app/tests/<name>.test.mts` | per creator | creator |
| `app/e2e/<track>.spec.ts` | per creator | creator (`smoke.spec.ts`: W0-3) |
| `CLAUDE.md`, `docs/**`, `RUNNING.md` | n/a | W2-2 only |

### Recommended workflow shape

For each task: implementer agent (in its worktree) → reviewer agent (reads the track file, the spec section, and the diff; returns approve or fixes) → loop until approved → orchestrator merges. The orchestrator owns merge order and the post-merge check runs. Reviewers specifically check ownership (`git diff --name-only ui-redesign...HEAD` ⊆ Owns) and contract fidelity.

---

## Contracts (frozen in Wave 0)

These are the exact names and shapes every track builds against. Wave 0 implements them. Wave 1 tracks consume them and must not change them.

### C1. TypeScript API types: additions to `app/src/api/types.ts` (W0-2)

```ts
export type Provider = "anthropic" | "openai";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface Attachment {
  attachment_id: string;
  mime: ImageMime;
  bytes: number;
}

export interface TaskSummary {
  id: string;
  prompt: string;
  created_at: string;
  step_count: number;
}

export interface RunRecord {
  id: string;
  task_id: string;
  status: string; // "running" | "completed" | "stopped" | "failed" | "capped"
  exec_mode: string;
  approved: string[];
  removed: string[];
  started_at: string;
  finished_at: string | null;
  final: FinalResultPayload | null;
}

export interface TaskDetail {
  task: {
    id: string;
    prompt: string;
    selected_app: string | null;
    created_at: string;
    mode: string;
    attachments: Attachment[];
  };
  steps: Step[];
  scores: Score[];
  boundaries: { x_dim: string; y_dim: string; polygon: Point[] }[];
  runs: RunRecord[];
  cost_usd: number;
}

export type PermState = "granted" | "denied" | "unknown" | "n/a";

export interface SetupStatus {
  platform: "macos" | "windows" | "linux";
  key: { provider: Provider; present: boolean; source: "keychain" | "env" | "none"; tested: boolean; warning: string | null };
  driver: { installed: boolean; version: string | null; running: boolean };
  permissions: { accessibility: PermState; screen_recording: PermState };
  self_test: { passed_at: string | null };
  plan_only: boolean;
  complete: boolean;
}

export interface AppSettings {
  provider: Provider;
  model: string;
  plan_only: boolean;
  models: Record<Provider, string[]>;
}

export interface PlanRevisedPayload {
  revision: number;
  instruction: string | null;
  changed_step_ids: string[];
  added_step_ids: string[];
  dropped_step_ids: string[];
}

export interface FramePayload {
  step_id: string;
  seq: number; // frame number within the task, 1-based, monotonic
}

export interface RunRecapPayload {
  headline: string;
  done: { step_id: string; text: string }[];
  skipped: { step_id: string; reason: string }[];
  source: "llm" | "fallback";
}

export type DecisionSource = "step_list" | "grid" | "fan_out" | "skip_undecided" | "plan_panel";
```

Changed existing types:
- `Health` gains `setup_complete: boolean; plan_only: boolean; cua_driver_detail?: string`.
- `StepResultPayload` gains `actions?: number; duration_ms?: number` (optional, because legacy events lack them).
- `DecisionBody.source` becomes `DecisionSource`.
- `EventKind` and `EVENT_KINDS` gain `"plan_revised" | "frame" | "run_recap"`.
- `PlanResponse` gains optional `revision?: number`.
- `CostPayload.scope` widens to `"plan" | "score" | "run" | "recap" | "revise" | "setup"`.
- Daemon-internal decision sources (`run`, `chat` for re-propose) may appear in stored decisions; the UI never sends them.

### C2. `DaemonApi` additions in `app/src/api/client.ts` (W0-2)

```ts
export interface DaemonApi {
  // existing members unchanged, except createTask:
  createTask(prompt: string, selectedApp?: string | null, attachmentIds?: string[]): Promise<{ task_id: string }>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  uploadAttachment(file: Blob, name: string): Promise<Attachment>;
  attachmentUrl(attachmentId: string): string;
  repropose(taskId: string, instruction: string | null): Promise<PlanResponse>;
  editStep(taskId: string, stepId: string, patch: { title?: string; description?: string }): Promise<{ step: Step; scores: Score[] }>;
  frameUrl(taskId: string, seq: number): string;
  setupStatus(): Promise<SetupStatus>;
  setKey(provider: Provider, key: string): Promise<{ ok: boolean; error: string | null }>;
  installDriver(): Promise<{ ok: boolean; version: string | null; log_tail: string }>;
  startDriver(): Promise<{ ok: boolean; error: string | null }>;
  openPermission(which: "accessibility" | "screen_recording"): Promise<{ ok: boolean }>;
  selfTest(): Promise<{ ok: boolean; detail: string }>;
  completeSetup(): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  putSettings(patch: Partial<Pick<AppSettings, "provider" | "model" | "plan_only">>): Promise<AppSettings>;
}
```

`HttpError` (existing) is what every rejected call throws. Its `body.error` is the user-facing reason.

### C3. Daemon HTTP API (W0-1 registers the routes; owners implement them)

| Method and path | Request | 200 response | Errors | Owner |
|---|---|---|---|---|
| `GET /health` | n/a | existing fields + `setup_complete: bool`, `plan_only: bool` | n/a | W0-1 |
| `POST /task` | `{prompt, selected_app?, attachment_ids?: str[]}` | `{task_id}` | 400 empty prompt, >4 attachments, unknown attachment id | W0-1 |
| `GET /task/{id}` | n/a | existing + `task.attachments: Attachment[]` | 404 | W0-1 |
| `POST /attachments` | multipart field `file` | `{attachment_id, mime, bytes}` | 400 `{error}` (empty or unsupported type), 413 `{error}` (>5 MB) | D2 |
| `GET /attachments/{id}` | n/a | raw bytes with the stored mime | 404 | D2 |
| `POST /task/{id}/repropose` | `{instruction: str \| null}` | `{task_id, steps, scores, revision}` | 404, 409 (run active or no plan yet), 502 (LLM) | D3 |
| `PATCH /task/{id}/step/{step_id}` | `{title?: str, description?: str}` | `{step, scores}` | 400 (both empty), 404, 409 (run active) | D3 |
| `GET /task/{id}/frames/{seq}.jpg` | n/a | `image/jpeg` | 404 | D4 |
| `GET /setup/status` | n/a | `SetupStatus` (C1) | n/a | D1 |
| `PUT /setup/key` | `{provider, key}` | `{ok, error}` (key never echoed) | 400 unknown provider | D1 |
| `POST /setup/driver/install` | `{}` | `{ok, version, log_tail}` | n/a | D1 |
| `POST /setup/driver/start` | `{}` | `{ok, error}` | n/a | D1 |
| `POST /setup/permissions/open` | `{which: "accessibility" \| "screen_recording"}` | `{ok}` | 400 unknown `which` | D1 |
| `POST /setup/self-test` | `{}` | `{ok, detail}` | n/a | D1 |
| `POST /setup/complete` | `{}` | `{ok}` (persists `setup_complete=true`) | n/a | D1 |
| `GET /settings` | n/a | `AppSettings` | n/a | D1 |
| `PUT /settings` | `{provider?, model?, plan_only?}` | `AppSettings` | 400 unknown provider or model | D1 |

**SSE event kinds added:**
- `plan_revised` with `PlanRevisedPayload`, emitted by D3.
- `frame` with `FramePayload`, emitted by D4. Images are never embedded in the stream.
- `run_recap` with `RunRecapPayload`, emitted by D4 **before** `final_result`.

`step_result` gains `actions: int` and `duration_ms: int` (D4).

### C4. Daemon internals (W0-1)

```python
# daemon/oversight/routes/ctx.py
@dataclass
class Ctx:
    st: "State"  # api.State: .settings .store .bus .llm .plan_locks .active_runs .session_cost
    record_call: Callable[[str | None, str | None, CallRecord], Awaitable[None]]
    progress: Callable[[str, str, str, int, int], Awaitable[None]]  # (task_id, stage, message, done, total)
    scores_snapshot: Callable[[str, str], dict]                     # (task_id, step_id)
    score_steps: Callable[..., Awaitable[list[dict]]]  # (task_id, prompt, steps, *, context=None, on_done=None) -> score dicts; scores only `steps`, scorer sees `context`
    load_images: Callable[[str], list["ImageInput"]]                # task_id -> attachment images

# each routes module
def register(app: FastAPI, ctx: Ctx) -> None: ...
```

```python
# daemon/oversight/llm.py
@dataclass(frozen=True)
class ImageInput:
    mime: str   # image/png | image/jpeg | image/webp
    data: bytes

class StructuredLLM:
    async def call(self, *, scope: str, system: str, user: str, schema: dict, schema_name: str,
                   effort: str = "low", max_tokens: int = 8000,
                   images: Sequence[ImageInput] = ()) -> tuple[dict, CallRecord]: ...
# planner.py
async def plan_task(llm, prompt, selected_app, on_call=None, images: Sequence[ImageInput] = ()) -> list[PlannedStep]: ...
```

Wave 0 accepts `images` but raises `LLMError("image input not implemented")` when it is non-empty. D2 implements it.

**Store methods added in `store.py` (W0-1):**

```python
add_attachment(sha256: str, mime: str, size: int, path: str) -> str            # dedupes by sha256, returns id
get_attachment(attachment_id: str) -> dict | None                               # {id, sha256, mime, bytes, path, created_at}
link_attachments(task_id: str, attachment_ids: list[str]) -> None               # keeps order
get_task_attachments(task_id: str) -> list[dict]                                # [{attachment_id, mime, bytes, path}]
get_setting(key: str, default: Any = None) -> Any                               # JSON-decoded
set_setting(key: str, value: Any) -> None                                       # JSON-encoded
add_frame(task_id: str, run_id: str, step_id: str, path: str) -> int            # returns seq (1-based per task)
get_frame(task_id: str, seq: int) -> dict | None                                # {task_id, seq, run_id, step_id, path, created_at}
revise_plan(task_id: str, steps: list[dict], scores: list[dict]) -> None         # like replace_plan but KEEPS boundaries
update_step(step_id: str, title: str, description: str, edited_from: str | None) -> None
replace_step_scores(step_id: str, scores: list[dict]) -> None
```

**Settings keys** used with `get_setting` and `set_setting`:
- `"setup_complete"` (bool)
- `"plan_only"` (bool)
- `"provider"` (str)
- `"model"` (str)
- `"key_tested"` (dict provider → bool)
- `"self_test_passed_at"` (str | None)

**Fixture scoring:** `fixtures.scores_for_steps(steps: list[dict]) -> list[DimensionScore]`. A step whose title equals a fixture title gets that fixture's scores. Any other step gets deterministic synthetic scores.

### C5. Session layer (W0-3): `app/src/state/`

```ts
// session.ts (pure)
export type Phase = "home" | "planning" | "review" | "running" | "done";
export interface RunError { status: number; error: string; expected?: string[]; got?: string[] }
export interface RunInfo { runId: string; approvedIds: string[]; removedIds: string[] }
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
export const DEFAULT_AXES: { x: string; y: string };  // action_uncertainty × reversibility
export const initialSession: SessionState;
export type SessionAction = /* see track-00 */;
export function sessionReducer(s: SessionState, a: SessionAction): SessionState;

// useSession.ts
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
export function useSession(api: DaemonApi | null): Session;

// useDaemon.ts
export interface DaemonConn {
  api: DaemonApi | null;
  health: Health | null;
  reachable: boolean;
  dims: Dimension[];
  refreshHealth(): Promise<void>;
}
export function useDaemon(): DaemonConn;
```

`app/src/screens.ts`:

```ts
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

### C6. Component contracts (W0-3 creates stubs with exactly these exports)

```ts
// shell/AppShell.tsx (U1)
export function AppShell(props: ScreenProps & { children: React.ReactNode }): JSX.Element;
// shell/Splash.tsx (U1)
export function Splash(props: { conn: DaemonConn }): JSX.Element;
// home/HomeScreen.tsx (U1)
export function HomeScreen(props: ScreenProps): JSX.Element;
// home/Composer.tsx (U1)
export interface ComposerProps {
  api: DaemonApi;
  value: string;
  onChange: (v: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (a: Attachment[]) => void;
  allowAttachments: boolean;
  providerLabel: string;          // "Anthropic" | "OpenAI", for the attachment note
  placeholder: string;
  size: "hero" | "dock";
  disabledReason: string | null;  // non-null disables send and shows the reason
  running: boolean;               // true: the send button becomes Stop
  onSend: () => void;
  onStop?: () => void;
}
export function Composer(props: ComposerProps): JSX.Element;

// chat/types.ts (U2; W0-3 writes this file verbatim, U2 must not change it)
export type ChatMessage =
  | { kind: "user"; id: string; text: string; attachments: Attachment[] }
  | { kind: "planning"; id: string; stage: "planning" | "scoring"; message: string; done: number; total: number }
  | { kind: "plan_ready"; id: string; stepCount: number; revision: number }
  | { kind: "plan_error"; id: string; error: string }
  | { kind: "revised"; id: string; instruction: string | null; changed: number[]; added: number[]; dropped: number }
  | { kind: "run_started"; id: string; approvedIndexes: number[]; skippedIndexes: number[] }
  | { kind: "step_running"; id: string; stepId: string; index: number; title: string }
  | { kind: "step_done"; id: string; stepId: string; index: number; status: "done" | "failed" | "stopped" | "skipped"; summary: string; actions: number | null; durationMs: number | null }
  | { kind: "recap"; id: string; recap: RunRecapPayload; final: FinalResultPayload | null; costUsd: number; actions: number; durationMs: number | null }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string };
export interface ChatInput {
  prompt: string;
  attachments: Attachment[];
  steps: Step[];
  events: OversightEvent[];
  planError: string | null;
}
// chat/eventsToMessages.ts (U2)
export function eventsToMessages(input: ChatInput): ChatMessage[];
// chat/ChatThread.tsx (U2)
export interface ChatThreadProps {
  api: DaemonApi;
  messages: ChatMessage[];
  counts: Counts | null;   // live chips on the latest plan_ready message (review only)
  meta: string | null;     // e.g. "claude-sonnet-5-5 · planned + scored in 9.4s · $0.11"
  events: OversightEvent[]; // for the recap's Details log
  steps: Step[];
  onRetryPlan?: () => void;
}
export function ChatThread(props: ChatThreadProps): JSX.Element;

// canvas/BoundaryCanvas.tsx (U3)
export interface BoundaryCanvasProps {
  steps: Step[];
  idx: ScoreIndex;
  xDim: Dimension;
  yDim: Dimension;
  polygon: Point[] | null;
  status: Record<string, StepStatus>;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onPolygonChange: (poly: Point[] | null, final: boolean) => void;
  onApprove: (id: string) => void;  // from fan-out
  onRemove: (id: string) => void;   // from fan-out
}
export const BoundaryCanvas: React.MemoExoticComponent<(p: BoundaryCanvasProps) => JSX.Element>;

// workspace/ReviewScreen.tsx (U4), workspace/RunScreen.tsx (U5)
export function ReviewScreen(props: ScreenProps): JSX.Element;
export function RunScreen(props: ScreenProps): JSX.Element;
// workspace/DeskView.tsx (U5)
export function DeskView(props: { api: DaemonApi; taskId: string; events: OversightEvent[]; steps: Step[]; run: RunInfo }): JSX.Element;
// setup/SetupWizard.tsx (U6)
export function SetupWizard(props: { api: DaemonApi; initialStep?: SetupStepKey; onClose: () => void }): JSX.Element;
// paper/PaperView.tsx (U7)
export function PaperView(props: ScreenProps): JSX.Element;
```

### C7. Tauri bridge: `app/src/lib/tauri.ts` (W0-2 stubs, R1 implements)

```ts
export const isTauri: () => boolean;                        // existing
export function setAlwaysOnTop(on: boolean): Promise<void>; // existing
export interface SupervisorStatus {
  state: "starting" | "running" | "restarting" | "failed" | "external";
  restarts: number;
  last_error: string | null;
}
export function daemonStatus(): Promise<SupervisorStatus | null>; // null outside Tauri
export function daemonLogTail(lines: number): Promise<string>;     // "" outside Tauri
```

### C8. `data-testid` contract (e2e stability)

Every track that renders these elements keeps these ids exactly. `{i}` is the step's 1-based index.

| Area | Test ids |
|---|---|
| Composer | `composer-input`, `composer-send`, `composer-stop`, `composer-attach`, `composer-file` (hidden `<input type=file>`), `attachment-chip`, `attachment-error` |
| Home and shell | `home-suggestion`, `health-pill`, `history-item`, `new-task`, `notice`, `notice-dismiss`, `splash` |
| Chat | `chat-thread`, `chat-msg-user`, `chat-plan-ready`, `chat-plan-error`, `chat-retry`, `chat-revised`, `chat-msg-step`, `chat-step-running`, `chat-recap`, `chat-recap-details` |
| Canvas | `boundary-canvas` (the `<svg>`), `badge-{i}`, `stack-badge`, `fan-out`, `fan-approve-{i}`, `fan-remove-{i}`, `boundary-polygon`, `boundary-handle`, `canvas-tool-draw`, `canvas-tool-pan`, `canvas-zoom-in`, `canvas-zoom-out`, `canvas-zoom-label`, `canvas-fit`, `canvas-undo`, `canvas-clear`, `minimap`, `coach-hint` |
| Review workspace | `axis-x`, `axis-y`, `paper-toggle`, `step-row-{i}`, `step-approve-{i}`, `step-remove-{i}`, `step-edit-{i}`, `step-restore-{i}`, `approve-all`, `run-primary`, `decision-hint` |
| Run | `desk-view`, `desk-frame`, `desk-progress` |
| Setup | `setup-wizard`, `setup-step-{key}`, `setup-next`, `setup-skip-plan-only`, `setup-key-input`, `setup-key-save`, `setup-open-accessibility`, `setup-open-screen_recording`, `setup-driver-install`, `setup-driver-start`, `setup-selftest-run`, `setup-done` |
| Paper | `paper-exit`, plus the existing Paper ids (`generate-plan`, `approve-run`, `start-over`, …) |

### E2E ports (parallel worktrees must not share a dev server)

Run each track's e2e as `E2E_PORT=<port> npx playwright test e2e/<file>`. Ports: W0-3 1430, U1 1431, U2 1432, U3 1433, U4 1434, U5 1435, U6 1436, U7 1437, U8 1438, W2 1439.

---

## Tracks

| ID | Track file | Spec sections | Depends on |
|---|---|---|---|
| W0-1, W0-2, W0-3 | `2026-10-02-ui-redesign/track-00-foundation.md` | all of "Front-end structure" and "Daemon API changes" | nothing |
| D1 | `2026-10-02-ui-redesign/track-D1-daemon-setup.md` | Daemon API §5, Screens §4 | W0 |
| D2 | `2026-10-02-ui-redesign/track-D2-daemon-attachments.md` | Daemon API §1 | W0 |
| D3 | `2026-10-02-ui-redesign/track-D3-daemon-revise.md` | Daemon API §2 | W0 |
| D4 | `2026-10-02-ui-redesign/track-D4-daemon-narration.md` | Daemon API §3, Screens §3 | W0 |
| R1 | `2026-10-02-ui-redesign/track-R1-tauri-supervisor.md` | Tauri shell | W0 |
| U1 | `2026-10-02-ui-redesign/track-U1-shell-home.md` | Screens §1, Error handling | W0 |
| U2 | `2026-10-02-ui-redesign/track-U2-chat.md` | Screens §2 chat column, §3 | W0 |
| U3 | `2026-10-02-ui-redesign/track-U3-canvas.md` | Screens §2 canvas | W0 |
| U4 | `2026-10-02-ui-redesign/track-U4-review.md` | Screens §2 | W0 (better after U2, U3) |
| U5 | `2026-10-02-ui-redesign/track-U5-run.md` | Screens §3 | W0 (better after U2) |
| U6 | `2026-10-02-ui-redesign/track-U6-setup-wizard.md` | Screens §4 | W0 |
| U7 | `2026-10-02-ui-redesign/track-U7-paper.md` | Screens §5 | W0 |
| U8 | `2026-10-02-ui-redesign/track-U8-mock.md` | Testing (mock daemon) | W0 |
| W2-1, W2-2, W2-3 | `2026-10-02-ui-redesign/track-W2-integration.md` | Testing, Build order gates | all of Wave 1 |

### Spec gates mapped to this plan

The spec's six sequential gates still apply. Parallel tracks check their parts early, and W2-1 checks them end to end:

1. **Full flow in the new layout in mock mode:** W0-3 `smoke.spec.ts`, then W2-1.
2. **Canvas tests plus feel check:** U3, then W2-1 `feel.spec.ts`.
3. **A simulated run reads as chat and ends in a recap:** D4, U2, U5, then W2-1.
4. **Fresh-user setup:** D1, U6, R1, then the W2-3 human gate.
5. **An attached image reaches the planner; revising from chat works:** D2, D3, U1, U4, then W2-1.
6. **Paper view parity and docs:** U7, then W2-2.
