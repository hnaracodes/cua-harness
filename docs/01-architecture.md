# 01. Architecture

> **Superseded in part.** The SwiftUI app shell below is replaced by Tauri 2 + React, and the executor now targets the `Environment` interface shared with `testing/`. See `05-portable-harness.md` and `06-peripheral-integration.md`. The data model, pipeline, and daemon API here still stand.

## Split

```
+-- Agent Oversight.app (SwiftUI) ------------------------------+
|  Plan Review tab          Impact tab                          |
|  +---------------------+  +--------------------------------+  |
|  | BoundaryCanvas      |  | (contents unconfirmed)         |  |
|  |  polygon + handles  |  +--------------------------------+  |
|  |  action badges      |                                      |
|  |  axis selectors     |   PlanPanel                          |
|  +---------------------+    step cards, check/edit/remove     |
|           |                          |                        |
|           +---------- HTTP + SSE ----+                        |
+-------------------------|-------------------------------------+
                          |
+-- oversight daemon (Python, FastAPI) --------------------------+
|                                                                |
|   Planner  ---->  Scorer  ---->  Placement                     |
|   (LLM,           (Jev or        (10-D vector                  |
|    structured      LLM, typed     -> 2-D projection)           |
|    output)         verdicts)                                   |
|                                                                |
|   ApprovalSet = inside(polygon) union checked, minus removed   |
|                          |                                     |
|                          v                                     |
|   Executor  ---->  cua-driver  ---->  the real desktop         |
|        |                                                       |
|        +--> RuleInducer  -->  boundary candidates              |
|                                                                |
|   SQLite: tasks, plans, scores, boundaries, runs, events       |
+----------------------------------------------------------------+
```

The app captures gestures and renders state. It makes no decisions. Every
number it draws came from the daemon, and every approval it computes is sent
back to the daemon before anything executes.

## Data model

```python
@dataclass
class Task:
    id: str
    prompt: str              # the "Task boundary" text
    selected_app: str | None # "Selected app: Notes" in the source
    created_at: datetime

@dataclass
class PlanStep:
    id: str
    task_id: str
    index: int               # 1-based, preserved even when steps are removed
    title: str               # "Search for tennis rackets under $100"
    description: str
    glyph: str               # sf symbol name, chosen by the planner from a fixed set
    status: Literal["pending", "approved", "removed"]
    edited_from: str | None  # prior title, when the user edited it
    revision: int            # bumps on re-propose

@dataclass
class DimensionScore:
    step_id: str
    dimension: str           # one of the ten
    label: str               # categorical: "contradicted", "tangential", "medium"
    position: float          # 0..1, where on the axis the badge sits
    confidence: float        # 0..1
    rationale: str           # one line, shown on hover and in "Why this mattered"

@dataclass
class Boundary:
    id: str
    task_id: str | None      # null for a saved reusable boundary
    name: str | None         # "shopping", "comms", set when saved
    x_dim: str
    y_dim: str
    polygon: list[tuple[float, float]]   # normalized 0..1, closed implicitly

@dataclass
class BoundaryCandidate:
    id: str
    rule_text: str           # "External communications require approval"
    source_step_id: str
    stored: bool             # false in the source system, our improvement
```

## Pipeline

**1. Plan.** Task prompt to the planner, structured output, 4 to 8 steps with
title, description, and a glyph from a fixed enum. Temperature low. The step
list is the unit of user review, so steps must be individually meaningful and
individually refusable. A planner that emits "do the shopping" as one step has
destroyed the whole interaction.

**2. Score.** Every step against all ten dimensions. One call per step with all
ten questions, not ten calls. Returns a categorical label plus a numeric
position plus confidence plus a one-line rationale per dimension. See
`docs/03-scoring-model.md`.

**3. Place.** The UI picks two dimensions. Each step's badge sits at
`(score[x_dim].position, score[y_dim].position)`. Jitter collisions apart
deterministically, seeded by step id, so the layout is stable across re-renders
but overlapping badges are still individually clickable.

**4. Sketch.** The user draws a polygon. Point-in-polygon (ray casting, or
`CGPath.contains`) reclassifies every badge live during the drag, not on
release. Approval counts in the panel header update at the same time. This
tight loop is the feel of the product.

**5. Reconcile.** Approved set is the union of badges inside the polygon and
steps checked directly, minus removed steps. Changing the axes does **not**
reset approvals: switching projection reveals a different slice of the same
decision. Whether the polygon itself persists across an axis switch is
UNCONFIRMED in the source. Recommendation: keep one polygon per axis pair,
remember each, and show the count so the user can see the two views disagree.
That disagreement is interesting rather than a bug.

**6. Re-propose.** Sends the planner the original task plus the current step
list annotated with approved / removed / edited, and asks for a revised plan
that respects those decisions. Bumps revision. The source clearly supports
this ("Uncheck and re-propose to change them", and the edited step 2).

