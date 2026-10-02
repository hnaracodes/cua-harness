# Track D1: Daemon setup (first-run wizard backend + settings)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1, C3, C4), and Ownership matrix first. Spec sections: "Daemon API changes §5 Setup" and "Screens §4 First-run setup". Wave 1, Batch A. Worktree: `.worktrees/rd-D1`, branch `rd/D1`.

**Owns:** `daemon/oversight/setup.py` (new), `daemon/oversight/routes/setup.py` (replaces the Wave 0 stub), `daemon/oversight/settings.py`, `daemon/tests/test_setup.py` (new).

**Must not touch:** `api.py`, `store.py`, `llm.py`, `cua.py`, `browser_desk.py`, `host_desk.py`, or any other route module. Everything this track needs from them is already in C4 (`Ctx`, the `store.get_setting`/`set_setting` keys, `CallRecord`, `price_usd`) or is imported read-only (`CuaDriver`, `find_binary`, `BrowserDesk`).

**Design in one paragraph.** `oversight/setup.py` is pure logic over an injectable `SetupEnv`, a bundle of callables: subprocess runner, keyring get/set, binary finder, driver and desk factories, key tester, environment mapping, and sleep. Tests build a fake `SetupEnv`, so no test touches the real keychain, a subprocess, the network, or the screen. `routes/setup.py` keeps the live env on `app.state.setup_env` and reads it **per request**, so a test can swap it after `create_app`. The self-test runs on the **agent's own browser desk** (`BrowserDesk`, a cua-driver-owned isolated Chrome), never on one of the user's apps. It opens a scratch `data:` page, types `hello` into its text box, captures that window, and reads the value back.

Observed `cua-driver permissions status --json` output (cua-driver 0.32.0, 2026-10-02), which the parser below relies on:

```json
{"accessibility": true, "screen_recording": true, "direct_capture_status": "not_checked", "source": {"bundle_id": "com.trycua.driver"}}
```

---

## Task D1-1: Setup core (platform, key, driver, permissions, install/start)

**Files:**
- Create: `daemon/oversight/setup.py`
- Test: `daemon/tests/test_setup.py`

**Interfaces:**
- Consumes: `oversight.llm.CallRecord` and `oversight.llm.price_usd` (existing); `store.get_setting(key, default)` (C4, keys `"key_tested"`, `"plan_only"`, `"self_test_passed_at"`).
- Produces (used by D1-2, D1-3, and D1-4 only):
  - `SetupEnv`, `default_env()`, `detect_platform(p)`
  - `KEYCHAIN_SERVICE`, `KEYCHAIN_WARNING`, `ENV_VARS`, `MODELS`, `PANES`, `INSTALL_CMD`
  - `models_for(provider, model) -> dict[str, list[str]]`
  - `key_status(env, store, provider) -> dict` (the C1 `SetupStatus.key` shape)
  - `save_key(env, provider, key) -> str | None` (returns a warning)
  - `apply_keychain(environ, keyring_get) -> str | None`
  - `driver_status(env) -> {installed, version, running}`
  - `permission_status(env, binary) -> {accessibility, screen_recording}` (each a C1 `PermState`)
  - `open_permission(env, which) -> bool`
  - `install_driver(env) -> {ok, version, log_tail}`
  - `start_driver(env) -> {ok, error}`
  - `status(env, store, settings) -> dict` (the C1 `SetupStatus`, all fields)

- [ ] **Step 1: Write the failing tests (shared fakes and core logic)**

Create `daemon/tests/test_setup.py`:

