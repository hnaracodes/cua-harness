"""Native apps a plan step may run in: the installed-app catalog and the denylist.

The catalog comes from cua-driver ``list_apps``. The planner may only pick an
app from it, and the executor refuses any step whose app is denied (terminals,
settings, the keychain, scripting tools, cua-driver itself and this app), so a
plan can never route the agent into a tool that can change the machine.
"""

from __future__ import annotations

import time
from typing import Any

DENIED_BUNDLES = frozenset({
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.apple.systempreferences",
    "com.apple.SystemSettings",
    "com.apple.keychainaccess",
    "com.apple.ScriptEditor2",
    "com.apple.Automator",
    "com.apple.DiskUtility",
    "com.apple.ActivityMonitor",
    "com.trycua.driver",
})
#: Substrings that deny a bundle id: this app (any build of it).
DENIED_SUBSTRINGS = ("agent-oversight", "edu.cmu.sketch-oversight")

CATALOG_MAX = 80
CATALOG_TTL_S = 600.0

_cache: tuple[float, list[dict]] | None = None


def is_denied(bundle_id: str | None) -> bool:
    if not bundle_id:
        return False
    b = bundle_id.strip()
    if b in DENIED_BUNDLES or b.lower() in {d.lower() for d in DENIED_BUNDLES}:
        return True
    low = b.lower()
    return any(s in low for s in DENIED_SUBSTRINGS)


def build_catalog(raw: Any) -> list[dict]:
    """``list_apps`` output to ``[{"name", "bundle_id"}]``: denied apps removed,
    deduplicated by bundle id, sorted by name, capped at ``CATALOG_MAX``."""
    items = raw.get("apps") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    seen: dict[str, dict] = {}
    for a in items:
        if not isinstance(a, dict):
            continue
        name = str(a.get("name") or "").strip()
        bundle = str(a.get("bundle_id") or a.get("bundleId") or "").strip()
        if not name or not bundle or is_denied(bundle) or bundle in seen:
            continue
        seen[bundle] = {"name": name, "bundle_id": bundle}
    return sorted(seen.values(), key=lambda a: (a["name"].lower(), a["bundle_id"]))[:CATALOG_MAX]


async def app_catalog(driver: Any = None) -> list[dict]:
    """Installed apps the planner may route a step to. ``[]`` on any error or
    when cua-driver is missing. Cached for ``CATALOG_TTL_S``."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CATALOG_TTL_S:
        return list(_cache[1])
    try:
        if driver is None:
            from .cua import CuaDriver, find_binary

            if find_binary() is None:
                return []
            driver = CuaDriver()
        catalog = build_catalog(await driver.call("list_apps", {}))
    except Exception:  # noqa: BLE001 - no catalog just means browser-only plans
        return []
    _cache = (now, catalog)
    return list(catalog)


def clear_cache() -> None:
    global _cache
    _cache = None


def resolve_app(name_or_bundle: str | None, catalog: Any) -> dict | None:
    """The catalog entry whose name or bundle id matches (case-insensitive), or None."""
    if not name_or_bundle or not isinstance(name_or_bundle, str):
        return None
    key = name_or_bundle.strip().lower()
    if not key or key in ("null", "none", "browser"):
        return None
    for a in catalog or ():
        if key in (str(a.get("name", "")).lower(), str(a.get("bundle_id", "")).lower()):
            if is_denied(a.get("bundle_id")):
                return None
            return {"name": a["name"], "bundle_id": a["bundle_id"]}
    return None


__all__ = ["CATALOG_MAX", "DENIED_BUNDLES", "app_catalog", "build_catalog", "clear_cache",
           "is_denied", "resolve_app"]