**7. Execute.** The executor receives only the approved set. For each step it
drives `cua-driver`, streams progress over SSE, and records results. Removed
steps render struck through in the progress list with "Task continued with ->
Remaining steps in the plan".

**8. Induce.** After the run, for each removed or unapproved step, ask the
model to generalize the decision into a short natural-language rule. Present as
a Boundary candidate. In the source this is preview-only. Storing and applying
these is improvement #1.

## Daemon API

```
POST /task                      -> {task_id}
POST /task/{id}/plan            -> {steps[], scores[]}         (SSE progress)
POST /task/{id}/repropose       body: decisions[]  -> revised plan
GET  /task/{id}/scores
PUT  /task/{id}/boundary        body: {x_dim, y_dim, polygon[]}
POST /task/{id}/run             body: {approved_step_ids[]}    (SSE events)
GET  /task/{id}/events          SSE stream
GET  /dimensions                -> the ten, with definitions
GET  /boundaries                saved reusable boundaries
POST /boundary-candidates/{id}/accept
```

The SSE event stream is what drives the execution view. Event kinds:
`plan_progress`, `step_started`, `step_result`, `action`, `cost`,
`consideration_scored`, `step_removed`, `final_result`, `boundary_candidate`.

## Repo layout

```
appdev/
  daemon/
    pyproject.toml
    oversight/
      api.py            # FastAPI + SSE
      planner.py
      scorer.py         # Jev and LLM backends behind one interface
      dimensions.yaml   # the ten, single source of truth
      placement.py      # 10-D to 2-D, collision jitter
      approval.py       # point-in-polygon, reconciliation
      executor.py       # drives cua-driver
      inducer.py        # boundary candidates
      store.py          # sqlite
  app/
    AgentOversight.xcodeproj
    Sources/
      OversightApp.swift
      PlanReviewView.swift
      BoundaryCanvas.swift      # the polygon. spend your time here
      ActionBadge.swift
      AxisSelector.swift
      PlanPanel.swift
      StepCard.swift
      ExecutionView.swift
      WhyThisMatteredView.swift
      DaemonClient.swift        # HTTP + SSE
  docs/
  reference/
```

## Sprint contract addendum (docs/07 scope)

Added for the same-day demo so the daemon, UI and executor workers code
against identical shapes. Everything above still stands; this only pins down
payloads the section above left open. Change it only by editing this file and
telling the other workers.

### Transport

- Daemon listens on `http://127.0.0.1:8765`. CORS allows any origin (Tauri
  webview and the Vite dev server on `http://localhost:1420`).
- All bodies are JSON. Errors are `{"error": str, ...}` with a 4xx/5xx status.
- Dimension keys are snake_case: `authorization_clarity`, `delegated_scope`,
  `target_correctness`, `reversibility`, `financial_commitment`,
  `sensitive_information`, `social_reputational_impact`,
  `environment_criticality`, `action_uncertainty`, `verifiability`.

### Shapes

```jsonc
// Step
{"id": "stp_...", "task_id": "tsk_...", "index": 1, "title": str, "description": str,
 "glyph": "search|compare|cart|message|send|contacts|browse|document|calendar|payment|settings|generic",
 "status": "pending|approved|removed", "edited_from": null, "revision": 0}

// Score (one per step per dimension, exactly 10 per step)
{"step_id": str, "dimension": "<key>", "label": str, "position": 0.0..1.0,
 "confidence": 0.0..1.0, "rationale": str}

// Dimension (from dimensions.yaml, the single source of truth)
{"key": str, "name": "Authorization clarity", "definition": str,
 "labels": [str, str, str, str],       // low risk to high risk
 "anchors": [0.125, 0.375, 0.625, 0.875]}  // centre of each label's band
```

`position` is always derived from the label: label `i` of `N` owns the band
`[i/N, (i+1)/N]`, and the scorer's within-label offset places the point inside
that band. A position can never sit in a different band from its label.

### Endpoints

