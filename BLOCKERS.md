
## [executor] cua-driver needs Accessibility + Screen Recording (2026-10-01 ~20:55)

cua-driver 0.32.0 is installed (/Applications/CuaDriver.app, CLI at ~/.local/bin/cua-driver)
and its daemon is running (`open -n -g -a CuaDriver --args serve`), but every tool call
returns `permissions_pending`. macOS has two permission prompts open right now
("Accessibility Access" and System Settings > Screen & System Audio Recording).

What to do:
1. System Settings > Privacy & Security > Accessibility: enable **CuaDriver**.
2. System Settings > Privacy & Security > Screen & System Audio Recording: enable **CuaDriver**
   (if macOS asks to quit and reopen, allow it).
3. Easiest path that drives the whole flow: run `cua-driver permissions grant` in a terminal
   and follow the dialogs.
4. Verify: `cua-driver permissions status` shows both granted, and
   `cua-driver call get_cursor_position '{}'` returns a position instead of `permissions_pending`.
5. Then run the executor gate: `cd appdev/.worktrees/executor && uv run daemon/scripts/exec_smoke.py`
   (add `--live` for the one live LLM run of step 1).

Fallback taken: executor built and tested against a fake driver; simulated mode works with no
permissions; live code paths are wired to the real cua-driver tool surface and run as soon as
the grants exist.

## worker-ui: window-scoped screenshot of the Tauri app (verification only, not a product blocker)

`npm run tauri dev` compiles and opens the native window titled "Agent Oversight"
(confirmed via CGWindowList: owner `agent-oversight`, window name "Agent Oversight").
`screencapture -l <windowid>` returned "could not create image from window" because the
terminal running Claude Code has no Screen Recording permission.

What to do (optional): System Settings > Privacy & Security > Screen & System Audio Recording,
enable the terminal app you run Claude Code from, if you want agents to screenshot the native
window. Fallback taken: the UI was verified visually with Playwright page screenshots of the
same React app at http://localhost:1420 (mock daemon), which is identical apart from vibrancy.

## [integrator] live agent execution still blocked on cua-driver permissions (2026-10-01 ~22:00)

Checked again at integration time: `cua-driver permissions status` still shows Accessibility
and Screen Recording "unknown", and `cua-driver call get_cursor_position '{}'` exits 75
`permissions_pending`. No live agent run was made (LIVE_RUNS.log still 0 lines, 3 runs left).

What to do: same steps as the [executor] entry above (`cua-driver permissions grant`, enable
CuaDriver in both Privacy panes). Then verify with `curl -s 127.0.0.1:8765/health` while the
daemon runs: `"cua_driver": true` and the status line reads "Ready. cua-driver running ...".

Then run the live demo:
1. `cd appdev/daemon && uv run oversight-daemon` (real planner + scorer, live executor).
2. `cd appdev/app && npm run dev` (or `npm run tauri dev` with the repo-local Rust env).
3. Generate the plan, draw a boundary around the search and compare steps, remove every other
   step (cart, WhatsApp, recipients, send), Approve & Run. Append one line to LIVE_RUNS.log.

Fallback taken: the full flow was verified with the real planner + scorer (claude-sonnet-5-5,
$0.108, 7 steps x 10 dims) and the simulated executor (`--exec simulated`). With the daemon in
live mode and no grants, `/health` reports `cua_driver: false` and `POST /run` returns 503
"live executor unavailable ... Nothing ran" instead of starting a run.
