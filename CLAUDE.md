# Brief for the coding agent

You are rebuilding **Sketch Oversight** (UIST 2026, Monterio / Koey / Das) as a
cross-platform desktop app (macOS, Windows, Linux) that a user can install
with no setup beyond a first-run wizard. The agent works on its own desk on
the user's machine. The source material is a submission video. Stills from it are
in `reference/` and everything readable in them is written down in
`docs/00-source-analysis.md`.

Read in this order: `docs/00-source-analysis.md`, then `docs/02-ui-spec.md`,
then `docs/01-architecture.md`, then `docs/04-build-plan.md`, then
`docs/05-portable-harness.md` and `docs/06-peripheral-integration.md`.
Where 05 or 06 conflict with 01 or 04 (stack, packaging, build order), 05 and
06 win. The data model, pipeline, daemon API, and scoring model in 01 and 03
are unchanged.

`docs/07-sprint-cut.md` is the build order to use first: a cut-down same-day
demo. Build what it lists, in that order, then continue with the full plan in
05 and 06. Everything 07 cuts is still designed in 05 and 06. Look at every
image in `reference/` before writing UI code. Build milestone by milestone and
stop at every gate.

## The one thing that matters

The boundary gesture is the paper. Everything else is scaffolding around it.
If the polygon drawing, handle dragging, double-click-to-add-vertex, and live
point-in-polygon reclassification of the plotted actions do not feel
immediate and physical, the replica has failed regardless of how correct the
rest is. Budget accordingly: spend real time on that canvas.

## Non-negotiables

**Parity before improvement.** The parity checklist in `docs/04-build-plan.md`
is the definition of done for week one. Do not build anything from the
improvements list until it is green. This is stated because the improvements
are more interesting than the parity work and that is exactly the trap.

**The daemon owns all logic.** The UI renders and captures gestures. Planning,
scoring, execution, and persistence live in the Python daemon. The app should
be replaceable by a curl script without losing capability. The source app's own
status row ("Daemon / API key / model") implies this same split, so it is also
the parity-correct design.

**Scores are structured, never parsed out of prose.** Each dimension returns a
typed verdict with a categorical label and a numeric position, not a sentence
you regex. See `docs/03-scoring-model.md`.

**Nothing executes outside the boundary.** The approved set is computed from
the boundary polygon and the explicit checkboxes, and the executor takes that
set as its only input. There must be no code path where an unapproved step can
run. Write this as an assertion in the executor, not a convention.

**The agent only sees its own desk.** Screenshots are of the target window
(or the agent's virtual display), never the full screen, and the agent uses
its own browser profile. Old screenshots are pruned from history. These are
the fixes for what `testing/` measured; build them as flags so `testing/` can
toggle them as experimental conditions. See `docs/06-peripheral-integration.md`.

**Every removal and edit is a training signal.** When the user removes or edits
a step, record what they did and why the step was placed where it was. This
feeds the boundary-candidate feature, which is the most valuable thing in the
system.

## Stack

| Concern | Choice |
|---|---|
| App | Tauri 2 + React + TypeScript (native webview on macOS, Windows, Linux) |
| Canvas | SVG with pointer events and custom hit testing (Canvas2D only if badge count gets large). Must feel as immediate as native |
| Daemon | Python 3.12, FastAPI, SSE. Frozen with PyInstaller and shipped as a Tauri sidecar so users never install Python |
| Agent substrate | trycua `cua-driver` on all three OSes (the source app names `cua-driver` in its title bar). Accessibility tree first, pixels as fallback |
| Executor interface | `peripheral.vm.base.Environment` from `testing/`, via a shared package. New impl: `HostDeskEnvironment` |
| Planner | Frontier model, structured output, provider is a setting (Anthropic, OpenAI, Ollama). The source used gpt-5.5 |
| Secrets | OS keychain, entered in the first-run wizard |
| Scorer | Jev typed classifier preferred, frontier model behind the same interface as fallback |
| Store | SQLite |

## Conventions

- Dimension definitions live in one place, `dimensions.yaml`, and are read by
  both the scorer and the UI. The axis tooltip text in the app must be the
  same string the scorer was given, or the grid is lying to the user.
- Grid coordinates are always normalized 0 to 1 per dimension. The view scales.
- Every plan, boundary, score set, and run is persisted and replayable. You
  will demo this repeatedly and re-running a saved plan beats re-generating one.
- Cost and latency counters on every LLM call, shown in the UI. The source app
  displays a running cost, so this is parity, not polish.

## Do not

- Do not reimplement the CUA action layer. Use `cua-driver`.
- Do not copy code from `testing/`. Import it through the shared package.
- Do not send full-screen screenshots to a model provider.
- Do not invent extra dimensions. There are exactly ten, listed in
  `docs/03-scoring-model.md`, transcribed from the video.
- Do not make the boundary a rectangle or a threshold slider. It is a freeform
  polygon with draggable handles. That is the contribution.
