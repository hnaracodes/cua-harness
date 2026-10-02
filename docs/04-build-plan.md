# 04. Build plan

> **Superseded in part.** The parity checklist and milestone gates still define done. The week plan and the SwiftUI references are replaced by the build order in `05-portable-harness.md` (Tauri, cross-platform, agent desk) and the work order in `06-peripheral-integration.md`.

## Parity checklist

This is the definition of done for week one. Nothing from the improvements
list gets built until every box here is checked.

- [ ] Window, header, status pills (Daemon, API key, model), status line
- [ ] Plan Review / Impact tabs (Impact may be a stub, it is never opened in the source)
- [ ] Task boundary card with editable prompt and Generate plan
- [ ] Planning state, then "Preparing oversight view / Scoring actions and placing them on the grid"
- [ ] Planner emits 4 to 8 steps with title, description, glyph
- [ ] All ten dimensions scored per step, with label, position, confidence, rationale
- [ ] X and Y axis dropdowns over all ten dimensions
- [ ] Selected dimension definition renders under each selector
- [ ] "Viewing through: X × Y" sub-line
- [ ] Badges plotted at scored positions, glyph inside, three status colors
- [ ] Freehand drawing produces a closed polygon with draggable handles
- [ ] Double-click an edge inserts a handle
- [ ] Clear button removes the boundary
- [ ] Live reclassification during drag, not on release
- [ ] Approved / pending / removed counts update live in the panel header
- [ ] Legend
- [ ] Plan panel with Select All, per-step checkbox, pencil, circled X
- [ ] Inline step editing
- [ ] Removed steps struck through with "Removed by oversight - excluded" and Undo
- [ ] Checkbox and polygon reconcile into one approved set
- [ ] Start over / Re-propose plan / Approve & Run
- [ ] Approve & Run disabled until no step is pending, with the verbatim hint line
- [ ] Re-propose sends decisions back to the planner and produces a revised plan
- [ ] Execution drives cua-driver on the real desktop
- [ ] Plan progress checklist with preserved original indices
- [ ] Live log: executing, elapsed, cost, considerations scored, per-step results
- [ ] Removed action block with "Task continued with -> Remaining steps in the plan"
- [ ] Final result block
- [ ] "Why this mattered" with per-dimension categorical verdicts
- [ ] "Boundary candidate" with an induced natural-language rule and source action
- [ ] New task

## Milestones

**M0. Daemon skeleton and data model.** FastAPI, SQLite, `dimensions.yaml`,
the full data model, SSE plumbing, a fake planner and fake scorer returning
fixtures.
*Gate:* `curl` the API, get a six-step plan with ten scores each, from
fixtures. The app does not exist yet and that is fine.

**M1. The boundary canvas.** SwiftUI app shell, talk to the daemon, render
badges from fixture scores, and build the polygon interaction completely:
freehand draw, simplify, handles, drag, double-click insert, clear, live
point-in-polygon.
*Gate:* draw a boundary around fixture badges and watch the counts update
during the drag. Show it to someone. If it does not feel good, stop and fix it
before building anything else, because nothing later rescues a bad canvas.

Doing M1 before the real planner is deliberate. The canvas is the risk.

**M2. Real planner and scorer.** Replace fixtures. `LLMScorer` first, Jev
behind the same interface when access lands. Content-hash caching. Run the
consistency experiment from `docs/03-scoring-model.md` section "Consistency"
point 4.
*Gate:* the tennis racket task from the video produces a six-step plan close to
the source plan, and scoring the same plan ten times gives position SD under
0.1 on every dimension.

**M3. Plan panel and reconciliation.** Step cards, check, edit, remove, undo,
Select All, approved-set reconciliation, Approve & Run enablement.
*Gate:* approve two steps by polygon and two by checkbox, remove one, and
confirm the approved set and counts are correct in all three places.

**M4. Re-propose.** Decisions to planner, revised plan, revision bump, grid
re-scores and re-renders.
*Gate:* edit "Select a recommended racket" to "Select a cheapest racket",
re-propose, and get a plan that respects it. This is exactly what the video
shows, so it is directly checkable against the source.