```python
"""Track D1: first-run setup. Every OS / keychain / network / screen effect is faked."""

from __future__ import annotations

import asyncio
import json

import pytest

from oversight import setup
from oversight.cua import WindowState
from oversight.llm import CallRecord
from oversight.store import Store

BIN = "/bin/cua-driver"


class FakeKeyring:
    def __init__(self, broken: bool = False):
        self.data: dict[tuple[str, str], str] = {}
        self.broken = broken

    def get(self, service: str, name: str) -> str | None:
        if self.broken:
            raise RuntimeError("No recommended backend was available.")
        return self.data.get((service, name))

    def set(self, service: str, name: str, value: str) -> None:
        if self.broken:
            raise RuntimeError("No recommended backend was available.")
        self.data[(service, name)] = value


class FakeDriver:
    def __init__(self, ready: tuple[bool, str] = (True, "ok")):
        self._ready = ready

    async def ready(self) -> tuple[bool, str]:
        return self._ready


class FakeDesk:
    """Stands in for BrowserDesk: one scratch text box that echoes what was typed."""

    def __init__(self, echo: bool = True, png: bytes | None = b"png", has_box: bool = True):
        self.echo, self.png, self.has_box = echo, png, has_box
        self.typed: str | None = None
        self.urls: list[str | None] = []

    async def ensure(self, url: str | None = None):
        self.urls.append(url)

    async def observe(self, **_):
        value = self.typed if (self.echo and self.typed) else ""
        els = [{"element_index": 0, "role": "textbox", "label": "scratch", "value": value,
                "element_token": "ref-1"}] if self.has_box else []
        return WindowState(pid=1, window_id=2, elements=els, png=self.png)

    async def type(self, ref: str, text: str, *, replace: bool):
        assert ref == "ref-1" and replace
        self.typed = text
        return {}


def make_env(platform: str = "macos", outputs: dict | None = None,
             keyring: FakeKeyring | None = None, binary: str | None = BIN,
             key_ok: bool = True, desk: FakeDesk | None = None,
             driver: FakeDriver | None = None):
    calls: list[list[str]] = []
    outs = outputs or {}

    async def run(argv: list[str], timeout: float):
        calls.append(list(argv))
        for prefix, result in outs.items():
            if tuple(argv[:len(prefix)]) == prefix:
                return result
        return (0, "", "")

    async def test_key(provider: str, key: str, model: str):
        rec = CallRecord(scope="setup", provider=provider, model=model, input_tokens=8,
                         output_tokens=1, usd=0.00002)
        return (True, None, rec) if key_ok else (False, "That key was rejected (401).", rec)

    async def no_sleep(_s: float) -> None:
        return None

    kr = keyring or FakeKeyring()
    the_desk = desk or FakeDesk()
    env = setup.SetupEnv(
        platform=platform, run=run, keyring_get=kr.get, keyring_set=kr.set,
        find_binary=lambda: binary, make_driver=lambda _b: driver or FakeDriver(),
        make_desk=lambda _d: the_desk, test_key=test_key, environ={}, sleep=no_sleep)
    return env, calls


DRIVER_OK = {
    (BIN, "--version"): (0, "cua-driver 0.32.0\n", ""),
    (BIN, "status"): (0, "cua-driver daemon is running (pid 18383)\n", ""),
    (BIN, "permissions"): (0, json.dumps({"accessibility": True, "screen_recording": False,
                                          "direct_capture_status": "not_checked"}), ""),
}


def _store(tmp_path) -> Store:
    return Store(tmp_path / "t.db")


def test_detect_platform():
    assert setup.detect_platform("darwin") == "macos"
    assert setup.detect_platform("win32") == "windows"
    assert setup.detect_platform("linux") == "linux"


def test_permission_status_maps_cua_driver_booleans():
    env, calls = make_env(outputs=DRIVER_OK)
    got = asyncio.run(setup.permission_status(env, BIN))
    assert got == {"accessibility": "granted", "screen_recording": "denied"}
    assert calls[-1] == [BIN, "permissions", "status", "--json"]


def test_permission_status_unknown_on_garbage_and_missing_binary():
    env, _ = make_env(outputs={(BIN, "permissions"): (75, "permissions_pending: ...", "")})
    assert asyncio.run(setup.permission_status(env, BIN)) == {
        "accessibility": "unknown", "screen_recording": "unknown"}
    assert asyncio.run(setup.permission_status(env, None)) == {
        "accessibility": "unknown", "screen_recording": "unknown"}


def test_key_status_sources(tmp_path):
    store = _store(tmp_path)
    kr = FakeKeyring()
    env, _ = make_env(keyring=kr)
    assert setup.key_status(env, store, "anthropic") == {
        "provider": "anthropic", "present": False, "source": "none", "tested": False,
        "warning": None}
    env.environ["ANTHROPIC_API_KEY"] = "sk-env"
    assert setup.key_status(env, store, "anthropic")["source"] == "env"
    kr.data[(setup.KEYCHAIN_SERVICE, "ANTHROPIC_API_KEY")] = "sk-kc"
    store.set_setting("key_tested", {"anthropic": True})
    got = setup.key_status(env, store, "anthropic")
    assert (got["source"], got["present"], got["tested"]) == ("keychain", True, True)


def test_save_key_sets_env_and_keychain_or_warns():
    kr = FakeKeyring()
    env, _ = make_env(keyring=kr)
    assert setup.save_key(env, "openai", "sk-oa") is None
    assert env.environ["OPENAI_API_KEY"] == "sk-oa"
    assert kr.data[(setup.KEYCHAIN_SERVICE, "OPENAI_API_KEY")] == "sk-oa"
    broken, _ = make_env(keyring=FakeKeyring(broken=True))
    assert setup.save_key(broken, "anthropic", "sk-x") == setup.KEYCHAIN_WARNING
    assert broken.environ["ANTHROPIC_API_KEY"] == "sk-x"  # still usable this session


def test_apply_keychain_wins_over_env_and_reports_unavailable():
    kr = FakeKeyring()
    kr.data[(setup.KEYCHAIN_SERVICE, "ANTHROPIC_API_KEY")] = "sk-kc"
    environ = {"ANTHROPIC_API_KEY": "sk-env", "OPENAI_API_KEY": "sk-oa-env"}
    assert setup.apply_keychain(environ, kr.get) is None
    assert environ == {"ANTHROPIC_API_KEY": "sk-kc", "OPENAI_API_KEY": "sk-oa-env"}
    environ2 = {"ANTHROPIC_API_KEY": "sk-env"}
    warn = setup.apply_keychain(environ2, FakeKeyring(broken=True).get)
    assert warn and "keychain" in warn.lower()
    assert environ2 == {"ANTHROPIC_API_KEY": "sk-env"}


def test_driver_status_installed_version_running_and_missing():
    env, _ = make_env(outputs=DRIVER_OK)
    assert asyncio.run(setup.driver_status(env)) == {
        "installed": True, "version": "0.32.0", "running": True}
    stopped, _ = make_env(outputs={**DRIVER_OK,
                                   (BIN, "status"): (1, "cua-driver daemon is not running\n", "")})
    assert asyncio.run(setup.driver_status(stopped))["running"] is False
    missing, _ = make_env(binary=None)
    assert asyncio.run(setup.driver_status(missing)) == {
        "installed": False, "version": None, "running": False}


def test_open_permission_deep_links_on_macos_only():
    env, calls = make_env()
    assert asyncio.run(setup.open_permission(env, "screen_recording")) is True
    assert calls[-1] == ["open", setup.PANES["screen_recording"]]
    linux, lcalls = make_env(platform="linux")
    assert asyncio.run(setup.open_permission(linux, "accessibility")) is False
    assert lcalls == []
    with pytest.raises(ValueError):
        asyncio.run(setup.open_permission(env, "camera"))


def test_install_driver_runs_official_script_and_tails_log():
    log = "\n".join(f"line {i}" for i in range(100))
    env, calls = make_env(outputs={("/bin/bash", "-c"): (0, log, ""), **DRIVER_OK})
    got = asyncio.run(setup.install_driver(env))
    assert calls[0] == ["/bin/bash", "-c", setup.INSTALL_CMD]
    assert got["ok"] is True and got["version"] == "0.32.0"
    assert got["log_tail"].splitlines() == [f"line {i}" for i in range(60, 100)]
    win, wcalls = make_env(platform="windows")
    w = asyncio.run(setup.install_driver(win))
    assert w["ok"] is False and "Windows" in w["log_tail"] and wcalls == []


def test_start_driver_opens_cuadriver_then_waits_for_running():
    env, calls = make_env(outputs=DRIVER_OK)
    assert asyncio.run(setup.start_driver(env)) == {"ok": True, "error": None}
    assert calls[0] == ["open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"]
    never, _ = make_env(outputs={**DRIVER_OK, (BIN, "status"): (1, "not running", "")})
    r = asyncio.run(setup.start_driver(never))
    assert r["ok"] is False and "10 s" in r["error"]


def test_status_complete_rules(tmp_path):
    from oversight.settings import Settings

    store = _store(tmp_path)
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    env, _ = make_env(outputs=DRIVER_OK)
    got = asyncio.run(setup.status(env, store, s))
    assert got["platform"] == "macos" and got["complete"] is False
    assert got["driver"] == {"installed": True, "version": "0.32.0", "running": True}
    env.environ["ANTHROPIC_API_KEY"] = "sk"
    store.set_setting("plan_only", True)
    got = asyncio.run(setup.status(env, store, s))
    assert got["plan_only"] is True and got["complete"] is True  # key + plan-only
    store.set_setting("plan_only", False)
    assert asyncio.run(setup.status(env, store, s))["complete"] is False  # screen_recording denied
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd daemon && uv run pytest tests/test_setup.py -q`
Expected: FAIL at collection with `ImportError: cannot import name 'setup' from 'oversight'`.

