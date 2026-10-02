# 05. Portable harness: one install, any OS

Research notes for Kyzyl's week-2 ask: turn the `appdev` scaffold into a CUA
harness a user can install on their own machine (macOS, Windows, Linux) with
little or no setup, keeping the Sketch Oversight boundary UI as the front end.
Researched 2026-09-30. Sources at the bottom.

## TL;DR

1. **The hard part is already solved upstream.** trycua's `cua-driver` is now a
   Rust driver that runs on macOS (Sequoia, Tahoe), Windows (11, Server 2025)
   and Linux (X11, XWayland), exposes the same tools on all three, has official
   one-line installers per OS, and does *background* input (no cursor theft, no
   focus stealing). Do not write an input/screenshot layer.
2. **SwiftUI has to go.** Cross-platform kills the current stack choice in
   `CLAUDE.md`. Recommended shell: **Tauri 2** (native webview, ~10 to 20 MB
   installers, built-in sidecar support, one CI job builds .dmg/.msi/.AppImage).
   The canvas becomes SVG or Canvas2D. The "not a webview" rule was about native
   mac feel, and a well-built SVG polygon editor can hit the same bar.
3. **Keep the daemon split, change how it ships.** Python daemon frozen with
   PyInstaller and bundled as a Tauri sidecar, so the user never installs
   Python. The "app is replaceable by curl" principle survives unchanged.
4. **Setup = download, first-run wizard, done.** Wizard does three things: API
   key (stored in the OS keychain), permissions (macOS only, deep-linked), and a
   10-second self-test. Target: under 2 minutes from download to first plan.
5. **The real blockers are signing, not code.** Unsigned macOS builds hit
   Gatekeeper and, worse, lose TCC grants on every rebuild. Ask Kyzyl whether
   SPUD/CMU has an Apple Developer ID. Windows unsigned only costs a SmartScreen
   click, acceptable for a research release.

## What changes versus the current scaffold

| Concern | Current (`01-architecture.md`) | Portable version |
|---|---|---|
| App shell | SwiftUI, macOS 14+ | Tauri 2 + React (or Svelte) + TypeScript |
| Boundary canvas | `Canvas` / `CAShapeLayer` | SVG with pointer events (Canvas2D if >200 badges) |
| Daemon | Python 3.12, FastAPI, SSE, run by hand | Same code, frozen to one binary, spawned by the app as a sidecar |
| Agent substrate | `cua-driver`, macOS | `cua-driver`, macOS + Windows + Linux, installed by the wizard |
| Models | gpt-5.5, hardcoded | Provider adapter: Anthropic, OpenAI, local (Ollama) |
| Secrets | env var | OS keychain (macOS Keychain, Windows Credential Manager, libsecret) |
| Distribution | `swift build` | GitHub Releases, `tauri-action` CI matrix, Tauri auto-updater |

Everything in `03-scoring-model.md` and the data model in `01-architecture.md`
carries over untouched. That is the point of the daemon-owns-logic rule.

## Architecture

```
+-- Oversight app (Tauri 2) --------------------------------------+
|  WebView: React UI                                               |
|    BoundaryCanvas (SVG), PlanPanel, ExecutionView, SetupWizard   |
|  Rust core (thin):                                               |
|    spawn/supervise sidecars, keychain, global kill hotkey,       |
|    always-on-top window, tray icon, updater                      |
+----------|---------------------------------|---------------------+
           | HTTP + SSE on 127.0.0.1:<rand>  | spawns
           v                                  v
+-- oversight-daemon (frozen Python) --+   +-- cua-driver ---------------+
| planner, scorer, approval, executor, |-->| `cua-driver serve` / MCP    |
| inducer, SQLite store                |   | macOS: AX + ScreenCaptureKit|
| model adapters (Anthropic/OpenAI/    |   | Windows: UIA + Win32        |
|  Ollama)                             |   | Linux: AT-SPI + X11         |
+--------------------------------------+   +-----------------------------+
```

### Why Tauri over the alternatives

