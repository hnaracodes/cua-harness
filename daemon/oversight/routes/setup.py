"""First-run setup and settings (track D1). Logic lives in oversight/setup.py; this
module is HTTP only. The live SetupEnv sits on app.state.setup_env and is read per
request, so tests swap it for fakes after create_app."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import setup
from ..llm import StructuredLLM
from ..settings import reset_cua_cache
from ..store import now_iso
from .ctx import Ctx


class KeyBody(BaseModel):
    provider: str
    key: str


class WhichBody(BaseModel):
    which: str


class SettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    plan_only: bool | None = None


def _err(status: int, message: str, **extra) -> JSONResponse:
    # Local helper: importing api.err here would be a circular import (api imports us).
    return JSONResponse({"error": message, **extra}, status_code=status)


def _rebuild_llm(ctx: Ctx) -> None:
    """New provider, model or key: rebuild the client so the next call picks it up."""
    s = ctx.st.settings
    if not s.fixtures:
        ctx.st.llm = StructuredLLM(s.provider, s.model)


def _apply_persisted(ctx: Ctx, env: setup.SetupEnv) -> None:
    """Provider/model chosen in the app survive a daemon restart. Fixture mode keeps
    its fixed configuration (tests and rehearsals stay deterministic)."""
    s, store = ctx.st.settings, ctx.st.store
    provider, model = store.get_setting("provider"), store.get_setting("model")
    if s.fixtures or provider not in setup.MODELS:
        return
    s.provider = provider
    if isinstance(model, str) and model:
        s.model = model
    s.api_key_present = bool(env.environ.get(setup.ENV_VARS[provider]))
    _rebuild_llm(ctx)


def register(app: FastAPI, ctx: Ctx) -> None:
    st = ctx.st
    app.state.setup_env = setup.default_env()
    _apply_persisted(ctx, app.state.setup_env)

    def env() -> setup.SetupEnv:
        return app.state.setup_env

    def settings_payload() -> dict:
        s = st.settings
        return {"provider": s.provider, "model": s.model,
                "plan_only": bool(st.store.get_setting("plan_only", False)),
                "models": setup.models_for(s.provider, s.model)}

    @app.get("/setup/status")
    async def setup_status():
        return await setup.status(env(), st.store, st.settings)

    @app.put("/setup/key")
    async def put_key(body: KeyBody):
        if body.provider not in setup.ENV_VARS:
            return _err(400, f"provider must be one of {sorted(setup.ENV_VARS)}")
        key = body.key.strip()
        if not key:
            return {"ok": False, "error": "The key is empty."}
        s = st.settings
        model = s.model if body.provider == s.provider else setup.MODELS[body.provider][0]
        ok, error, rec = await env().test_key(body.provider, key, model)
        if rec is not None:
            await ctx.record_call(None, None, rec)
        if not ok:
            return {"ok": False, "error": error}
        setup.save_key(env(), body.provider, key)  # a keychain warning surfaces in /setup/status
        tested = dict(st.store.get_setting("key_tested", {}) or {})
        tested[body.provider] = True
        st.store.set_setting("key_tested", tested)
        if body.provider == s.provider:
            s.api_key_present = True
            _rebuild_llm(ctx)
        return {"ok": True, "error": None}

    @app.post("/setup/driver/install")
    async def driver_install():
        r = await setup.install_driver(env())
        reset_cua_cache()
        return r

    @app.post("/setup/driver/start")
    async def driver_start():
        r = await setup.start_driver(env())
        reset_cua_cache()
        return r

    @app.post("/setup/permissions/open")
    async def permissions_open(body: WhichBody):
        if body.which not in setup.PANES:
            return _err(400, f"which must be one of {sorted(setup.PANES)}")
        return {"ok": await setup.open_permission(env(), body.which)}

    @app.post("/setup/self-test")
    async def self_test():
        ok, detail = await setup.self_test(env())
        if ok:
            st.store.set_setting("self_test_passed_at", now_iso())
        reset_cua_cache()
        return {"ok": ok, "detail": detail}

    @app.post("/setup/complete")
    async def complete():
        st.store.set_setting("setup_complete", True)
        return {"ok": True}

    @app.get("/settings")
    async def get_settings():
        return settings_payload()

    @app.put("/settings")
    async def put_settings(body: SettingsBody):
        s = st.settings
        provider = body.provider or s.provider
        if provider not in setup.MODELS:
            return _err(400, f"provider must be one of {sorted(setup.MODELS)}")
        allowed = setup.models_for(s.provider, s.model)[provider]
        model = body.model or (s.model if provider == s.provider else allowed[0])
        if model not in allowed:
            return _err(400, f"unknown model {model!r} for {provider}", allowed=allowed)
        if (provider, model) != (s.provider, s.model):
            s.provider, s.model = provider, model
            s.api_key_present = bool(env().environ.get(setup.ENV_VARS[provider]))
            st.store.set_setting("provider", provider)
            st.store.set_setting("model", model)
            _rebuild_llm(ctx)
        if body.plan_only is not None:
            st.store.set_setting("plan_only", body.plan_only)
        return settings_payload()
