"""First-run setup: model key, cua-driver, macOS permissions, self-test.

Spec: "Daemon API changes §5 Setup" and "Screens §4". The daemon owns all of it;
routes/setup.py exposes it over HTTP. Every OS, keychain, network and screen effect
goes through an injectable SetupEnv, so tests never touch the real machine.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import urllib.parse
from collections.abc import Awaitable, Callable, MutableMapping
from dataclasses import dataclass
from typing import Any

from .llm import CallRecord, price_usd

KEYCHAIN_SERVICE = "sketch-oversight"
KEYCHAIN_WARNING = "System keychain unavailable; the key is kept for this session only."
ENV_VARS: dict[str, str] = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
MODELS: dict[str, list[str]] = {
    "anthropic": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"],
    "openai": ["gpt-5.5"],
}
PANES: dict[str, str] = {
    "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "screen_recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
}
INSTALL_CMD = "curl -fsSL https://cua.ai/driver/install.sh | bash"
SELF_TEST_TEXT = "hello"
SELF_TEST_URL = "data:text/html," + urllib.parse.quote(
    '<title>Oversight self-test</title><textarea aria-label="scratch" autofocus></textarea>')
LOG_TAIL_LINES = 40

Runner = Callable[[list[str], float], Awaitable[tuple[int, str, str]]]
KeyTester = Callable[[str, str, str], Awaitable[tuple[bool, "str | None", "CallRecord | None"]]]


@dataclass
class SetupEnv:
    platform: str  # "macos" | "windows" | "linux"
    run: Runner  # (argv, timeout_s) -> (exit_code, stdout, stderr); never raises
    keyring_get: Callable[[str, str], "str | None"]  # may raise when no backend exists
    keyring_set: Callable[[str, str, str], None]  # may raise when no backend exists
    find_binary: Callable[[], "str | None"]  # path of the cua-driver CLI, or None
    make_driver: Callable[[str], Any]  # binary -> CuaDriver-like (awaitable .ready())
    make_desk: Callable[[Any], Any]  # driver -> BrowserDesk-like (.ensure/.observe/.type)
    test_key: KeyTester  # (provider, key, model) -> (ok, user-facing error, CallRecord)
    environ: MutableMapping[str, str]  # where SDK clients read keys from
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep


def detect_platform(p: str = sys.platform) -> str:
    if p == "darwin":
        return "macos"
    if p.startswith("win"):
        return "windows"
    return "linux"


async def run_subprocess(argv: list[str], timeout: float) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError as e:
        return 127, "", str(e)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", f"timed out after {timeout:.0f}s"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def keyring_get(service: str, name: str) -> str | None:
    import keyring

    return keyring.get_password(service, name)


def keyring_set(service: str, name: str, value: str) -> None:
    import keyring

    keyring.set_password(service, name, value)


def _friendly_key_error(e: Exception) -> str:
    text = str(e)
    if "401" in text or "authentication" in text.lower() or "invalid" in text.lower():
        return "That key was rejected (401). Check that you copied all of it."
    if "404" in text or ("model" in text.lower() and "not" in text.lower()):
        return f"The key works but can't use this model: {text}"
    return f"{type(e).__name__}: {text}"


async def sdk_test_key(provider: str, key: str, model: str
                       ) -> tuple[bool, str | None, CallRecord | None]:
    """Prove the key works before storing it. Anthropic: a 1-token message (spec).
    OpenAI: retrieve the model (free; a 1-token completion is refused by reasoning
    models). Returns a CallRecord so the cost shows up like any other LLM call."""
    rec = CallRecord(scope="setup", provider=provider, model=model)
    t0 = time.perf_counter()
    try:
        if provider == "anthropic":
            import anthropic

            client = anthropic.AsyncAnthropic(api_key=key, max_retries=0, timeout=20.0)
            resp = await client.messages.create(
                model=model, max_tokens=1, messages=[{"role": "user", "content": "ping"}])
            rec.input_tokens = int(resp.usage.input_tokens or 0)
            rec.output_tokens = int(resp.usage.output_tokens or 0)
        else:
            import openai

            client = openai.AsyncOpenAI(api_key=key, max_retries=0, timeout=20.0)
            await client.models.retrieve(model)
    except Exception as e:  # SDK / network: report, never raise into the API
        rec.ok = False
        rec.error = f"{type(e).__name__}: {e}"
        rec.latency_ms = int((time.perf_counter() - t0) * 1000)
        return False, _friendly_key_error(e), rec
    rec.latency_ms = int((time.perf_counter() - t0) * 1000)
    rec.usd = price_usd(model, rec.input_tokens, rec.output_tokens)
    return True, None, rec


def default_env() -> SetupEnv:
    import os

    from .cua import CuaDriver, find_binary

    def make_desk(driver: Any) -> Any:
        from .browser_desk import BrowserDesk

        return BrowserDesk(driver)

    return SetupEnv(platform=detect_platform(), run=run_subprocess, keyring_get=keyring_get,
                    keyring_set=keyring_set, find_binary=find_binary,
                    make_driver=lambda b: CuaDriver(binary=b, timeout_s=20.0),
                    make_desk=make_desk, test_key=sdk_test_key, environ=os.environ)


# ------------------------------------------------------------------ models + keys

def models_for(provider: str, model: str) -> dict[str, list[str]]:
    """The model menu. A configured model that is not in the list (OVERSIGHT_MODEL)
    is shown first rather than silently replaced."""
    out = {k: list(v) for k, v in MODELS.items()}
    if provider in out and model not in out[provider]:
        out[provider].insert(0, model)
    return out


def key_status(env: SetupEnv, store: Any, provider: str) -> dict:
    var = ENV_VARS[provider]
    warning = None
    try:
        in_keychain = bool(env.keyring_get(KEYCHAIN_SERVICE, var))
    except Exception:
        in_keychain, warning = False, KEYCHAIN_WARNING
    in_env = bool(env.environ.get(var))
    source = "keychain" if in_keychain else "env" if in_env else "none"
    tested = bool((store.get_setting("key_tested", {}) or {}).get(provider, False))
    return {"provider": provider, "present": in_keychain or in_env, "source": source,
            "tested": tested, "warning": warning}


def save_key(env: SetupEnv, provider: str, key: str) -> str | None:
    """Store a TESTED key. The environment always gets it (SDK clients read it there);
    the keychain gets it when one exists. Returns a warning when it doesn't."""
    var = ENV_VARS[provider]
    env.environ[var] = key
    try:
        env.keyring_set(KEYCHAIN_SERVICE, var, key)
    except Exception:
        return KEYCHAIN_WARNING
    return None