- [ ] **Step 3: Implement `oversight/setup.py` (core)**

Create `daemon/oversight/setup.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd daemon && uv run pytest tests/test_setup.py -q`
Expected: `11 passed`.

- [ ] **Step 5: Commit**

```bash
git add daemon/oversight/setup.py daemon/tests/test_setup.py
git commit -m "daemon: setup core (keys, keychain, driver, permissions, install/start)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D1-2: Self-test on the agent's own desk

**Files:**
- Modify: `daemon/oversight/setup.py` (add `self_test`)
- Test: `daemon/tests/test_setup.py` (append)

**Interfaces:**
- Consumes: `SetupEnv.make_driver(binary).ready() -> (bool, str)`. `SetupEnv.make_desk(driver)` returns an object with `ensure(url)`, `observe() -> WindowState`, and `type(ref, text, replace=True)`; this is exactly `BrowserDesk`'s public surface in `oversight/browser_desk.py`.
- Produces: `self_test(env) -> tuple[bool, str]` (used by D1-4 `POST /setup/self-test`).

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_setup.py`:

```python
def test_self_test_passes_on_agent_desk_scratch_page():
    desk = FakeDesk()
    env, _ = make_env(desk=desk)
    ok, detail = asyncio.run(setup.self_test(env))
    assert ok is True, detail
    assert desk.urls == [setup.SELF_TEST_URL] and desk.typed == "hello"
    assert "own browser window" in detail


@pytest.mark.parametrize("desk, needle", [
    (FakeDesk(png=None), "Screen Recording"),
    (FakeDesk(echo=False), "read the typed text back"),
    (FakeDesk(has_box=False), "Accessibility"),
])
def test_self_test_names_what_failed(desk, needle):
    env, _ = make_env(desk=desk)
    ok, detail = asyncio.run(setup.self_test(env))
    assert ok is False and needle in detail


def test_self_test_stops_before_the_desk_when_driver_not_ready_or_missing():
    desk = FakeDesk()
    env, _ = make_env(desk=desk, driver=FakeDriver((False, "permissions_pending: grant CuaDriver")))
    assert asyncio.run(setup.self_test(env)) == (False, "permissions_pending: grant CuaDriver")
    assert desk.urls == []
    missing, _ = make_env(binary=None)
    assert asyncio.run(setup.self_test(missing)) == (False, "cua-driver is not installed.")


def test_self_test_reports_driver_exceptions_instead_of_raising():
    class Exploding(FakeDesk):
        async def ensure(self, url=None):
            raise RuntimeError("agent browser (pid 1) has no window")

    env, _ = make_env(desk=Exploding())
    ok, detail = asyncio.run(setup.self_test(env))
    assert ok is False and "has no window" in detail
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd daemon && uv run pytest tests/test_setup.py -q -k self_test`
Expected: FAIL with `AttributeError: module 'oversight.setup' has no attribute 'self_test'`.

