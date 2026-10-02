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


def test_put_key_for_other_provider_makes_it_active(tmp_path):
    """Fresh machine: the daemon defaults to openai (no keys). Saving a tested Anthropic
    key must make Anthropic the active provider, or the wizard stays stuck on openai."""
    s = Settings(fixtures=False, exec_mode="simulated", provider="openai", model="gpt-5.5",
                 data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        env, _ = make_env()
        st = _use(c, env)
        r = c.put("/setup/key", json={"provider": "anthropic", "key": "sk-ant-good"})
        assert r.json() == {"ok": True, "error": None}
        got = c.get("/setup/status").json()
        assert got["key"]["provider"] == "anthropic"
        assert got["key"]["present"] is True and got["key"]["tested"] is True
        assert (s.provider, s.model) == ("anthropic", setup.MODELS["anthropic"][0])
        assert s.api_key_present is True
        assert st.store.get_setting("provider") == "anthropic"
        assert st.store.get_setting("model") == setup.MODELS["anthropic"][0]
        assert st.llm.provider == "anthropic" and st.llm.model == setup.MODELS["anthropic"][0]
        assert c.get("/settings").json()["provider"] == "anthropic"


def test_put_key_switch_reuses_stored_model_for_that_provider(tmp_path):
    s = Settings(fixtures=False, exec_mode="simulated", provider="openai", model="gpt-5.5",
                 data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        env, _ = make_env()
        st = _use(c, env)
        st.store.set_setting("model", "claude-opus-5-5")  # chosen earlier for anthropic
        assert c.put("/setup/key", json={"provider": "anthropic", "key": "k"}).json()["ok"]
        assert s.model == "claude-opus-5-5"


def test_foreign_origin_is_refused_before_anything_runs(client):
    """Any web page could otherwise POST to the daemon (a 'simple' cross-origin POST is
    sent even when CORS hides the response). A foreign Origin gets 403 and nothing runs."""
    env, calls = make_env(outputs={("/bin/bash", "-c"): (0, "installed\n", ""), **DRIVER_OK})
    st = _use(client, env)
    evil = {"Origin": "https://evil.example"}
    r = client.post("/setup/driver/install", headers=evil)
    assert r.status_code == 403 and r.json() == {"error": "origin not allowed"}
    assert calls == []
    r = client.put("/setup/key", headers=evil, json={"provider": "anthropic", "key": "sk-x"})
    assert r.status_code == 403 and "ANTHROPIC_API_KEY" not in env.environ
    r = client.put("/settings", headers=evil, json={"plan_only": True})
    assert r.status_code == 403 and not st.store.get_setting("plan_only", False)
    pre = client.options("/settings", headers={**evil, "Access-Control-Request-Method": "PUT"})
    assert pre.status_code == 403
    assert "access-control-allow-origin" not in pre.headers
    # Look-alike origins are not the app.
    for o in ("http://localhost.evil.example", "http://evil.example/?http://localhost",
              "null", "tauri://localhost.evil"):
        assert client.get("/health", headers={"Origin": o}).status_code == 403, o


@pytest.mark.parametrize("origin", ["http://localhost:1420", "http://127.0.0.1:5173",
                                    "tauri://localhost", "http://tauri.localhost",
                                    "https://tauri.localhost", "http://localhost"])
def test_app_origins_are_allowed_with_cors_headers(client, origin):
    env, calls = make_env(outputs={("/bin/bash", "-c"): (0, "installed\n", ""), **DRIVER_OK})
    _use(client, env)
    r = client.post("/setup/driver/install", headers={"Origin": origin})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.headers["access-control-allow-origin"] == origin
    pre = client.options("/settings", headers={"Origin": origin,
                                               "Access-Control-Request-Method": "PUT"})
    assert pre.status_code == 200
    assert pre.headers["access-control-allow-origin"] == origin


def test_no_origin_keeps_full_capability(client):
    """curl and scripts send no Origin: the daemon stays replaceable by a curl script."""
    env, calls = make_env(outputs={("/bin/bash", "-c"): (0, "installed\n", ""), **DRIVER_OK})
    _use(client, env)
    assert client.post("/setup/driver/install").json()["ok"] is True
    assert ["/bin/bash", "-c", setup.INSTALL_CMD] in calls
    assert client.get("/health").status_code == 200


def test_startup_keychain_warning_reaches_setup_status(tmp_path):
    """Settings.keychain_warning (computed once at startup) shows in key.warning when
    no newer warning exists; a live keychain failure is newer and wins."""
    startup = "System keychain unavailable (RuntimeError); using environment keys."
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path,
                 keychain_warning=startup)
    with TestClient(create_app(s)) as c:
        _use(c, make_env()[0])
        assert c.get("/setup/status").json()["key"]["warning"] == startup
        _use(c, make_env(keyring=FakeKeyring(broken=True))[0])
        assert c.get("/setup/status").json()["key"]["warning"] == setup.KEYCHAIN_WARNING
    with TestClient(create_app(Settings(fixtures=True, exec_mode="simulated",
                                        data_dir=tmp_path))) as c:
        _use(c, make_env()[0])
        assert c.get("/setup/status").json()["key"]["warning"] is None
