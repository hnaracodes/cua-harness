"""Where the daemon keeps user data in dev vs inside the frozen sidecar."""

import sys

from oversight import host_desk, settings


def test_dev_defaults_stay_in_the_source_tree(monkeypatch):
    monkeypatch.delenv("OVERSIGHT_DATA_DIR", raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert settings.default_data_dir() == settings.DAEMON_DIR / ".data"
    assert host_desk.default_profile_dir().endswith(".agent-desk/chrome-profile")


def test_frozen_uses_the_per_user_app_folder(monkeypatch):
    monkeypatch.delenv("OVERSIGHT_DATA_DIR", raising=False)
    monkeypatch.delenv("OVERSIGHT_APPDEV_ROOT", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    data = settings.default_data_dir()
    assert data == settings.user_data_dir()
    assert data.name == settings.APP_IDENTIFIER
    assert host_desk.default_profile_dir() == str(data / "agent-desk" / "chrome-profile")


def test_env_override_wins_even_when_frozen(monkeypatch, tmp_path):
    monkeypatch.setenv("OVERSIGHT_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert settings.default_data_dir() == tmp_path