- [ ] **Step 3: Implement `self_test`**

Append to `daemon/oversight/setup.py`:

```python
# ------------------------------------------------------------------ self-test

async def self_test(env: SetupEnv) -> tuple[bool, str]:
    """Open a scratch page on the AGENT'S OWN browser desk (never the user's apps),
    type "hello", capture that window, read the value back. Each failure names the
    permission that most likely caused it, so the wizard can point at the fix."""
    binary = env.find_binary()
    if not binary:
        return False, "cua-driver is not installed."
    drv = env.make_driver(binary)
    ok, detail = await drv.ready()
    if not ok:
        return False, detail
    desk = env.make_desk(drv)
    try:
        await desk.ensure(SELF_TEST_URL)
        state = await desk.observe()
        box = next((e for e in state.elements
                    if e.get("role") in ("textbox", "textarea") and e.get("element_token")), None)
        if box is None:
            return False, ("The agent's browser opened, but the scratch text box wasn't readable "
                           "(Accessibility).")
        await desk.type(box["element_token"], SELF_TEST_TEXT, replace=True)
        await env.sleep(0.3)
        after = await desk.observe()
    except Exception as e:  # driver/browser failure: report it, never raise into the API
        return False, f"{type(e).__name__}: {e}"
    if after.png is None:
        return False, ("Typed into the scratch page but couldn't capture its window "
                       "(Screen Recording).")
    if not any(SELF_TEST_TEXT in str(e.get("value") or "") for e in after.elements):
        return False, "Captured the window, but couldn't read the typed text back."
    return True, (f'Typed "{SELF_TEST_TEXT}" into the agent\'s own browser window, captured '
                  "that window, and read the text back.")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd daemon && uv run pytest tests/test_setup.py -q`