**M5. Execution.** Wire cua-driver, SSE progress, plan progress checklist with
preserved indices, live log, cost, removed action block, final result.
*Gate:* run the tennis racket task end to end against real Chrome and reach
"All approved steps were attempted."

**M6. Reflexive layer.** "Why this mattered" from the stored scores, rule
induction, boundary candidate panel.
*Gate:* remove "Send WhatsApp message", run, and get a boundary candidate that
reads close to "External communications require approval".

**M7. Parity pass.** Sit with `reference/` open and walk the checklist frame by
frame. Record a screen capture of your app doing the video's demo, in the same
order, and diff it against the original by eye.
*Gate:* the parity checklist is green.

## Week plan

Two projects in one week is tight, so this assumes `appdev` is the priority and
`testing` advances on shared work only.

**Day 1.** M0. Also build the shared cua-driver substrate here, since
`testing/` needs the same thing and building it twice is the main way this
week goes wrong. Ask Kyzyl about the Impact tab and the seven draft dimension
definitions today, the answers take time to come back.

**Day 2.** M1. All of it. The canvas is the project.

**Day 3.** M2. Planner and scorer, plus the consistency measurement. If
positions are noisy, spend the time fixing definitions rather than moving on.

**Day 4.** M3 and M4.

**Day 5.** M5. Execution against real Chrome is where unexpected time goes.

**Day 6.** M6 and M7. Record the parity demo.

**Day 7.** Improvements 1 and 2 if the checklist is green. Write up what
differs from the original and why, which is the document Kyzyl will actually
want to read.

## Improvements, ordered

Only after parity. Each is justified by something the source leaves open.

**1. Store and apply boundary candidates.** The source panel says "Preview
only - not stored". So the system induces a reusable rule and then discards it.
Storing them, applying them to future plans (pre-marking steps that match an
accepted rule), and letting the user manage the list turns a one-off gesture
into an actual policy system. This is the biggest gap and the most obviously
intended next step.

**2. Re-score at execution time.** The source scores at plan time. But an
action's real risk depends on what is on screen when it runs: "send message"
is a different action when the recipient field autocompleted to the wrong
person. Re-score each step immediately before executing it, and halt if it has
moved outside the boundary. This closes the plan-versus-execution gap, which
is the most defensible weakness in the original design, and it is the feature
that would make `testing/` able to catch things the plan-time version cannot.

**3. Render uncertainty.** The scorer returns confidence. A badge at a precise
point implies precision the score does not have. Draw low-confidence actions
as a halo or an ellipse rather than a dot, so the user can see when the grid
does not know. Nobody does this, it is honest, and it is cheap once the scorer
already returns confidence.

**4. Persist named boundaries.** "shopping", "comms", "work". Pick one when
starting a task, or auto-suggest by task similarity. Follows naturally from 1.

**5. Explain placement on hover.** The rationale string is already stored per
dimension for "Why this mattered". Surface it at plan time on badge hover, so
the user can interrogate a placement before drawing rather than only learning
why after the run.

**6. Fit the boundary from history.** After enough tasks, propose a polygon
from the user's past approve and reject decisions instead of making them draw.
This is the research-shaped one and it is also the easiest to over-invest in.
Leave it alone until 1 through 5 are done.

Resist the urge to add dimensions or make the boundary multi-dimensional. The
2D projection with a user-chosen slice is the paper's actual idea, and
"improving" it into a 10-dimensional hyper-boundary would delete the
contribution.

## Link back to `testing/`

Once M5 works, this app is a candidate for condition `C3` in the Peripheral
probe suite. Instead of a Jev threshold gating actions, a user-drawn boundary
does. Running the P1 through P6 probes against the app gives you a measured
answer to "does sketch-based oversight actually reduce privacy leakage, and at
what utility cost", which is a genuinely strong follow-up result and a
reasonable thing to bring to Kyzyl in week two.
