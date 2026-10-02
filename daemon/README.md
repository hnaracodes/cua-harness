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
  `OVERSIGHT_EXEC_MODEL` (model handed to the executor), `OVERSIGHT_DATA_DIR`
  (default `daemon/.data`), `OVERSIGHT_NO_FALLBACKS=1` (skip the server-side refusal fallback beta).
- `oversight/dimensions.yaml` is the single source of truth for the ten dimensions.
  `GET /dimensions` serves it and the scorer prompt is built from it.
- Positions are derived from the label band, never scored independently.
- Scores are cached by sha256(task, title, description) plus model and scorer version.
- `oversight/executor.py` here is a stub; the executor branch owns the real one.

Additive extras beyond the addendum (all backward compatible):
`POST /task/{id}/plan?force=true` regenerates (default replays a stored plan);
`PUT /task/{id}/boundary` with fewer than 3 points clears that axis pair;
`GET /task/{id}` also returns `decisions`, `llm_calls`, `cost_usd`;
`GET /dimensions` items also carry `label_descriptions`;
`/health` also has `cost_usd_all_time` (`cost_usd_total` is since daemon start);
`POST /stop` returns `{"stopped": false}` when no run is active.