Expected: `17 passed`.

- [ ] **Step 5: Commit**

```bash
git add daemon/oversight/setup.py daemon/tests/test_setup.py
git commit -m "daemon: setup self-test on the agent's own browser desk" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D1-3: Keychain at daemon start, and a resettable cua-driver cache

**Files:**
- Modify: `daemon/oversight/settings.py`
- Test: `daemon/tests/test_setup.py` (append)

**Interfaces:**
- Consumes: `setup.apply_keychain` and `setup.keyring_get` (D1-1).
- Produces:
  - `settings.reset_cua_cache() -> None`, so D1-4 can force `/health` to re-probe after start, install, or self-test.
  - `load_settings()` now applies keychain keys before it computes `provider` and `api_key_present`. `OVERSIGHT_NO_KEYCHAIN=1` skips this, for CI.
  - New field `Settings.keychain_warning: str | None = None`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_setup.py`:

```python
def test_load_settings_applies_keychain_first(monkeypatch, tmp_path):
    from oversight import settings as settings_mod

    monkeypatch.setenv("OVERSIGHT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OVERSIGHT_NO_KEYCHAIN", raising=False)
    monkeypatch.delenv("OVERSIGHT_PROVIDER", raising=False)
    monkeypatch.delenv("OVERSIGHT_MODEL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(settings_mod, "find_env_file", lambda *a, **k: None)
    kr = FakeKeyring()
    kr.data[(setup.KEYCHAIN_SERVICE, "ANTHROPIC_API_KEY")] = "sk-from-keychain"
    monkeypatch.setattr(setup, "keyring_get", kr.get)
    s = settings_mod.load_settings(fixtures=True)
    import os
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-from-keychain"
    assert s.provider == "anthropic" and s.api_key_present is True
    assert s.keychain_warning is None


def test_load_settings_keychain_unavailable_is_a_warning_not_a_crash(monkeypatch, tmp_path):
    from oversight import settings as settings_mod

    monkeypatch.setenv("OVERSIGHT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OVERSIGHT_NO_KEYCHAIN", raising=False)
    monkeypatch.setattr(settings_mod, "find_env_file", lambda *a, **k: None)
    monkeypatch.setattr(setup, "keyring_get", FakeKeyring(broken=True).get)
    s = settings_mod.load_settings(fixtures=True)
    assert s.keychain_warning and "keychain" in s.keychain_warning.lower()


def test_reset_cua_cache_clears_cached_probe():
    from oversight import settings as settings_mod

    settings_mod._CUA_CACHE["value"] = (True, "running", "ok")
    settings_mod.reset_cua_cache()
    assert settings_mod._CUA_CACHE["value"] is None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd daemon && uv run pytest tests/test_setup.py -q -k "load_settings or reset_cua"`