| Option | Verdict |
|---|---|
| **Tauri 2** | Recommended. Small binary, native webview on all three OSes, `externalBin` sidecars with per-target-triple naming, first-party updater and `tauri-action` CI. Rust core is thin glue, you barely write Rust. |
| Electron | Fine fallback. ByteDance's UI-TARS Desktop (closest prior art: local CUA app, mac + Windows) ships this way. ~150 MB installers, but if you'd rather drop Python entirely and run everything in Node using `@trycua/cua-driver` plus the Anthropic/OpenAI TS SDKs, Electron is the cleanest single-language path. Cost: you lose shared Python code with `testing/`. |
| SwiftUI + WinUI + GTK | No. Three UIs in one week. |
| Pure web app on localhost | Tempting, but no always-on-top window, no global kill hotkey, no tray, and the user has to start a server. Fails the "no overhead" bar. |
| Flutter / Qt | Viable, no advantage over Tauri here, worse web-canvas ecosystem. |

### Why keep Python for the daemon

`testing/` (Peripheral) is Python and the README already says the scoring
layer, trace schema, and cua-driver substrate are meant to be shared. Keeping
the daemon in Python keeps that bridge, and is what makes "run the app as
condition C3 in Peripheral" possible later. PyInstaller one-file sidecar is
the standard trick (40 to 80 MB). Known costs: occasional Windows Defender
false positives on PyInstaller binaries (signing helps), and a cold start of
1 to 2 s, hidden behind the splash.

If freezing turns into a time sink, the fallback is: app ships `uv` (single
static binary) as the sidecar and runs `uv run oversight-daemon` on first
launch, which fetches a managed Python once. Still zero user-visible installs.

## The substrate: cua-driver

What it gives you, per the trycua docs:

- Same tool surface on macOS, Windows, Linux: `screenshot`, `click`,
  `type_text`, `get_window_state` (accessibility tree), `list_apps`,
  `list_windows`, and more (DeepWiki counts ~58 MCP tools).
- **Background input**: clicks and keys are delivered to a target window
  without moving the user's cursor or raising the window. When an app only
  accepts foreground input, the driver reports that instead of silently
  failing ("no-foreground contract"). This matters for us specifically: the
  user keeps using the oversight window while the agent works underneath,
  which is exactly the video's demo setup.
- Three run modes: `cua-driver mcp` (stdio MCP server), `cua-driver serve`
  (daemon), `cua-driver call` (one shot CLI). Python and TypeScript SDKs
  (UniFFI bindings over the Rust core).
- Official installers:
  - macOS / Linux: `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`
  - Windows: `irm https://cua.ai/driver/install.ps1 | iex` (no admin needed;
    detects x64 vs ARM64; optional Scheduled Task autostart)
- macOS permissions attach to a signed `CuaDriver.app` (bundle id
  `com.trycua.driver`), not to our app. Good: our app never needs Screen
  Recording or Accessibility itself, and the grants survive our rebuilds.
- Windows: no permission prompts for UIA. Driving elevated (admin) windows
  needs its UIAccess worker. Must run in the interactive user session.
- Linux: X11 is solid; Wayland is partial (portal / libei, experimental
  Hyprland). Treat Linux as "X11 supported, Wayland best effort".

**Day-1 verification item:** decide between (a) the wizard running the
official install script, or (b) bundling the signed `CuaDriver.app` / Windows
binary inside our installer. (b) is smoother but must keep trycua's signature
intact on macOS or the TCC identity breaks. MIT license allows either.

## Driving it: pixels vs accessibility tree

Two ways the executor can act, and the portable harness should use both:

1. **Semantic first.** Give the model cua-driver's `get_window_state` (AX / UIA
   tree) and element-targeted clicks as plain function tools. Works with any
   model that does tool calling, is resolution independent, and sidesteps the
   Retina / Windows DPI coordinate-drift problem that `testing/plans/T2` flags.
2. **Pixel fallback.** For canvases, games, remote desktops, anything with a
   bad accessibility tree, use the provider's native computer-use tool and map
   its actions onto cua-driver:
   - Anthropic: `computer_toolset_20260801` (no beta header; required for
     Claude 5.5+). Actions: screenshot, zoom, clicks, drag, scroll, type, key,
     hold_key, wait. Docs recommend ~1280x800, max 1568 px long edge, and
     scaling coordinates back up yourself.
   - OpenAI: `computer` tool in the Responses API returns batched
     `computer_call` actions; OpenAI now also recommends a code-execution style
     (`exec_py` in a persistent session) for its newest models. The
     `gpt-5.5` string in the source video is now two generations old; make the
     model a setting, not a constant.
   - Local: Ollama with a vision model through the same adapter (the
     `testing/peripheral/backends/` layout already has this shape: reuse it).

