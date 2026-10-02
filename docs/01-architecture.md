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
