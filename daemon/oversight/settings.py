"""Daemon settings. Keys load from the first .env found walking up from daemon/,
also checking testing/.env at each level."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

DAEMON_DIR = Path(__file__).resolve().parent.parent
APPDEV_DIR = DAEMON_DIR.parent

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"
DEFAULT_OPENAI_MODEL = "gpt-5.5"


def find_env_file(start: Path = DAEMON_DIR) -> Path | None:
    for d in [start, *start.parents]:
        for candidate in (d / ".env", d / "testing" / ".env"):
            if candidate.is_file():
                return candidate
    return None


_CUA_CACHE: dict[str, object] = {"at": 0.0, "value": None}
_CUA_TTL_S = 8.0


def reset_cua_cache() -> None:
    """Forget the cached cua-driver probe (after start / install / permissions / self-test)."""
    _CUA_CACHE["at"] = 0.0
    _CUA_CACHE["value"] = None


async def cua_driver_status(force: bool = False) -> tuple[bool, str, str]:
    """(usable, word for the status line, detail).

    Truthful: usable only when the cua-driver binary exists, its daemon is
    running, AND a harmless call (get_cursor_position) succeeds, which needs the
    macOS Accessibility and Screen Recording grants. Cached for a few seconds
    because the UI polls /health."""
    import time

    from .cua import CuaDriver, find_binary

    now = time.monotonic()
    cached = _CUA_CACHE["value"]
    if not force and cached is not None and now - float(_CUA_CACHE["at"]) < _CUA_TTL_S:
        return cached  # type: ignore[return-value]
    binary = find_binary()
    if binary is None:
        value = (False, "not found", "cua-driver is not installed")
    else:
        drv = CuaDriver(binary=binary, timeout_s=5.0)
        try:
            if not await drv.daemon_running():
                value = (False, "not running",
                         "cua-driver daemon not running (start: open -n -g -a CuaDriver --args serve)")
            else:
                ok, detail = await drv.ready()
                if ok:
                    value = (True, "running", "ok")
                elif "permission" in detail.lower():
                    value = (False, "permissions pending", detail)
                else:
                    value = (False, "not ready", detail)
        except Exception as e:  # never let a probe break /health
            value = (False, "error", f"{type(e).__name__}: {e}")
    _CUA_CACHE["at"] = now
    _CUA_CACHE["value"] = value
    return value


@dataclass
class Settings:
    fixtures: bool = False
    exec_mode: str = "live"  # live | simulated
    port: int = 8765
    host: str = "127.0.0.1"
    provider: str = "anthropic"  # anthropic | openai | fixtures
    model: str = DEFAULT_ANTHROPIC_MODEL
    api_key_present: bool = False
    env_file: str | None = None
    keychain_warning: str | None = None
    data_dir: Path = field(default_factory=lambda: DAEMON_DIR / ".data")

    @property
    def display_provider(self) -> str:
        """What /health reports. In fixture mode no planner/scorer call is made,
        but `provider`/`model` still name the real LLM for a live executor."""
        return "fixtures" if self.fixtures else self.provider

    @property
    def display_model(self) -> str:
        return "fixtures" if self.fixtures else self.model

    @property
    def db_path(self) -> Path:
        return self.data_dir / "oversight.db"


def load_settings(fixtures: bool = False, exec_mode: str | None = None,
                  port: int = 8765) -> Settings:
    env_file = find_env_file()
    if env_file is not None:
        load_dotenv(env_file, override=False)

    # Keys saved by the setup wizard live in the OS keychain and win over env/.env.
    keychain_warning = None
    if os.environ.get("OVERSIGHT_NO_KEYCHAIN") != "1":
        from . import setup as setup_mod

        keychain_warning = setup_mod.apply_keychain(os.environ, setup_mod.keyring_get)

    anthropic_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    openai_key = bool(os.environ.get("OPENAI_API_KEY"))

    provider = os.environ.get("OVERSIGHT_PROVIDER") or ("anthropic" if anthropic_key else "openai")
    provider = provider.lower()
    if provider not in ("anthropic", "openai"):
        raise SystemExit(f"OVERSIGHT_PROVIDER must be anthropic or openai, got {provider!r}")
    model = os.environ.get("OVERSIGHT_MODEL") or (
        DEFAULT_ANTHROPIC_MODEL if provider == "anthropic" else DEFAULT_OPENAI_MODEL
    )
    key_present = anthropic_key if provider == "anthropic" else openai_key

    data_dir = Path(os.environ.get("OVERSIGHT_DATA_DIR") or (DAEMON_DIR / ".data"))
    data_dir.mkdir(parents=True, exist_ok=True)

    if exec_mode is None:
        exec_mode = "simulated" if fixtures else "live"

    s = Settings(
        fixtures=fixtures,
        exec_mode=exec_mode,
        port=port,
        provider=provider,
        model=model,
        api_key_present=key_present,
        env_file=str(env_file) if env_file else None,
        keychain_warning=keychain_warning,
        data_dir=data_dir,
    )
    return s