Normalize both into one internal `Action` type (Peripheral already defines a
normalized action space in `peripheral/actions.py`; import it rather than
redefine it).

## First-run wizard (the "no overhead" part)

```
1. Welcome          what this does, what it can touch, how to stop it
2. Model            [Anthropic | OpenAI | Local (Ollama)]  paste key -> keychain
                    "Test key" button hits a 1-token call
3. Driver           installs/verifies cua-driver, shows version
4. Permissions      macOS only:
                      Accessibility  [Open Settings]  ● granted
                      Screen Recording [Open Settings] ● granted
                    deep links: x-apple.systempreferences:com.apple.preference.
                      security?Privacy_Accessibility / ?Privacy_ScreenCapture
                    poll `cua-driver permissions status` every 1 s, go green live
                    Windows/Linux: skipped or a single "all good" row
5. Self-test        open a scratch text window, type "hello", screenshot,
                    read it back. Green = done.
```

The status row from the source video ("● Daemon ● API key model") becomes the
post-wizard health bar, driven by the same checks.

## The agent's own desk

Goal: the agent works on its own desktop on the same machine, the user keeps
theirs, and nobody fights over the cursor. This is also the single biggest
fix for what Peripheral measured (see `06-peripheral-integration.md`): in
100% of trials the first screenshot already carried notifications, open
tabs, and other windows the task never needed. A separate desk removes
that whole class of exposure.

Three layers, cheapest first. Ship layer 1 everywhere, layer 2 where the OS
allows it, layer 3 as an opt-in.

### Layer 1: background mode + window-scoped capture (all OSes)

- cua-driver already acts on windows without focus or cursor movement, and
  per its macOS internals write-up the AX tree stays live when the target is
  hidden, behind another app, or on another Space.
- Screenshots are of **the target window only**, never the full screen. The
  driver's window snapshot already returns just that window.
- The agent gets its **own browser instance** (separate Chrome profile via
  `--user-data-dir`), so it never sees the user's tabs, and the user's
  logged-in sessions stay out unless the user explicitly hands one over.
- Limitation: single-instance apps (Mail, Notes, Messages on macOS) are
  shared. The agent's Mail window still shows the real inbox. The desk hides
  *other* windows, it does not hide in-app periphery.

### Layer 2: a real separate desk

