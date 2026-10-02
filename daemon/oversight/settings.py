"""Daemon settings. Keys load from the first .env found walking up from daemon/,
also checking testing/.env at each level."""

from __future__ import annotations

import os
import shutil
import subprocess
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


def cua_driver_status() -> tuple[bool, str]:
    """(available, word for the status line)."""
    path = shutil.which("cua-driver")
    if path is None:
        for p in ("/usr/local/bin/cua-driver", str(Path.home() / ".local/bin/cua-driver"),
                  "/opt/homebrew/bin/cua-driver"):
            if Path(p).exists():
                path = p
                break
    if path is None:
        return False, "not found"
    try:
        r = subprocess.run(["pgrep", "-f", "cua-driver"], capture_output=True, timeout=2)
        if r.returncode == 0:
            return True, "running"
    except Exception:
        pass
    return True, "installed"


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
        data_dir=data_dir,
    )
    return s
