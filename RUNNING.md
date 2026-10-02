# Running the Sketch Oversight demo

This covers the same-day demo build (docs/07 scope). Run all commands from the
`appdev/` checkout on `main`. The path contains spaces, so quote it.

```sh
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
```

## 1. Prerequisites

| Tool | Version checked | Notes |
|---|---|---|
| uv | 0.12.x | Manages Python 3.12 and the daemon venv. No global Python packages needed. |
| Node + npm | Node 22.x | For the React app and the Tauri CLI. |
| Rust (repo-local) | in `.toolchain/` | Only for `npm run tauri dev`. The browser fallback does not need it. |
| cua-driver | 0.32.0 | `/Applications/CuaDriver.app`, CLI at `~/.local/bin/cua-driver`. Only for live execution. |
| API key | `ANTHROPIC_API_KEY` | Only for the real planner and scorer. |

### API key

The daemon reads the first `.env` it finds walking up from `daemon/`, and it
also checks `testing/.env` at each level. On this machine the key comes from
`../testing/.env`. The provider is Anthropic when `ANTHROPIC_API_KEY` is set,
otherwise OpenAI. You can override this with:

- `OVERSIGHT_PROVIDER` (`anthropic` or `openai`)
- `OVERSIGHT_MODEL`: the planner and scorer model. Default `claude-sonnet-5-5`.
- `OVERSIGHT_EXEC_MODEL`: the executor model. Default `claude-opus-5-5`.
- `OVERSIGHT_DATA_DIR`: where the SQLite store lives. Default `daemon/.data`.

### Install dependencies (once)

```sh
(cd daemon && uv sync)
(cd app && npm install)
```

### Repo-local Rust toolchain (Tauri only)

Export this in every shell that runs `npm run tauri ...`:

```sh
export CARGO_HOME="/Users/hrudaynara/Research/Security CUAs Week 1/appdev/.toolchain/cargo" \
       RUSTUP_HOME="/Users/hrudaynara/Research/Security CUAs Week 1/appdev/.toolchain/rustup" \
       PATH="/Users/hrudaynara/Research/Security CUAs Week 1/appdev/.toolchain/cargo/bin:$PATH"
```

### cua-driver and the macOS permissions (live execution only)

1. Install it if it is missing: `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`
2. Start its daemon: `open -n -g -a CuaDriver --args serve`
3. Grant the permissions with `cua-driver permissions grant` and follow the
   dialogs. You can also do it by hand in System Settings > Privacy & Security:
   enable **CuaDriver** under **Accessibility** and under **Screen & System Audio
   Recording**, and allow the quit-and-reopen if macOS asks.
4. Verify:
   - `cua-driver permissions status` shows both permissions granted.
   - `cua-driver call get_cursor_position '{}'` prints a position, not `permissions_pending`.
   - While the daemon runs, `curl -s 127.0.0.1:8765/health` shows `"cua_driver": true`.

As of 2026-10-01 both permissions still read "unknown" on this Mac. Live
execution is blocked until they are granted. See BLOCKERS.md.

## 2. Start the daemon (port 8765)

Pick one mode. Each runs in the foreground and logs to stdout, so leave it in
its own terminal.

```sh
cd daemon

# Fixtures: the hand-authored docs/00 plan (6 steps) with fixed scores.
# No API calls, $0, simulated executor. Use this for rehearsal.
uv run oversight-daemon --fixtures

# Real planner and scorer with the simulated executor. Costs about $0.11 per
# plan. The safe demo when cua-driver is not granted.
uv run oversight-daemon --exec simulated

# Real planner and scorer with the live executor (cua-driver drives the agent's
# own Chrome). This needs the permissions above.
uv run oversight-daemon
```

Optional flags: `--port N` and `--host H`. To keep fixture rehearsals out of
the real store, prefix the command with `OVERSIGHT_DATA_DIR=/some/dir`.

Check the daemon is up:

```sh
curl -s 127.0.0.1:8765/health
```

Look at `status_line`, `cua_driver`, `cua_driver_detail` and `exec_mode`.

In live mode, if cua-driver is not usable, `POST /task/{id}/run` returns HTTP
503 "live executor unavailable ... Nothing ran". The UI shows this as
"Run failed (503)". Nothing is recorded and nothing runs.

## 3. Start the app (port 1420)

### Native window (Tauri)

```sh
cd app
# export the repo-local Rust env first (section 1)
npm run tauri dev
```