| OS | Mechanism | Notes |
|---|---|---|
| **macOS** | Virtual display via `CGVirtualDisplay` (the private CoreGraphics class DeskPad, BetterDisplay, and Chromium's multi-screen tests use). Agent windows are moved onto it with the public AX API (`AXPosition`). The oversight app mirrors that display into an **"Agent desk" live-preview pane**. | Private API: can break on OS updates, and rules out the Mac App Store (irrelevant here). Needs a logged-in GUI session. Leaves a ColorSync profile behind. Fallback is layer 1 on the main display. |
| **Windows** | Near term: a dedicated Windows virtual desktop for agent windows, driven in background mode. Longer term: Windows 11 **Agent Workspace**, which runs agents under their own account in a separate Windows session in parallel with the user's, with per-agent folder permissions and MCP "agent connectors". | Agent Workspace is experimental, needs an admin toggle (Settings > System > AI Components), and third-party agent support looks gated. Worth a day-1 check; if it opens up it's the cleanest "own desk" of any OS. |
| **Linux** | A separate X display (Xvfb or Xephyr) per agent. Trivial and robust. | Wayland: best effort only. |

### Layer 3: full isolation (opt-in)

Lume VM on Apple Silicon, or Windows Sandbox on Windows Pro. A true second
computer, but it's a 30+ GB image and slow first boot, so it fails the "no
overhead" bar as a default. Keep it as a "sandbox mode" toggle for demos
with sensitive data, and as the environment Peripheral already targets.

## Guardrails (lightweight)

No VM by default, and the boundary is the main control, as intended. Keep
the cheap things anyway:

- **Global kill hotkey** registered by the Tauri core (works when the app is
  not focused).
- **"Agent acting" indicator**: tray icon state plus a border on the agent
  desk preview.
- **Executor assertion** from `CLAUDE.md`: nothing outside the approved set
  runs. Plus per-run caps on steps, wall time, and dollars.
- **Daemon on 127.0.0.1**, random port, per-launch token, so other local
  processes can't drive it.

One caveat, and it's the research point: the boundary decides *which steps*
run. It does not decide what the screenshots contain or what text a send
step writes. Peripheral's findings are almost entirely in those two gaps,
which is why the agent desk and outbound-content review
(`06-peripheral-integration.md`) matter more than the kill switch.

## Distribution

- GitHub Releases + `tauri-apps/tauri-action` matrix: macOS (arm64 + x64
  universal), Windows x64/ARM64, Ubuntu. One push to a tag = all installers.
- macOS: needs Developer ID signing + notarization for a clean install. Without
  it: right-click > Open dance, and ad-hoc signatures change per build so TCC
  resets. (Mitigated if TCC lives on the trycua-signed CuaDriver.app.)
- Windows: unsigned MSI works with a SmartScreen "Run anyway". Fine for a
  research beta.
- Tauri updater with a signed update manifest so study participants get fixes
  without reinstalling.

## Revised build order (fits a week)

| Day | Work | Gate |
|---|---|---|
| 1 | Verify cua-driver on your Mac + a Windows box (Parallels/UTM or a lab PC): install, `permissions status`, `call screenshot`, `call click`. Decide bundle-vs-script. | screenshot + click round trip on both OSes |
| 2 | Tauri shell + daemon as sidecar (fixtures, M0 from `04-build-plan.md`). Health bar live. | `.dmg` and `.msi` launch and show green Daemon dot on a clean machine |
| 3 | Boundary canvas in SVG (M1). Freehand, simplify, handles, double-click insert, live point-in-polygon. | Same M1 gate: counts update during drag, feels physical |
| 4 | Real planner/scorer + provider adapter (M2), wizard steps 1 to 3 | tennis-racket plan from the video reproduces |
| 5 | Executor over cua-driver as a Peripheral `Environment`, semantic-first with pixel fallback, agent desk layer 1 (window-scoped capture, own browser profile), kill hotkey (M5) | end-to-end run on macOS **and** Windows |
| 6 | Wizard permissions + self-test, CI release matrix | a friend installs from a release link with no help |
| 7 | Plan panel polish, reflexive layer (M3/M4/M6 as time allows), write-up | parity checklist as far as it goes |

The day-6 gate is the one Kyzyl's ask is actually about. Test it on someone
who is not you.

## Questions to take to Kyzyl

1. Is there a lab Apple Developer ID for signing/notarizing? (Biggest single
   factor in "easy to set up" on macOS.)
2. Is dropping SwiftUI for a cross-platform webview UI acceptable, given the
   original is a native mac app? Parity of *behavior* vs parity of *stack*.
3. Which OSes must work for the study: macOS + Windows, or Linux too?
4. BYO API key per user, or a lab key behind a proxy? (Changes the wizard and
   the cost story.)
5. OK to put the agent on its own desk (virtual display on macOS) rather than the user's screen? And should the "full extent" goal include elevated/admin apps on Windows
   (needs the UIAccess worker) and system dialogs on macOS?
6. Still open from `00-source-analysis.md`: the Impact tab, the seven draft
   dimension definitions.

## Sources

- trycua/cua repo: https://github.com/trycua/cua
- cua-driver README: https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
- Cua Driver product page: https://cua.ai/cua-driver
- DeepWiki, cua-driver architecture: https://deepwiki.com/trycua/cua/6-cua-driver:-background-computer-use
- DeepWiki, cua-driver install and setup: https://deepwiki.com/trycua/cua/6.2-cua-driver-installation-and-setup
- trycua blog, macOS window internals: https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md
- Anthropic computer use tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic reference implementation: https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo
- OpenAI computer use guide: https://developers.openai.com/api/docs/guides/tools-computer-use
- OpenAI latest model guide: https://developers.openai.com/api/docs/guides/latest-model
- Tauri 2 sidecars: https://v2.tauri.app/develop/sidecar/
- UI-TARS Desktop (prior art): https://github.com/bytedance/UI-TARS-desktop
- Windows Agent Workspace (experimental agentic features): https://support.microsoft.com/en-us/windows/experimental-agentic-features-a25ede8a-e4c2-4841-85a8-44839191dfb3
- go-macos/virtualdisplay (CGVirtualDisplay notes): https://pkg.go.dev/github.com/go-macos/virtualdisplay
- DeskPad (virtual display reference): https://github.com/Stengo/DeskPad