Expected: FAIL, with `AttributeError: ... has no attribute 'keychain_warning'` and `... has no attribute 'reset_cua_cache'`.

- [ ] **Step 3: Implement**

In `daemon/oversight/settings.py`:

(a) Directly below the `_CUA_TTL_S = 8.0` line, add:

```python
def reset_cua_cache() -> None:
    """Forget the cached cua-driver probe (after start / install / permissions / self-test)."""
    _CUA_CACHE["at"] = 0.0
    _CUA_CACHE["value"] = None
```

(b) In the `Settings` dataclass, add a field after `env_file`:

```python
    keychain_warning: str | None = None
```

(c) In `load_settings`, insert directly after the `if env_file is not None: load_dotenv(...)` block, before `anthropic_key = ...`:

```python
    # Keys saved by the setup wizard live in the OS keychain and win over env/.env.
    keychain_warning = None
    if os.environ.get("OVERSIGHT_NO_KEYCHAIN") != "1":
        from . import setup as setup_mod

        keychain_warning = setup_mod.apply_keychain(os.environ, setup_mod.keyring_get)
```

(d) In the `Settings(...)` constructor call at the end of `load_settings`, add `keychain_warning=keychain_warning,`.

`setup_mod.keyring_get` is looked up at call time, so the test's `monkeypatch.setattr(setup, "keyring_get", …)` takes effect.

- [ ] **Step 4: Run the whole setup suite**

Run: `cd daemon && uv run pytest tests/test_setup.py -q`
Expected: `20 passed`.

- [ ] **Step 5: Commit**

```bash
git add daemon/oversight/settings.py daemon/tests/test_setup.py
git commit -m "daemon: keychain keys win at startup; resettable cua-driver probe cache" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D1-4: Setup and settings HTTP routes

**Files:**
- Modify: `daemon/oversight/routes/setup.py` (replaces the Wave 0 stub; keeps `register(app, ctx)`)
- Test: `daemon/tests/test_setup.py` (append)

**Interfaces:**
- Consumes:
  - C4 `Ctx`: `ctx.st.settings`, `ctx.st.store`, `ctx.st.llm` (reassigned on a provider or model change), and `ctx.record_call(None, None, rec)`.
  - Store settings keys `"setup_complete"`, `"plan_only"`, `"provider"`, `"model"`, `"key_tested"`, `"self_test_passed_at"`.
  - `store.now_iso` (module function in `oversight/store.py`).
  - Everything from D1-1 through D1-3.
- Produces: every C3 row owned by D1, with the exact shapes:
  - `GET /setup/status` → `SetupStatus`
  - `PUT /setup/key` → `{ok, error}`
  - `POST /setup/driver/install` → `{ok, version, log_tail}`
  - `POST /setup/driver/start` → `{ok, error}`
  - `POST /setup/permissions/open` → `{ok}`
  - `POST /setup/self-test` → `{ok, detail}`
  - `POST /setup/complete` → `{ok}`
  - `GET /settings` and `PUT /settings` → `AppSettings`

  `/health.setup_complete` and `/health.plan_only` (W0-1) read the keys these routes write. `app.state.setup_env` is the swappable `SetupEnv`.

- [ ] **Step 1: Write the failing API tests**

Append to `daemon/tests/test_setup.py`:

```python
from fastapi.testclient import TestClient  # noqa: E402

from oversight.api import create_app  # noqa: E402
from oversight.settings import Settings  # noqa: E402


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _use(client, env):
    client.app.state.setup_env = env
    return client.app.state.oversight


def test_setup_status_shape(client):
    env, _ = make_env(outputs=DRIVER_OK)
    _use(client, env)
    got = client.get("/setup/status").json()
    assert set(got) == {"platform", "key", "driver", "permissions", "self_test", "plan_only",
                        "complete"}
    assert got["permissions"] == {"accessibility": "granted", "screen_recording": "denied"}
    assert got["key"]["source"] == "none" and got["complete"] is False


