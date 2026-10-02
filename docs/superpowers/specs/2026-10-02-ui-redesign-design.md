# UI redesign: chat-first oversight (design spec)

Date: 2026-10-02. Status: approved in brainstorming, awaiting spec review.
Mockups (approved): `2026-10-02-ui-redesign-mockups/`. These are HTML fragments
made for the brainstorm companion; open them in a browser. Unstyled class names
come from the companion frame.

## Why

Kyzyl reviewed the current build (the docs/07 sprint cut) and judged it hard to
use and in need of heavy improvement. The user agrees after using it. The
specific problems:

1. **Prompt entry looks like a form**, not like a chatbot. Users expect a
   ChatGPT-style home screen: a centered composer, image attachments, and
   suggested prompts.
2. **The boundary canvas is not intuitive.** Badges that sit close together
   cover each other and there is no way to separate them. The current collision
   spread is capped at 9 px (`SPREAD_CAP`, `BoundaryCanvas.tsx:23`) so that a
   badge never drifts from its true point, which leaves near-ties stacked.
   Exact ties are common, because a position is a label band plus a small
   offset within it.
3. **Setup is hard.** The user starts the daemon from a terminal, and granting
   cua-driver's two macOS permissions means terminal commands and digging
   through System Settings (see `BLOCKERS.md`). There is no first-run wizard;
   docs/07 cut it.
4. **The visual design is weak**, and buttons are not useful. For example,
   Approve & Run stays disabled behind a hint line instead of offering a way
   forward.
5. **The execution view is a log.** Users should not have to read logs. The
   run should read like an AI chat: one message per completed action, ending
   in a plain summary of what was done.

## Decisions taken

