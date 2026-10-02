"""Agent desk frames. Implemented by track D4; Wave 0 leaves it empty."""

from __future__ import annotations

from fastapi import FastAPI

from .ctx import Ctx


def register(app: FastAPI, ctx: Ctx) -> None:
    """Stub. Track D4 adds: GET /task/{id}/frames/{seq}.jpg."""
    return None