def test_put_key_success_stores_tests_and_counts_cost(client):
    env, _ = make_env()
    st = _use(client, env)
    r = client.put("/setup/key", json={"provider": "anthropic", "key": "  sk-ant-good  "})
    assert r.status_code == 200 and r.json() == {"ok": True, "error": None}
    assert "sk-ant-good" not in r.text  # never echoed
    assert env.environ["ANTHROPIC_API_KEY"] == "sk-ant-good"
    assert st.store.get_setting("key_tested") == {"anthropic": True}
    assert st.settings.api_key_present is True
    assert st.store.total_cost() > 0  # the 1-token test is a counted LLM call


def test_put_key_rejected_stores_nothing(client):
    env, _ = make_env(key_ok=False)
    st = _use(client, env)
    r = client.put("/setup/key", json={"provider": "anthropic", "key": "sk-bad"})
    assert r.json() == {"ok": False, "error": "That key was rejected (401)."}
    assert "ANTHROPIC_API_KEY" not in env.environ
    assert st.store.get_setting("key_tested", {}) == {}


def test_put_key_validation(client):
    _use(client, make_env()[0])
    assert client.put("/setup/key", json={"provider": "gemini", "key": "x"}).status_code == 400
    assert client.put("/setup/key", json={"provider": "openai", "key": "   "}).json() == {
        "ok": False, "error": "The key is empty."}


def test_permissions_open_and_driver_endpoints(client):
    env, calls = make_env(outputs={("/bin/bash", "-c"): (0, "installed\n", ""), **DRIVER_OK})
    _use(client, env)
    assert client.post("/setup/permissions/open", json={"which": "accessibility"}).json() == {"ok": True}
    assert ["open", setup.PANES["accessibility"]] in calls
    assert client.post("/setup/permissions/open", json={"which": "camera"}).status_code == 400
    inst = client.post("/setup/driver/install", json={}).json()
    assert inst == {"ok": True, "version": "0.32.0", "log_tail": "installed"}
    assert client.post("/setup/driver/start", json={}).json() == {"ok": True, "error": None}


def test_self_test_endpoint_records_pass(client):
    env, _ = make_env(outputs=DRIVER_OK)
    st = _use(client, env)
    r = client.post("/setup/self-test", json={}).json()
    assert r["ok"] is True
    assert st.store.get_setting("self_test_passed_at")
    assert client.get("/setup/status").json()["self_test"]["passed_at"]


def test_complete_and_plan_only_reach_health(client):
    _use(client, make_env()[0])
    assert client.get("/health").json()["setup_complete"] is False
    assert client.post("/setup/complete", json={}).json() == {"ok": True}
    assert client.get("/health").json()["setup_complete"] is True
    got = client.put("/settings", json={"plan_only": True}).json()
    assert got["plan_only"] is True and client.get("/health").json()["plan_only"] is True


def test_settings_get_put_and_validation(client):
    st = _use(client, make_env()[0])
    got = client.get("/settings").json()
    assert got == {"provider": "anthropic", "model": "claude-sonnet-5-5", "plan_only": False,
                   "models": setup.MODELS}
    assert client.put("/settings", json={"model": "gpt-5.5"}).status_code == 400
    assert client.put("/settings", json={"provider": "gemini"}).status_code == 400
    sw = client.put("/settings", json={"provider": "openai"}).json()
    assert (sw["provider"], sw["model"]) == ("openai", "gpt-5.5")
    assert st.store.get_setting("provider") == "openai" and st.settings.model == "gpt-5.5"


def test_persisted_provider_and_model_applied_at_startup(tmp_path):
    pre = Store(tmp_path / "oversight.db")
    pre.set_setting("provider", "openai")
    pre.set_setting("model", "gpt-5.5")
    pre.db.close()
    s = Settings(fixtures=False, exec_mode="simulated", data_dir=tmp_path)
    app = create_app(s)
    assert (s.provider, s.model) == ("openai", "gpt-5.5")
    assert app.state.oversight.llm.provider == "openai"