```
GET  /health          -> {"daemon": "ok", "api_key": bool, "provider": "anthropic|openai|fixtures",
                          "model": str, "cua_driver": bool, "fixtures": bool,
                          "exec_mode": "live|simulated", "cost_usd_total": float,
                          "status_line": "Ready. cua-driver running, API key found, model <m>."}
GET  /dimensions      -> {"dimensions": [Dimension x10]}
GET  /tasks           -> {"tasks": [{"id", "prompt", "created_at", "step_count"}]}   // replay list
POST /task            body {"prompt": str, "selected_app": str|null} -> {"task_id"}
GET  /task/{id}       -> {"task", "steps", "scores", "boundaries", "runs"}          // full replay
POST /task/{id}/plan  -> {"task_id", "steps": [Step], "scores": [Score]}
                         Blocks until scored. Emits plan_progress + cost on the event stream meanwhile.
GET  /task/{id}/scores -> {"steps", "scores"}
PUT  /task/{id}/boundary body {"x_dim", "y_dim", "polygon": [[x,y],...]} -> {"boundary_id", "inside_step_ids"}
POST /task/{id}/decision body {"step_id", "action": "remove|restore|check|uncheck", "source": "plan_panel|grid"}
                         -> {"ok": true}. Recorded with a snapshot of the step's scores (training signal).
POST /task/{id}/run   body {"approved_step_ids": [], "checked_step_ids": [], "removed_step_ids": [],
                            "boundaries": [{"x_dim", "y_dim", "polygon"}]}
                         -> {"run_id"} or 409 {"error", "expected": [], "got": []}
POST /task/{id}/stop  -> {"stopped": true}
GET  /task/{id}/events?since=<seq>   SSE. Replays stored events after `since`, then streams live.
```

### Approval rule (identical in UI and daemon)

- A step is `removed` if removed. Otherwise it is `approved` if it is checked
  OR its point lies inside ANY stored polygon for any axis pair. Otherwise it
  is `pending`. One polygon per axis pair; switching axes does not reset
  approvals; Clear deletes only the polygon of the current axis pair.
- The point for axis pair (x, y) is the RAW `(score[x].position,
  score[y].position)`. Display jitter (deterministic by step id, at most 0.012
  normalized) is cosmetic and never used for classification.
- Inside test is the even-odd ray cast, written the same way in TS and Python:
  for each edge (i, j=i-1): `if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi): inside = !inside`.
- `POST /run` recomputes the approved set from the stored scores and the body's
  checked, removed and boundaries. If it differs from `approved_step_ids`, or
  any non-removed step is still pending, it returns 409 and nothing runs.

### SSE events

Every message: `event: <kind>` and `data: {"kind", "task_id", "run_id": str|null,
"seq": int, "ts": iso8601, "payload": {...}}`. All events are persisted.

| kind | payload |
|---|---|
| `plan_progress` | `{"stage": "planning|scoring|done|error", "message": str, "done": int, "total": int}` |
| `cost` | `{"scope": "plan|score|run", "model": str, "usd_delta": float, "usd_total": float, "latency_ms": int, "input_tokens": int, "output_tokens": int}` |
| `consideration_scored` | `{"step_count": int, "dimension_count": 10, "approved_count": int}` (first event of a run) |
| `step_removed` | `{"step_id", "index", "title"}` (one per removed step, at run start) |
| `step_started` | `{"step_id", "index", "title"}` |
| `action` | `{"step_id", "n": int, "mode": "ax|pixel|sim", "verb": str, "target": str, "detail": str, "ok": bool, "error": str|null}` |
| `step_result` | `{"step_id", "index", "status": "done|failed|stopped|skipped", "summary": str}` |
| `final_result` | `{"status": "completed|stopped|failed|capped", "message": str, "attempted": [ids], "completed": [ids]}` |
| `boundary_candidate` | reserved, cut for the sprint |

`final_result.message` is "All approved steps were attempted." when every
approved step was attempted.

### Executor interface (`daemon/oversight/executor.py`)

```python
@dataclass(frozen=True)
class ExecStep:
    id: str; index: int; title: str; description: str

class UnapprovedStepError(AssertionError): ...

@dataclass
class ExecConfig:
    mode: Literal["live", "simulated"] = "live"
    max_actions_per_run: int = 25
    max_actions_per_step: int = 10
    screenshot_history: int = 3          # prune older screenshots from model context
    window_scoped_screenshots: bool = True   # never full screen (flag for testing/)
    own_browser_profile: bool = True         # Chrome --user-data-dir (flag for testing/)
    ax_first: bool = True                    # accessibility tree before pixels (flag)
    chrome_profile_dir: str = "<appdev>/.agent-desk/chrome-profile"
    provider: str = "anthropic"; model: str = "<from settings>"

async def run_steps(task_prompt: str, steps: list[ExecStep], approved_ids: frozenset[str],
                    emit: Callable[[str, dict], Awaitable[None]], stop: asyncio.Event,
                    config: ExecConfig) -> dict: ...
```

`run_steps` raises `UnapprovedStepError` if any step id is not in
`approved_ids`, checked on entry and again immediately before each step
dispatches. The daemon passes only the approved steps. `emit(kind, payload)`
uses the SSE kinds above. `mode="simulated"` emits plausible `action` events
with `mode: "sim"` and never touches the desktop.

### Daemon modes

- `uv run oversight-daemon` : real planner and scorer, live executor.
- `uv run oversight-daemon --fixtures` : docs/00 tennis-racket plan and fixed
  scores, no API calls, simulated executor (add `--exec live` to override).
- Keys load from the first `.env` found walking up from `daemon/`, also
  checking `testing/.env` at each level.
