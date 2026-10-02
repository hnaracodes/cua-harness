# Agent Oversight app (Tauri 2 + React)

The UI renders and captures gestures. All logic lives in the daemon
(`docs/01-architecture.md`, "Sprint contract addendum").

## Run

```sh
npm install
npm run dev            # browser at http://localhost:1420 (real daemon if up, else mock)
npm run dev:mock       # force the in-browser mock daemon
npm run tauri dev      # native window "Agent Oversight" (needs the repo-local Rust toolchain)
npm run typecheck
```

Repo-local Rust toolchain:

```sh
export CARGO_HOME="$PWD/../.toolchain/cargo" RUSTUP_HOME="$PWD/../.toolchain/rustup" PATH="$PWD/../.toolchain/cargo/bin:$PATH"
```

Daemon URL: `VITE_DAEMON_URL` (default `http://127.0.0.1:8765`). The app probes
`/health` once at startup. If that fails, or `VITE_MOCK=1`, or the URL has
`?mock`, it uses `src/api/mock.ts`, which implements the same contract shapes
(docs/00 plan, docs/03 dimensions, every SSE kind, its own 409 check).

## Layout

- `src/components/BoundaryCanvas.tsx`: the polygon. Freehand draw, RDP to 6 to 10
  handles, handle drag, drag inside to move, double-click edge to add a handle,
  double-click a handle to delete it, Escape cancels a gesture. Every pointermove
  commits through `flushSync`, so badge colours and header counts update in the
  same frame.
- `src/lib/geometry.ts`, `src/lib/approval.ts`: the even-odd ray cast and the
  approval rule, written exactly as the contract states (RAW positions, union over
  all axis-pair polygons, plus checked, minus removed).
- `src/api/client.ts`: HTTP + SSE client (dedupes by `seq`, reconnects from the last
  seen seq). `src/api/mock.ts`: in-browser daemon.
- Test hooks: `data-testid` on counts, badges (`badge-<index>`, `data-status`),
  handles, cards, checkboxes, remove/undo, approve-run, execution blocks.
