"""Shared test setup: never ask the real cua-driver for the installed-app catalog."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_real_app_catalog(monkeypatch, request):
    if request.node.get_closest_marker("real_catalog"):
        return
    from oversight import apps

    async def empty(driver=None):
        return []

    monkeypatch.setattr(apps, "app_catalog", empty)


def pytest_configure(config):
    config.addinivalue_line("markers", "real_catalog: use the real apps.app_catalog (with a fake driver)")