| Question | Decision |
|---|---|
| Parity vs redesign | **Both (C).** A redesigned default UI, plus a **Paper view** that reproduces the source video's layout for demos and the parity checklist. This amends CLAUDE.md's "parity before improvement" for the UI shell only. The interaction that is the paper's contribution stays as it is. |
| Color | **Graphite.** Neutral near-black, one violet accent reserved for primary "do this" buttons, and green / amber / red reserved for step status. Ship a dark and light token pair that follows the OS. |
| Layout | **Chat left, workspace right** (like Claude's artifact panel). Collapsible left rail of past tasks. |
| Ties on the canvas | **Stack and fan out.** Overlapping badges merge into one "×N" badge; a click fans them out with leader lines to the true point. |
| Setup scope | **The app starts its own daemon, plus an in-app wizard.** Installers, signing and the PyInstaller sidecar are the next sub-project. |

## What does not change

- The freeform polygon with draggable handles, double-click an edge to insert
  a vertex, double-click a handle to delete it, drag inside to move, and Esc
  to cancel. Freehand stroke simplified with RDP. No rectangles and no
  threshold sliders.
- Live point-in-polygon reclassification on every pointermove, committed in
  the same frame (the `flushSync` path stays).
- `lib/approval.ts` stays the single source of truth for approved / pending /
  removed. Classification always tests the **true** scored point, never a
  displayed position.
- The ten dimensions from `dimensions.yaml`. Axis help text is byte-identical
  to the scorer's prompt.
- The daemon owns all logic. The executor receives only the approved set and
  asserts it. Every removal and edit is recorded as a decision.
- Agent desk rules: window-scoped screenshots only, its own browser profile,
  history pruning.

## Screens

### 1. Home (mockup 4, top)

- Heading "What should the agent do?" above a centered composer.
- **Composer.** Multiline text. `+` attaches images; drag-drop and paste also
  work. Thumbnails show above the text with a remove ×. Each attached image
  carries a one-line note: "Sent to <provider> with your task." The send
  button becomes **Stop** while a run is active. The same component is used
  in the chat column.
- **Suggestions**: three example tasks under the composer. A click fills the
  composer; it never sends.
- Top right: the **health pill** ("Ready", green), which replaces the source's
  Daemon / API key / model row. Click it for details. When something breaks it
  turns amber or red and shows a **Fix** link to the relevant wizard step.
  Next to it is a model picker.
- A chip shows which app the agent will use (for example "Chrome (agent's
  own)").

### 2. Review (mockup 3)

**Chat column (about 300 to 340 px):**
- The user's message, with its attachments.
- The assistant's plan message: "I'd do this in N steps … drag a loop around
  the ones you're OK with".
- Live status chips: N approved, N need a decision, N removed.
- A meta line: model, time, and cost.
- The composer, live. Typing a change re-proposes the plan (see API §2).

**Workspace:**
- **Header**: "Plan review", the X and Y axis selectors (each with an ⓘ that
  shows the definition string), and a Grid / Paper view toggle.
- **Canvas** (the rest of this section).
- **Step list** below the canvas. Each row has a status-colored number disc,
  the title, and actions: Approve for pending steps, edit ✎, and remove ⊘.
  Removed rows are struck through with Undo.
- **Action bar**:
  - A plain-language hint ("2 steps still need a decision").
  - **Approve all N**: checks every step that is not removed (today's Select
    All). N counts those steps.
  - The primary button, whose label always says exactly what will run. When
    no step is approved yet (K = 0), there is nothing to run, so the primary
    slot shows **Approve all N** and no run button appears. Otherwise:
    - "Approve & run" when nothing is pending.
    - "Run K approved, skip M" when some are pending. This records the M
      pending steps as removals with `source: "skip_undecided"`, then runs.
    - "Fix permissions to run" when the agent cannot run.
    - "Set up the agent to run this" in plan-only mode.

**Canvas behavior:**
- **Badges show the step number**, not a glyph. Hovering a badge highlights
  its row and vice versa. The hover card shows the title plus one-line
  rationales for both axes.
- **Camera.** A view transform sits between data space (0..1) and the screen.
  - Zoom: pinch, or ⌘ / Ctrl-scroll, anchored at the cursor.
  - Pan: two-finger scroll, space-drag, or the Pan tool.
  - Plain drag always draws (in the Draw tool, the default).
  - Toolbar: Draw, Pan, −, zoom %, +, Fit, Undo, Clear.
  - Minimap at bottom right, with the viewport rectangle.
  - Zoom range is about 50% to 800%. Fit frames all badges with padding.
- **Stacks.** Badges whose disks overlap at the *current zoom* render as one
  badge labeled "×N", colored by the shared status, or neutral when statuses
  are mixed. A click fans the members out in a ring with leader lines to the
  true point; Esc or a click outside collapses it. Fanned members can be
  approved or removed one at a time. A loop includes or excludes the whole
  stack, because the members really are at that point. Zooming in splits
  near-ties naturally; exact ties stay a stack at every zoom.
- **Coach hint** (first time only, dismissed after the first completed loop):
  "Drag a loop to approve · pinch or ⌘-scroll to zoom · two-finger drag or
  space-drag to pan".
- **Undo** covers polygon edits within the session: draw, handle drag, insert
  and delete vertex, move, clear.

### 3. Running (mockup 4, middle)

**Chat column:**
- A summary line: "Plan approved: steps 1, 2, 4 · skipped 3, 5, 6".
- One message per finished step: ✓ or ✗, the step's `summary` sentence, and a
  meta line "step N · K actions · Ts".
- A spinner line for the step in progress ("Drafting the WhatsApp message…").
- A **recap card** at the end:
  - The headline.
  - ✓ items done, each saying where the result is.
  - – items skipped, with the reason.
  - A collapsed **Details** with action count, duration, cost, and the full
    event log. The old log is available here and nowhere else.

**Workspace: Agent's desk.**
- A step progress bar.
- The latest window-scoped frame the model saw, with a pill: "only this window
  is visible to the model".
- In simulated mode, a placeholder.
- The window floats always-on-top while running, as it does today.

### 4. First-run setup (mockup 4, bottom)

Five steps with a progress strip, one obvious button each.

1. **Welcome.** What the agent can touch, and how to stop it (Stop button,
   kill hotkey once it exists).
2. **Model key.** Choose a provider (Anthropic, OpenAI) and paste the key. It
   is stored in the OS keychain and tested with a 1-token call before
   Continue is enabled.
3. **cua-driver.** Detect it and show the version. If it is missing:
   **Install** (runs the official script). If it is not running: **Start**.
4. **Permissions** (macOS):
   - Accessibility and Screen Recording rows, each with **Open Settings** that
     deep-links to the right pane.
   - The status turns green live (polled every 1 s).
   - The copy names **CuaDriver** as the switch to flip.
   - Windows and Linux show a single "n/a" row.
5. **Self-test.** Opens a scratch window, types "hello", screenshots it, and
   reads it back. Pass means done.

**"Skip, plan-only mode"** is available from step 3 onward: planning, scoring
and drawing work, and running does not. The wizard can be reopened from
Settings, and any health-pill **Fix** link opens it at the relevant step.

### 5. Paper view

The current components (`Header`, `Tabs`, `TaskCard`, `OversightPanel`,
`PlanPanel`, the footer, `ExecutionView`) move to `paper/` and read the same
session store and canvas. Glyph badges and the verbatim hint line are kept
there. It is reachable from the workspace toggle and from Settings. The parity
checklist in docs/04 is evaluated against this view.

## Front-end structure

```
app/src/
  theme/tokens.css     Graphite tokens, dark + light (prefers-color-scheme)
  state/session.ts     reducer for one task: phase, steps, scores, polygons,
                       checked, removed, events, attachments (out of App.tsx)
  shell/               AppShell, HistoryRail (GET /tasks, replay), HealthPill,
                       Settings
  home/                HomeScreen, Composer, Suggestions
  chat/                ChatThread, message components, eventsToMessages() (pure)
  workspace/           ReviewWorkspace, StepList, ActionBar, DeskView
  canvas/              BoundaryCanvas (composition), useCamera, useBoundaryGesture,
                       StackBadge/fan-out, Toolbar, Minimap, CoachHint
  setup/               SetupWizard + one component per step
  paper/               the current components, reskinned only where tokens change
  lib/approval.ts      unchanged
  lib/geometry.ts      unchanged (RDP, point-in-polygon, projection)
  lib/viewport.ts      new, pure: camera {scale, tx, ty}; zoomAt, panBy, fit,
                       clamp, dataToScreen, screenToData
  lib/stacks.ts        new, pure: group badges overlapping at a given scale
  api/                 client + mock extended with every new endpoint
```

**Rendering rule.** Pan and zoom change only the `transform` on one SVG `<g>`.
Badge, polygon, and handle geometry stays in data-scaled coordinates. Stroke
widths and handle and badge radii are counter-scaled, so they keep a constant
on-screen size. A pan must not re-render badges or reclassify.

**Hit-testing** keeps today's model (handle, edge, badge or stack, inside,
empty), done in screen space after mapping through the camera. Grab radii
stay in screen pixels.