def apply_keychain(environ: MutableMapping[str, str],
                   get: Callable[[str, str], str | None]) -> str | None:
    """At daemon start: keychain keys win over environment keys (spec). Returns a
    warning when the keychain can't be read; the environment is then left as is."""
    for var in ENV_VARS.values():
        try:
            value = get(KEYCHAIN_SERVICE, var)
        except Exception as e:
            return f"System keychain unavailable ({type(e).__name__}); using environment keys."
        if value:
            environ[var] = value
    return None


# ------------------------------------------------------------------ driver + permissions

_VERSION = re.compile(r"(\d+\.\d+\.\d+)")


async def driver_status(env: SetupEnv) -> dict:
    binary = env.find_binary()
    if not binary:
        return {"installed": False, "version": None, "running": False}
    _, out, err = await env.run([binary, "--version"], 10.0)
    m = _VERSION.search(out or err)
    code, out, _ = await env.run([binary, "status"], 10.0)
    running = code == 0 and "is running" in out and "not running" not in out
    return {"installed": True, "version": m.group(1) if m else None, "running": running}


def _perm(v: Any) -> str:
    return "granted" if v is True else "denied" if v is False else "unknown"


async def permission_status(env: SetupEnv, binary: str | None) -> dict[str, str]:
    if env.platform != "macos":
        return {"accessibility": "n/a", "screen_recording": "n/a"}
    if not binary:
        return {"accessibility": "unknown", "screen_recording": "unknown"}
    _, out, _ = await env.run([binary, "permissions", "status", "--json"], 10.0)
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {"accessibility": _perm(data.get("accessibility")),
            "screen_recording": _perm(data.get("screen_recording"))}


async def open_permission(env: SetupEnv, which: str) -> bool:
    if which not in PANES:
        raise ValueError(f"which must be one of {sorted(PANES)}")
    if env.platform != "macos":
        return False
    code, _, _ = await env.run(["open", PANES[which]], 10.0)
    return code == 0


def _tail(out: str, err: str) -> str:
    return "\n".join((out + "\n" + err).strip().splitlines()[-LOG_TAIL_LINES:])


async def install_driver(env: SetupEnv) -> dict:
    if env.platform == "windows":
        return {"ok": False, "version": None,
                "log_tail": "Automatic install isn't available on Windows yet. Install "
                            "cua-driver from https://cua.ai, then check again."}
    code, out, err = await env.run(["/bin/bash", "-c", INSTALL_CMD], 300.0)
    st = await driver_status(env)
    return {"ok": code == 0 and st["installed"], "version": st["version"],
            "log_tail": _tail(out, err)}


async def start_driver(env: SetupEnv) -> dict:
    if env.platform != "macos":
        return {"ok": False, "error": "Start cua-driver with `cua-driver serve` in a terminal."}
    code, _, err = await env.run(["open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"], 15.0)
    if code != 0:
        return {"ok": False, "error": err.strip() or f"open exited with {code}"}
    for _ in range(20):
        if (await driver_status(env))["running"]:
            return {"ok": True, "error": None}
        await env.sleep(0.5)
    return {"ok": False, "error": "CuaDriver opened but its daemon did not report running within 10 s."}


# ------------------------------------------------------------------ composite status

async def status(env: SetupEnv, store: Any, settings: Any) -> dict:
    """The C1 SetupStatus. `complete` = key present AND (plan-only OR the agent can run:
    driver installed + running, both permissions granted (or n/a), self-test passed)."""
    provider = settings.provider if settings.provider in ENV_VARS else "anthropic"
    key = key_status(env, store, provider)
    driver = await driver_status(env)
    perms = await permission_status(env, env.find_binary() if driver["installed"] else None)
    passed = store.get_setting("self_test_passed_at", None)
    plan_only = bool(store.get_setting("plan_only", False))
    perms_ok = all(v in ("granted", "n/a") for v in perms.values())
    agent_ok = driver["installed"] and driver["running"] and perms_ok and passed is not None
    return {"platform": env.platform, "key": key, "driver": driver, "permissions": perms,
            "self_test": {"passed_at": passed}, "plan_only": plan_only,
            "complete": bool(key["present"] and (plan_only or agent_ok))}
