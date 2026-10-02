"""Window selection for the agent desk.

The fixture is real ``cua-driver call list_windows`` output for the agent's
Chrome (cua-driver 0.32.0, Chrome 154, 2026-10-02). Chrome owns one real
browser window plus several off-screen helper surfaces; the helper at 500x500
has the highest z_index, and picking it made every capture blank and every
input fail with ``off_space_or_ax_unresolved`` / ``screenshot_context_missing``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oversight.host_desk import pick_window  # noqa: E402


def _w(wid, w, h, x, y, on_screen, title, z):
    return {
        "app_name": "Google Chrome", "pid": 22466, "window_id": wid, "layer": 0,
        "bounds": {"width": w, "height": h, "x": x, "y": y},
        "is_on_screen": on_screen, "title": title, "z_index": z,
    }


REAL_CHROME = [
    _w(63059, 500, 500, 0, 617, False, "", 423),
    _w(63053, 1, 1, 0, 0, False, "", 422),
    _w(63050, 1118, 139, 179, 85, False, "", 421),
    _w(63049, 1280, 860, 80, 60, True, "New Tab", 420),
    _w(63054, 1728, 33, 0, 0, False, "", 419),
    _w(63057, 1728, 33, 0, 0, False, "", 418),
    _w(63056, 1728, 33, 0, 0, False, "", 417),
    _w(63055, 1728, 33, 0, 0, False, "", 416),
    _w(63052, 1, 1, 0, 0, False, "", 415),
    _w(63051, 1118, 138, 179, 85, False, "", 414),
]


def test_picks_the_onscreen_browser_window_not_a_helper_surface():
    assert pick_window(REAL_CHROME)["window_id"] == 63049


def test_prefers_titled_window_when_on_screen_flag_is_missing():
    no_flag = [{k: v for k, v in w.items() if k != "is_on_screen"} for w in REAL_CHROME]
    assert pick_window(no_flag)["window_id"] == 63049


def test_none_when_only_helper_surfaces_exist():
    helpers = [w for w in REAL_CHROME if w["window_id"] != 63049]
    assert pick_window(helpers) is None


def test_frontmost_of_two_real_windows():
    second = _w(63100, 1280, 860, 120, 100, True, "Google Search", 430)
    assert pick_window([*REAL_CHROME, second])["window_id"] == 63100