def test_review_focus_non_macos_and_no_keychain(client):
    """Review Focus: Linux/Windows has no TCC panes, and a missing keychain backend
    degrades to env keys with a visible warning instead of failing setup."""
    env, calls = make_env(platform="linux", keyring=FakeKeyring(broken=True), outputs=DRIVER_OK)
    env.environ["ANTHROPIC_API_KEY"] = "sk-env"
    _use(client, env)
    got = client.get("/setup/status").json()
    assert got["platform"] == "linux"
    assert got["permissions"] == {"accessibility": "n/a", "screen_recording": "n/a"}
    assert got["key"]["source"] == "env" and got["key"]["present"] is True
    assert got["key"]["warning"] == setup.KEYCHAIN_WARNING
    assert not any(c[:3] == [BIN, "permissions", "status"] for c in calls)
    assert client.post("/setup/permissions/open", json={"which": "accessibility"}).json() == {"ok": False}
    r = client.put("/setup/key", json={"provider": "anthropic", "key": "sk-new"}).json()
    assert r == {"ok": True, "error": None} and env.environ["ANTHROPIC_API_KEY"] == "sk-new"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd daemon && uv run pytest tests/test_setup.py -q -k "setup_status or put_key or permissions_open or self_test_endpoint or complete or settings_get or persisted or review_focus"`
Expected: FAIL. `/setup/status` and the other new routes answer 404 (the Wave 0 stub registers nothing), and `test_persisted...` fails its provider assertion.

- [ ] **Step 3: Implement the routes**

Replace the whole of `daemon/oversight/routes/setup.py` with:

```python
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
```

- [ ] **Step 4: Run the setup suite and the whole daemon suite**

Run: `cd daemon && uv run pytest tests/test_setup.py -q`
Expected: `30 passed`.

Run: `cd daemon && uv run pytest -q`
Expected: all pass (W0-1's `test_health_has_setup_fields` included).

- [ ] **Step 5: Smoke against a live fixtures daemon (read-only endpoints only)**

This uses the real `SetupEnv`, but only reads. It doesn't store keys, install, open panes, or run the self-test.

```bash
cd daemon && OVERSIGHT_DATA_DIR="$(mktemp -d)" OVERSIGHT_NO_KEYCHAIN=1 uv run oversight-daemon --fixtures --port 8799 &
sleep 3
curl -s 127.0.0.1:8799/setup/status | python3 -m json.tool
curl -s 127.0.0.1:8799/settings
kill %1
```

Expected on this Mac:
- `platform` is `"macos"`.
- `driver.installed` is `true` with a `version` like `"0.32.0"`.
- `permissions` shows `"granted"` or `"denied"` per what System Settings says (not `"unknown"`) when the CuaDriver daemon is running.
- `/settings` lists `models.anthropic` and `models.openai`.

- [ ] **Step 6: Commit**

```bash
git add daemon/oversight/routes/setup.py daemon/tests/test_setup.py
git commit -m "daemon: setup + settings routes (status, key, driver, permissions, self-test)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

**Track D1 exit check:** `cd daemon && uv run pytest -q` passes, and `git diff --name-only ui-redesign...HEAD` lists only `daemon/oversight/setup.py`, `daemon/oversight/routes/setup.py`, `daemon/oversight/settings.py`, and `daemon/tests/test_setup.py`.

---

## Contract notes

- **OpenAI key test:** it uses `models.retrieve(model)` instead of a 1-token completion, because reasoning models reject a 1-token cap. The `CallRecord` still flows through `record_call` (cost 0). Anthropic keeps the spec's 1-token call.
- **Self-test target:** it runs on the agent's own `BrowserDesk` scratch `data:` page, not a native scratch window. That avoids typing into a user app such as TextEdit, which on recent macOS opens a file panel. The behavior matches the spec's intent: type `hello`, screenshot, read it back.
- **What `complete` means:** `SetupStatus.complete` is computed live (key present AND (plan-only OR agent ready)). `/health.setup_complete` is the persisted flag written by `POST /setup/complete`. U6 should call `completeSetup()` when the wizard finishes; it should not infer completion from `complete`.
- **Keychain warning on save:** a warning from saving a key is not returned by `PUT /setup/key`, whose C3 shape is `{ok, error}`. It appears as `SetupStatus.key.warning` on the next `/setup/status` poll.
