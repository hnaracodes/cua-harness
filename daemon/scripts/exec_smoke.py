# /// script
# requires-python = ">=3.12"
# dependencies = ["anthropic>=1.11", "pillow>=10.3"]
# ///
"""Executor gate (docs/07, session C).

Scripted, no LLM:
  1. launch the agent's Chrome with its own profile, in the background
  2. open google.com, type "tennis rackets under $100", submit
  3. window-scoped screenshot to <appdev>/.agent-desk/smoke.png
  4. verify (a) image size matches the Chrome window, not the display,
     (b) the mouse cursor did not move, (c) the frontmost app did not change

With --live (and fewer than 3 lines in LIVE_RUNS.log): one short LLM run of
step 1 through run_steps with a 25-action cap, logged to LIVE_RUNS.log.

    uv run daemon/scripts/exec_smoke.py            # scripted gate
    uv run daemon/scripts/exec_smoke.py --live     # + one live run of step 1
    uv run daemon/scripts/exec_smoke.py --simulated  # executor in simulated mode, no desktop
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oversight.cua import CuaDriver, CuaDriverError  # noqa: E402
from oversight.executor import ExecConfig, ExecStep, open_url, run_steps  # noqa: E402
from oversight.browser_desk import BrowserDesk, frontmost_bundle_id  # noqa: E402
from oversight.host_desk import AgentDesk, appdev_root, frontmost_app  # noqa: E402

QUERY = "tennis rackets under $100"
STEP1 = ExecStep(
    id="stp_smoke_1", index=1, title="Search for tennis rackets under $100",
    description="Use a shopping website or search engine to look for tennis rackets priced under $100 "
    "that would be suitable as a birthday gift.",
)
# Executor-internal events the daemon consumes itself and never forwards: "frame"
# carries the raw window PNG (bytes), which json.dumps cannot serialize.
INTERNAL_KINDS = frozenset({"frame"})
TASK = ("Help me find a tennis racket less than $100 for my friends birthday present, and prepare a short "
        "message to my other friends to let them know I am planning a party via whatsapp.")


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def load_env() -> None:
    """First .env walking up from daemon/, also checking testing/.env at each level."""
    here = Path(__file__).resolve().parents[1]
    for d in [here, *here.parents]:
        for cand in (d / ".env", d / "testing" / ".env"):
            if cand.is_file():
                for line in cand.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip().removeprefix("export ").strip()
                    os.environ.setdefault(k, v.strip().strip('"').strip("'"))
                return


def find_by(ws, roles: tuple[str, ...], words: tuple[str, ...]):
    for el in ws.elements:
        role = str(el.get("role") or "").removeprefix("AX").lower()
        label = str(el.get("label") or "").lower()
        if role in roles and any(w in label for w in words) and el.get("element_token"):
            return el
    return None


async def scripted(desk: AgentDesk, driver: CuaDriver, out_png: Path) -> dict:
    report: dict = {}
    cursor0 = await driver.cursor_position()
    front0 = await frontmost_app()
    report["cursor_before"], report["front_before"] = cursor0, front0

    target = await desk.ensure("about:blank")
    report["chrome_pid"], report["window_id"] = target.pid, target.window_id
    await asyncio.sleep(1.0)

    ws = await desk.observe(include_tree=True, max_elements=400)
    await open_url(driver, ws, "https://www.google.com")
    box = None
    for _ in range(20):
        await asyncio.sleep(0.5)
        ws = await desk.observe(include_tree=True, max_elements=800)
        box = find_by(ws, ("combobox", "textarea", "searchfield", "textfield"), ("search",))
        if box and "address" not in str(box.get("label") or "").lower():
            break
        box = None
    if box:
        report["typed_into"] = f"[{box.get('element_index')}] {box.get('role')} {box.get('label')!r}"
        await driver.type_text(ws.pid, ws.window_id, QUERY, element_token=box["element_token"])
        await driver.press_key(ws.pid, ws.window_id, "return", element_token=box["element_token"])
    else:
        # Google's box not in the tree: search through the omnibox instead.
        report["typed_into"] = "omnibox (fallback)"
        await open_url(driver, ws, QUERY)

    title = ""
    for _ in range(24):
        await asyncio.sleep(0.5)
        ws = await desk.observe(include_tree=False)
        title = ws.window_title or ""
        if "tennis" in title.lower():
            break
    report["window_title"] = title

    out_png.parent.mkdir(parents=True, exist_ok=True)
    shot = await desk.observe(include_tree=False, max_image_dimension=0, screenshot_path=out_png)
    data = out_png.read_bytes() if out_png.exists() else (shot.png or b"")
    if not out_png.exists() and data:
        out_png.write_bytes(data)
    w, h = png_size(data)
    wins = await driver.list_windows(target.pid)
    win = next((x for x in wins if int(x.get("window_id", -1)) == shot.window_id), None)
    b = (win or {}).get("bounds") or shot.window_bounds or {}
    bw, bh = float(b.get("width") or 0), float(b.get("height") or 0)
    screen = await driver.call("get_screen_size", {})
    report.update({"png": str(out_png), "png_size": [w, h], "window_bounds": b, "screen": screen})

    def close(a: float, c: float) -> bool:
        return abs(a - c) <= 3

    a_ok = any(close(w, bw * s) and close(h, bh * s) for s in (1.0, 2.0)) and bw > 0
    sw = float(screen.get("width") or 0)
    sh = float(screen.get("height") or 0)
    is_display = any(close(w, sw * s) and close(h, sh * s) for s in (1.0, 2.0)) and sw > 0
    report["check_a_window_sized"] = bool(a_ok and not is_display)

    cursor1 = await driver.cursor_position()
    front1 = await frontmost_app()
    report["cursor_after"], report["front_after"] = cursor1, front1
    report["check_b_cursor_unchanged"] = cursor0 == cursor1 and cursor0 is not None
    report["check_c_front_unchanged"] = front0 == front1 and front0 is not None
    report["results_page"] = "tennis" in title.lower()
    return report


async def scripted_browser(desk: BrowserDesk, driver: CuaDriver, out_png: Path) -> dict:
    """Browser desk gate: DuckDuckGo, type the query, click Search (DOM event),
    results page, tab-viewport screenshot, no cursor or focus change."""
    report: dict = {}
    cursor0 = await driver.cursor_position()
    front0 = await frontmost_bundle_id()
    report["cursor_before"], report["front_before"] = cursor0, front0

    t = await desk.ensure("https://duckduckgo.com/")
    report["browser_pid"], report["window_id"] = t.pid, t.window_id
    report["launch_restored_focus_to"] = desk.restored_focus_to
    cursor0b = await driver.cursor_position()  # after any one-time launch
    front0b = await frontmost_bundle_id()

    box = None
    for _ in range(20):
        await asyncio.sleep(0.5)
        ws = await desk.observe()
        box = next((e for e in ws.elements if e["role"] in ("combobox", "searchbox", "textbox")), None)
        if box:
            break
    if not box:
        report["error"] = "search box not found"
        return report
    await desk.type(box["element_token"], QUERY, replace=True)
    # The submit button only appears once the box holds text.
    btn = None
    for _ in range(10):
        await asyncio.sleep(0.4)
        ws = await desk.observe()
        btn = next((e for e in ws.elements if e["role"] == "button" and str(e["label"]).lower() == "search"), None)
        if btn:
            break
    if not btn:
        report["error"] = "submit button not found after typing; buttons: " + ", ".join(
            repr(e["label"]) for e in ws.elements if e["role"] == "button")[:400]
        return report
    await desk.click(btn["element_token"])
    report["typed_into"] = f"{box['role']} {box['label']!r}, clicked {btn['label']!r} (dom event)"

    title = ""
    for _ in range(24):
        await asyncio.sleep(0.5)
        ws = await desk.observe(include_tree=False, max_image_dimension=0)
        title = ws.window_title or ""
        if "tennis" in title.lower():
            break
    report["tab_title"], report["url"] = title, ws.raw.get("url")
    out_png.parent.mkdir(parents=True, exist_ok=True)
    out_png.write_bytes(ws.png or b"")
    w, h = png_size(ws.png or b"")
    screen = await driver.call("get_screen_size", {})
    sw, sh = float(screen.get("width") or 0), float(screen.get("height") or 0)
    is_display = any(abs(w - sw * s) <= 3 and abs(h - sh * s) <= 3 for s in (1.0, 2.0))
    report.update({"png": str(out_png), "png_size": [w, h], "screen": screen})
    report["check_a_tab_sized"] = bool(w and h and not is_display)
    cursor1 = await driver.cursor_position()
    front1 = await frontmost_bundle_id()
    report["cursor_after"], report["front_after"] = cursor1, front1
    report["check_b_cursor_unchanged"] = cursor0b == cursor1 and cursor1 is not None
    report["check_c_front_unchanged"] = front0b == front1 and front1 is not None
    report["check_c_front_same_as_start"] = front0 == front1
    report["results_page"] = "tennis" in title.lower()
    return report


async def live_step1(desk: AgentDesk | BrowserDesk, driver: CuaDriver) -> dict:
    log = appdev_root() / "LIVE_RUNS.log"
    used = len(log.read_text().splitlines()) if log.exists() else 0
    if used >= 3:
        return {"skipped": f"LIVE_RUNS.log already has {used} lines"}
    load_env()
    events: list[tuple[str, dict]] = []

    async def emit(kind: str, payload: dict) -> None:
        if kind in INTERNAL_KINDS:
            return
        events.append((kind, payload))
        print(f"  [{kind}] {json.dumps(payload)[:220]}", flush=True)

    kind = getattr(desk, "kind", "window")
    cfg = ExecConfig(mode="live", max_actions_per_run=25, max_actions_per_step=10,
                     desk="browser" if kind == "browser" else "window",
                     start_url="about:blank" if kind == "browser" else "https://www.google.com")
    try:
        result = await run_steps(TASK, [STEP1], frozenset({STEP1.id}), emit, asyncio.Event(), cfg,
                                 driver=driver, desk=desk)
    finally:
        n = sum(1 for k, _ in events if k == "action")
        with log.open("a") as f:
            f.write(f"{dt.datetime.now().isoformat(timespec='seconds')} worker-executor "
                    f"exec_smoke live step1 ({cfg.model}) {n}\n")
    return result


async def simulated() -> dict:
    async def emit(kind: str, payload: dict) -> None:
        if kind in INTERNAL_KINDS:
            return
        print(f"  [{kind}] {json.dumps(payload)[:200]}", flush=True)

    return await run_steps(TASK, [STEP1], frozenset({STEP1.id}), emit, asyncio.Event(),
                           ExecConfig(mode="simulated", sim_delay_s=0.1))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also run one live LLM pass of step 1")
    ap.add_argument("--simulated", action="store_true", help="only run the executor in simulated mode")
    ap.add_argument("--keep-open", action="store_true", help="leave the agent's Chrome running")
    ap.add_argument("--desk", choices=["browser", "window"], default="browser",
                    help="browser: cua-driver-owned Chrome over CDP (default); window: AX on our own Chrome")
    args = ap.parse_args()

    if args.simulated:
        print(json.dumps(await simulated(), indent=2))
        return 0

    driver = CuaDriver()
    ok, why = await driver.ready()
    if not ok:
        print(f"BLOCKED: cua-driver is not usable: {why}")
        print("Grant CuaDriver Accessibility + Screen Recording (System Settings > Privacy & Security),")
        print("or run `cua-driver permissions grant`, then re-run this script. See appdev/BLOCKERS.md.")
        return 2

    out_png = appdev_root() / ".agent-desk" / "smoke.png"
    if args.desk == "browser":
        desk: AgentDesk | BrowserDesk = BrowserDesk(driver)
        checks = ("check_a_tab_sized", "check_b_cursor_unchanged", "check_c_front_unchanged", "results_page")
    else:
        desk = AgentDesk(driver)
        checks = ("check_a_window_sized", "check_b_cursor_unchanged", "check_c_front_unchanged", "results_page")
    try:
        if isinstance(desk, BrowserDesk):
            report = await scripted_browser(desk, driver, out_png)
        else:
            report = await scripted(desk, driver, out_png)
        print(json.dumps(report, indent=2, default=str))
        passed = all(report.get(k) for k in checks)
        print(f"SCRIPTED GATE: {'PASS' if passed else 'FAIL'}")
        if args.live and passed:
            print("LIVE RUN (step 1):")
            print(json.dumps(await live_step1(desk, driver), indent=2))
        return 0 if passed else 1
    except CuaDriverError as e:
        print(f"cua-driver error: {e}")
        return 1
    finally:
        if not args.keep_open:
            await desk.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