`tauri dev` starts Vite on 1420 by itself (`beforeDevCommand`), so do not also
run `npm run dev`. The first compile takes about 20 s. The window is titled
"Agent Oversight".

### Browser fallback

```sh
cd app
npm run dev        # then open http://localhost:1420
```

At startup the app probes `http://127.0.0.1:8765/health`. If the daemon is
unreachable, the app silently switches to an in-browser mock daemon, and the
Daemon pill tooltip says so. Start the daemon first. If you started it after
the app, reload the page.

- `npm run dev:mock` or `?mock` in the URL forces the mock.
- `VITE_DAEMON_URL` points the app at another daemon.

## 4. Demo: the tennis-racket task

Terminal 1, daemon:

```sh
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev/daemon"
uv run oversight-daemon --exec simulated      # or: uv run oversight-daemon (live, needs grants)
```

Terminal 2, app:

```sh
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev/app"
npm run tauri dev                             # or: npm run dev, then open http://localhost:1420
```

Click path:

1. **Header check.** The pills read Daemon, API key, the model name and a
   running cost. The status line comes from `/health`.
2. **Task boundary.** The tennis-racket prompt is pre-filled: "Help me find a
   tennis racket less than $100 for my friends birthday present, and prepare a
   short message to my other friends to let them know I am planning a party via
   whatsapp." You can edit it.
3. Click **Generate plan**. The card shows "Planning", then "Preparing
   oversight view... Scoring actions and placing them on the grid." with
   per-step progress. Real mode takes about 13 s. Fixtures take under 1 s.
4. **Sketch Oversight canvas.** The axes default to Action uncertainty ×
   Reversibility. Each axis definition sits under its dropdown. All badges
   start orange (pending).
5. **Draw a boundary.** Press in an empty area of the grid near the low/low
   corner (bottom left). Drag a loop around the search and compare badges
   (magnifier and scales), then release. The approved and pending counts change
   while you draw.
6. **Reshape it.** Drag a handle and watch a badge turn green mid-drag.
   Double-click an edge to add a handle. **Clear** removes the polygon.
7. **Plan panel.** On every step you will not approve, click the circled X:
   cart, WhatsApp, recipients, send, and in a real plan also the "present" and
   "draft" steps. The card is struck through with "Removed by oversight -
   excluded from the plan" and an **Undo** button. A checkbox also approves a
   step, and **Select All** checks every step not yet removed.
8. Until no step is pending, **Approve & Run** stays disabled under the hint
   "Select all actions (draw a region or check them) to enable Approve & Run."
   Once nothing is pending, click it.
9. **Execution view.**
   - Plan progress keeps the original step numbers.
   - The **Stop** button sits next to Plan progress.
   - The **Removed action** block shows "Task continued with -> Remaining steps
     in the plan".
   - **Final result** reads "All approved steps were attempted."
   - **Why this mattered** lists the riskiest removed step first, with its
     categorical verdicts.
   - Expand "Proposed actions and results" for the live log: executing, cost,
     considerations scored, and each action and step result.
10. Click **New task** to start again.

For live runs, the BLOCKERS.md plan is to approve only search and compare.
Before a live run, check that `wc -l < LIVE_RUNS.log` is below 3. The project
cap is 3 live runs of at most 25 actions each. Afterwards, append one line:
`<date> <who> <what> <actions used>`.

## 5. Replay a saved task without paying again

Every task, plan, score set, boundary, decision, run and SSE event is stored in
SQLite. The UI has no saved-task picker yet: **Generate plan** always creates a
new task and calls the planner again. Replay through the API instead. A
browser on 1420 is not needed for this.

```sh
B=http://127.0.0.1:8765

# 1. List saved tasks (id, prompt, step count)
curl -s $B/tasks

# 2. Pick one. The real plan from 2026-10-01 is tsk_f10e4b041323 (7 steps, $0.108).
T=tsk_f10e4b041323

# 3. Replay the plan. With no ?force=true this returns the stored steps and
#    scores and makes no LLM call. ?force=true regenerates and costs money.
curl -s -X POST $B/task/$T/plan

# 4. Inspect everything: steps, scores, boundaries, decisions, runs, llm_calls, cost_usd
curl -s $B/task/$T

# 5. Re-run the last approved set. With "boundaries": null the daemon reuses the
#    stored boundary, re-checks the approval rule, and returns 409 on a mismatch.
BODY=$(curl -s $B/task/$T | python3 -c "
import json,sys; r=json.load(sys.stdin)['runs'][-1]
print(json.dumps({'approved_step_ids': r['approved'], 'checked_step_ids': [],
                  'removed_step_ids': r['removed'], 'boundaries': None}))")
curl -s -X POST $B/task/$T/run -H 'content-type: application/json' -d "$BODY"

# 6. Watch the run over SSE (Ctrl-C to stop), or stop it
curl -s -N "$B/task/$T/events?since=0"
curl -s -X POST $B/task/$T/stop
```

