"""Image attachments. Implemented by track D2; Wave 0 leaves it empty."""

from __future__ import annotations

from fastapi import FastAPI

from .ctx import Ctx


def register(app: FastAPI, ctx: Ctx) -> None:
    """Stub. Track D2 adds: POST /attachments, GET /attachments/{id}."""
    return None