## Tauri shell

`src-tauri/src/lib.rs` grows from a bare window into a daemon supervisor:

- On launch it spawns the daemon. In dev this is `uv run oversight-daemon`
  from `../daemon`. When bundled, it will be a sidecar binary (the seam is
  left in place; filled by the packaging sub-project).
- It polls `/health` until the daemon is ready and shows a splash until then.
- It restarts the daemon on exit with backoff (1 s, 2 s, 4 s). After 3
  failures it reports "the daemon won't start" plus the last 40 log lines.
- It kills the daemon on app quit.
- It exposes `daemon_status` and `daemon_log_tail` commands to the UI.

The shell holds no other logic. It does not open URLs, store keys, or check
permissions; the daemon does all of that.

## Daemon API changes (all additive)

### 1. Attachments

- `POST /attachments` (multipart) returns `{attachment_id, mime, bytes}`.
  - Accepts PNG, JPEG and WebP only, at most 5 MB each.
  - Stored under the data dir by sha256.
- `POST /task` gains `attachment_ids[]`, at most 4 per task, persisted with
  the task.
- `llm.call()` gains `images=`, which builds Anthropic and OpenAI image
  blocks. The planner passes the task's attachments.
- The scorer stays text-only.
- Replaying a task reuses the same stored images.

### 2. Revise and edit

- `POST /task/{id}/repropose` is built per docs/01 step 6, with an optional
  `instruction` string added.
  - Planner input: the original task, the attachments, the current steps
    annotated approved / removed / edited, and the instruction.
  - Only new or changed steps are re-scored. `revision` goes up.
  - Progress streams as `plan_progress`.
- `PATCH /task/{id}/step/{step_id}` takes `{title?, description?}`.
  - It sets `edited_from` and records an `edit` decision.
  - It re-scores that step.

### 3. Run narration

- `step_result` gains `actions` (count) and `duration_ms`.
- New `frame` event: `{step_id, seq}`. The image is served by
  `GET /task/{id}/frames/{seq}.jpg`, which is the window-scoped capture
  already taken for the model. Images are never embedded in SSE.
- New `run_recap` event, emitted before `final_result`. It comes from one
  structured LLM call over the step summaries:

  ```
  {headline: str,
   done: [{step_id, text}],
   skipped: [{step_id, reason}],
   source: "llm" | "fallback"}
  ```

  If the call fails, a deterministic fallback builds it from the step
  summaries and statuses. A run always ends with a recap. Its cost is counted
  like any other LLM call.

### 4. Skipping undecided steps

The UI posts `decision {action: "remove", source: "skip_undecided"}` for each
pending step, then calls `/run` as today. There is no new execution path, and
the 409 check and the executor assertion are unchanged.

### 5. Setup (new `oversight/setup.py`)

