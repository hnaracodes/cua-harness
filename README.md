# Sketch Oversight replica

Rebuild of the system in **Sketch Oversight: Drawing Decision Boundaries for
Delegated AI Agent Actions** (UIST 2026), Kyzyl Monterio*, Takeshi Koey*,
Sauvik Das, Carnegie Mellon University.

Target: 1-to-1 behavioral parity within a week, then a small number of
deliberate improvements where the original leaves an obvious gap.

## The idea in one paragraph

A single delegated task contains actions at wildly different risk levels.
"Find a birthday gift and let friends know I'm planning something" decomposes
into searching for gifts (fine), comparing options (fine), drafting a message
(needs judgment), and buying with a saved card (not fine). Existing controls
offer three bad options: always allow, deny, or ask at every step. Sketch
Oversight instead scores every proposed action across ten risk dimensions,
plots the actions on a 2D projection of two dimensions the user picks, and lets
the user **draw a polygon around the region they are comfortable approving**.
Inside the boundary runs autonomously. Outside does not.

## Folder map

| Path | What it holds |
|---|---|
| `CLAUDE.md` | Brief for the coding agent. Read first. |
| `docs/00-source-analysis.md` | Everything observable in the source video, reverse engineered |
| `docs/01-architecture.md` | System design, daemon and app split, data model |
| `docs/02-ui-spec.md` | Screen by screen, component by component |
| `docs/03-scoring-model.md` | The ten dimensions, scoring engine, grid placement |
| `docs/04-build-plan.md` | Milestones with gates, week plan, parity checklist |
| `docs/05-portable-harness.md` | Cross-platform, easy-install version: Tauri, cua-driver, agent desk, wizard. Supersedes the stack in 01/04 |
| `docs/07-sprint-cut.md` | Deadline mode: what to build first for a same-day demo, parallel sessions, timeline. Do this first, then continue with 05/06 |
| `docs/06-peripheral-integration.md` | How last week's `testing/` findings shape this app, shared code, evaluation conditions |
| `reference/` | Stills from the source video, cited by the specs |

## Starting the build

> Same-day demo: read CLAUDE.md and docs/07, follow its parallel-session plan.
>
> Full build: read CLAUDE.md, then docs/00, 02, 05 and 06. Look at every image in
> reference/. Extract the shared package from testing/ (06, step 1), then
> build M0 and M1 on the Tauri stack. Stop at the M1 gate.

Parity first, improvements second. The improvements in
`docs/04-build-plan.md` are ordered by value, and every one of them is
optional until the parity checklist is green.
