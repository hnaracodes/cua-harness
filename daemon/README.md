# oversight daemon

FastAPI + SSE + SQLite. Implements the sprint contract addendum at the end of
`docs/01-architecture.md`.

```
uv sync
uv run oversight-daemon --fixtures          # docs/00 plan, fixed scores, simulated executor
uv run oversight-daemon                     # real planner + scorer, live executor
uv run oversight-daemon --exec simulated    # real planner + scorer, simulated executor
uv run pytest -q
```

- Keys: first `.env` walking up from `daemon/` (also `testing/.env` at each level).
  Provider is Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI.
  Overrides: `OVERSIGHT_PROVIDER`, `OVERSIGHT_MODEL` (default `claude-sonnet-5-5`),
  `OVERSIGHT_EXEC_MODEL` (executor model, default `claude-opus-5-5`), `OVERSIGHT_DATA_DIR`
  (default `daemon/.data`), `OVERSIGHT_NO_FALLBACKS=1` (skip the server-side refusal fallback beta).
- `oversight/dimensions.yaml` is the single source of truth for the ten dimensions.
  `GET /dimensions` serves it and the scorer prompt is built from it.
- Positions are derived from the label band, never scored independently.
- Scores are cached by sha256(task, title, description) plus model and scorer version.
- `oversight/executor.py` is the real executor (cua-driver, agent-profile Chrome,
  approved-only `run_steps`); `oversight/cua.py` wraps the `cua-driver` CLI and
  `oversight/host_desk.py` owns the agent desk and `HostDeskEnvironment`.
- `/health` `cua_driver` is true only when the binary exists, its daemon is
  running and a harmless call succeeds (macOS Accessibility and Screen Recording
  granted). `cua_driver_detail` says why not. In live exec mode `POST /run`
  re-probes and returns 503 (nothing recorded, nothing run) when cua-driver is
  not usable; use `--exec simulated` to demo without the grants.

Additive extras beyond the addendum (all backward compatible):
`POST /task/{id}/plan?force=true` regenerates (default replays a stored plan);
`PUT /task/{id}/boundary` with fewer than 3 points clears that axis pair;
`GET /task/{id}` also returns `decisions`, `llm_calls`, `cost_usd`;
`GET /dimensions` items also carry `label_descriptions`;
`/health` also has `cost_usd_all_time` (`cost_usd_total` is since daemon start);
`POST /stop` returns `{"stopped": false}` when no run is active;
`/health` also has `cua_driver_detail`.
