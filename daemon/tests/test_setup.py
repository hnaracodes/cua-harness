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
