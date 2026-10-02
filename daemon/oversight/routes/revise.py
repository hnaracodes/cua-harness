"""Re-propose and step edit. Implemented by track D3; Wave 0 leaves it empty."""

from __future__ import annotations

from fastapi import FastAPI

from .ctx import Ctx


def register(app: FastAPI, ctx: Ctx) -> None:
    """Stub. Track D3 adds: POST /task/{id}/repropose, PATCH /task/{id}/step/{step_id}."""
    return None
