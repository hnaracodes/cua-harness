"""Per-task event fan-out. Every event is persisted first (seq per task), then
pushed to live subscribers. SSE handlers replay from the store and then stream."""

from __future__ import annotations

import asyncio
from collections import defaultdict

from .store import Store


class EventBus:
    def __init__(self, store: Store):
        self.store = store
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, task_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[task_id].add(q)
        return q

    def unsubscribe(self, task_id: str, q: asyncio.Queue) -> None:
        self._subs[task_id].discard(q)
        if not self._subs[task_id]:
            self._subs.pop(task_id, None)

    async def emit(self, task_id: str, run_id: str | None, kind: str, payload: dict) -> dict:
        # No await between persist and fan-out, so seq order == delivery order.
        ev = self.store.append_event(task_id, run_id, kind, payload)
        for q in list(self._subs.get(task_id, ())):
            q.put_nowait(ev)
        return ev
