"""First-run setup and settings. Implemented by track D1; Wave 0 leaves it empty."""

from __future__ import annotations

from fastapi import FastAPI

from .ctx import Ctx


def register(app: FastAPI, ctx: Ctx) -> None:
    """Stub. Track D1 adds: GET /setup/status, PUT /setup/key, POST /setup/driver/install, POST /setup/driver/start, POST /setup/permissions/open, POST /setup/self-test, POST /setup/complete, GET/PUT /settings."""
    return None