| Endpoint | Behavior |
|---|---|
| `GET /setup/status` | `{key: {present, source: keychain\|env, tested}, driver: {installed, version, running}, permissions: {accessibility, screen_recording}` (each `granted\|denied\|unknown\|n/a`)`, self_test: {passed_at\|null}, complete, plan_only}` |
| `PUT /setup/key` | `{provider, key}`. Stores the key via `keyring`, tests it with a 1-token call, returns `{ok, error?}`. Never echoes the key. |
| `POST /setup/driver/install` | Runs the official install script and returns `{ok, version?, log_tail}`. |
| `POST /setup/driver/start` | `open -n -g -a CuaDriver --args serve` on macOS. |
| `POST /setup/permissions/open` | `{which}`. The daemon opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` (or `?Privacy_ScreenCapture`). |
| `POST /setup/self-test` | Scratch window, type "hello", screenshot, read it back. Returns `{ok, detail}`. |
| `PUT /settings` | `{provider?, model?, plan_only?}`, persisted in SQLite. |

Key precedence: keychain, then env / `.env`. Current dev setups keep working.
If the keychain is unavailable, the daemon falls back to env and reports a
warning in `/setup/status`.

`/health` gains `setup_complete` and `plan_only`. Every existing field stays,
because Paper view reads them.

## Error handling

| Failure | UI |
|---|---|
| Daemon down | The pill goes red and a "Reconnecting…" line appears. The composer is disabled with the reason. After 3 failed restarts: "The daemon won't start", the log tail, and **Copy log**. |
| Planning or repropose fails | An assistant error message with **Try again**. The prompt and attachments are kept. |
| Permissions missing or revoked | The pill turns amber with **Fix**. The primary button becomes "Fix permissions to run". |
| Plan-only mode | The primary button becomes "Set up the agent to run this". |
| Step fails | A ✗ message with the summary. The recap lists what did not run and why. |
| `/run` 409 | "Nothing ran", plus the expected vs received step numbers. |
| Bad attachment | An inline error on that thumbnail (type or size). |
| Keychain unavailable | A wizard warning, with env fallback. |

## Testing

- **UI unit** (`node --test`, as in `tests/geometry.test.mts`):
  - `viewport`: zoomAt keeps the point under the cursor fixed; fit contains
    every badge; screen↔data round-trips.
  - `stacks`: exact ties always stack; near-ties split above a computable
    scale.
  - `eventsToMessages`: event sequences produce the expected messages, and a
    replay of stored events renders the same as the live run.
  - The existing approval tests stay green.
- **Daemon** (pytest):
  - setup endpoints against a fake driver and fake keyring
  - attachment validation and limits
  - repropose with an instruction
  - step edit records a decision
  - recap from the LLM and from the fallback
  - `skip_undecided` decisions are stored
  - the executor still raises on any unapproved step
- **Mock daemon.** `api/mock.ts` implements every new endpoint, so the whole
  UI runs with no daemon, key, or permissions.
- **Playwright** against the mock:
  - draw a loop
  - zoom and pan
  - fan out a stack and approve one member
  - "Run K approved, skip M"
  - a simulated run narrates and ends with a recap
  - walk through the wizard
- **Canvas feel.** With 30 badges, the time from a synthetic `pointermove` to
  the next painted frame (`requestAnimationFrame`) stays under 16 ms during a
  handle drag and a pan.
- **Human gate.** Someone who isn't the developer launches the app and
  reaches a first plan in under 2 minutes, with no terminal commands beyond
  launching it.

## Build order (stop at every gate)

1. **Theme, shell, home, chat, workspace layout**, using today's canvas
   unchanged. *Gate:* the full flow (prompt, plan, loop, run) works in the new
   layout in mock mode.
2. **Canvas**: camera, toolbar, minimap, numbered badges, stacks and fan-out,
   coach hint, undo. *Gate:* unit tests, Playwright canvas flows, and the
   feel check. This milestone gets the most time.
3. **Run narration**: step messages, desk frames, recap (daemon and UI).
   *Gate:* a simulated run reads as a chat and ends in a recap. A live run
   too, if permissions are granted.
4. **Setup**: daemon `setup.py`, the wizard, the shell supervisor. *Gate:* the
   human gate.
5. **Attachments, revise from chat, step edit.** *Gate:* an attached image
   reaches the planner; "change step N…" re-plans in place.
6. **Paper view and docs.** Paper view runs on the shared store, and the
   parity checklist is re-checked against it. CLAUDE.md records decision C.
   docs/02 is labeled as the Paper view spec. RUNNING.md describes the
   app-launches-daemon flow.

## Out of scope

- Installers, code signing, notarization, and the PyInstaller sidecar (the
  next sub-project; blocked on the Apple Developer ID question in docs/05).
- Windows and Linux permission handling beyond an "n/a" row.
- The Impact tab, boundary candidates, and the kill hotkey.
- A Canvas2D renderer (SVG stays unless badge counts force it).