Run step 5 against `--exec simulated` unless you mean to spend a live run. In
live mode it drives the real desktop.

## 6. Where data and logs live

| What | Where |
|---|---|
| SQLite store: tasks, steps, scores, boundaries, decisions, runs, events, llm_calls, score_cache | `daemon/.data/oversight.db` (gitignored). Fixtures and real mode share it unless `OVERSIGHT_DATA_DIR` is set. |
| Daemon log | stdout of `uv run oversight-daemon`. Redirect it if you want a file. |
| Per-call cost and latency | the `llm_calls` table, `GET /task/{id}` (`llm_calls`, `cost_usd`), and `/health` (`cost_usd_total` since start, `cost_usd_all_time`) |
| Dimension definitions (scorer and UI tooltips) | `daemon/oversight/dimensions.yaml`, served at `GET /dimensions` |
| Agent Chrome profile | `.agent-desk/chrome-profile/` (gitignored) |
| Executor smoke gate screenshot | `.agent-desk/smoke.png`, from `uv run daemon/scripts/exec_smoke.py` |
| Live run ledger | `LIVE_RUNS.log` (gitignored, max 3 lines) |
| Things that need a human | `BLOCKERS.md` |

Agent screenshots during a run are window-scoped and kept in memory only. The
model sees the last 3; older ones are pruned. They are not written to disk.

## 7. Tests

```sh
(cd daemon && uv run pytest -q)     # 46 passed on 2026-10-01
(cd app && npm run typecheck)       # tsc clean
```

## Known issues

- **Live execution has never run on the real desktop.** CuaDriver's
  Accessibility and Screen Recording permissions are still pending, so every
  end-to-end check so far used the simulated executor. `LIVE_RUNS.log` has 0
  of 3 runs used. In live mode the daemon reports `cua_driver: false` and
  refuses runs with 503 until the grants exist.
- **Chrome's omnibox and background AX typing are unverified.** If typing into
  the address bar fails live, the next fallback is cua-driver's `browser_*`
  CDP tools (see the executor notes).
- **The UI cannot open a saved task.** Replay is API-only (section 5). In the
  UI, Generate plan always makes a new planner call. Scorer calls are cached
  only when a step's task, title and description match exactly.
- **Fixture rehearsals write to the real store by default.** Fixtures and real
  mode share `daemon/.data/oversight.db`. Set `OVERSIGHT_DATA_DIR` to keep them
  apart.
- **Mock fallback is silent.** If the daemon is down when the app starts, the
  app uses the in-browser mock. Start the daemon first, or reload after
  starting it.
- **Real scores cluster near low/low.** The canvas pushes overlapping badges
  apart for display and draws a dashed leader to each badge's true point.
  Approval always uses the raw scored position, so a badge drawn just inside
  the polygon can still be pending if its true point (the leader dot) is
  outside. Draw the loop around the dots.
- **Stop is a button only.** There is no global kill hotkey yet.
- **The executor supports Anthropic only.** The OpenAI planner and scorer path
  is untested.
- **No Jev scorer.** The frontier-model scorer is the only implementation.
- **Cut for the sprint, still designed in docs/05 and docs/06.** These are
  shown disabled or absent in the UI:
  - Re-propose plan, inline step editing (the pencil) and the Impact tab
  - the Boundary candidate block
  - the setup wizard, keychain, installers, signing, PyInstaller sidecar
  - Windows and Linux, and the virtual-display agent desk
  - the shared `cua-common` package (`testing/` is imported directly)
- **"Considerations scored" appears twice in the log.** Once at plan time and
  once when the run starts.
- **Agents cannot screenshot the native Tauri window** without Screen Recording
  permission for the terminal. Verification used Playwright page screenshots
  of the same React app on 1420.
- **ruff with a strict global config reports 17 style findings** in daemon
  code. None of them are functional.
