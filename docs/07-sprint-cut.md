# 07. Sprint cut: a working demo in one afternoon

Overrides the build order in 04 and 05 for a hard deadline of a few hours.
Goal: on Hruday's Mac, type the tennis-racket task, get a scored plan on the
grid, draw a boundary, hit Approve & Run, and watch the agent do the approved
steps in the background through cua-driver. Everything else is cut.

## In scope

- Daemon (Python, FastAPI, SSE, SQLite), run with `uv run`. No PyInstaller.
- Real planner + scorer, one provider (Anthropic or OpenAI, whichever key is
  in `.env`). One scorer call per step, all ten dimensions, typed JSON.
- Tauri 2 + React UI, run with `npm run tauri dev`. No installers, no signing.
  If Tauri setup fights back for more than 20 minutes, run the same React app
  in the browser against the daemon and move on.
- Boundary canvas: freehand polygon, draggable handles, double-click to add a
  handle, Clear, live point-in-polygon during drag, live counts.
- Plan panel: checkbox, remove, Select All. Approve & Run gating.
- Executor: approved steps only (assertion), cua-driver on the host, AX tree
  first, window-scoped screenshots, own Chrome profile, kill hotkey or at
  minimum a Stop button. SSE progress into an execution view.
- "Why this mattered" from stored scores.

## Cut (say so in the demo, they're in 05/06)

Windows and Linux verification, setup wizard, keychain, installers, signing,
virtual-display agent desk, re-propose, step editing, boundary candidates,
Impact tab, shared `cua-common` package (import from `../testing` directly for
now), Peripheral evaluation runs.

## Parallel sessions

Run three Claude Code sessions at once, each in its own git worktree, all
coding against the daemon API in `01-architecture.md` (that's the contract):

| Session | Owns | Done when |
|---|---|---|
| A: daemon | `daemon/`: API, store, planner, scorer, `dimensions.yaml`, fixture mode | `curl` returns a 6-step plan with 10 typed scores each, real and fixture |
| B: UI | `app/`: Tauri + React, canvas, plan panel, execution view, against fixture mode | polygon drag updates counts live |
| C: executor | `daemon/oversight/executor.py` + cua-driver wrapper | from a Python script: open Chrome (own profile), search "tennis rackets under $100", screenshot the window only, in background |

Merge order: A, then B and C onto it. Integration last.

## Timeline

| Time | What |
|---|---|
| 0:00 to 0:20 | git init, prereqs, cua-driver install + grant permissions, `.env` with key |
| 0:20 to 2:00 | A, B, C in parallel |
| 2:00 to 3:00 | merge, wire UI to real daemon, first real end-to-end run |
| 3:00 to 4:00 | fix what broke, record the demo |
