"""The agent's browser desk: a cua-driver-owned, isolated Chromium profile
driven through cua-driver's ``browser_*`` tools (CDP).

Why not the AX path on our own Chrome (``host_desk.AgentDesk``): macOS posts
background key events to Chrome as synthetic events, and Chromium ignores a
synthetic Return. The agent could type a search but never submit it. The only
input that does reach Chromium content is either foreground (a global keypress
that lands in whichever Chrome is frontmost, including the user's) or CDP.
cua-driver's CDP route works on a browser it launched itself, so this desk:

* launches (once) a separate Chrome with a driver-owned profile
  (``browser_prepare``, ``isolated_named``); it never attaches to a user
  profile, and the wrapper refuses any call that would;
* observes through ``get_browser_state`` (semantic refs + a PNG of the tab
  viewport only, never the screen);
* acts with ``browser_navigate``, ``browser_type`` (insert_text) and
  ``browser_click`` with ``input_route: dom_event``. None of these moves the
  cursor, raises a window, or sends a global key event.

Launching the browser is the one moment macOS activates a window, so the
desk records the frontmost app first and restores it afterwards.
"""

from __future__ import annotations

import asyncio
import base64
import io
import re
from dataclasses import dataclass
from typing import Any

from oversight.cua import CuaDriver, CuaDriverError, WindowState
from oversight.host_desk import pick_window

PROFILE_NAME = "oversight-agent"

#: Web roles the agent can act on. Everything else is context at most.
WEB_INTERACTIVE = frozenset({
    "link", "button", "combobox", "textbox", "searchbox", "checkbox", "radio", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "slider", "spinbutton",
    "listbox", "textarea",
})
WEB_CONTENT = frozenset({"heading"})
_PRICE = re.compile(r"[$€£]\s?\d")


async def _run(*argv: str) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    out, _ = await proc.communicate()
    return proc.returncode or 0, out.decode(errors="replace")


async def frontmost_bundle_id() -> str | None:
    """Bundle id of the frontmost app via ``lsappinfo`` (no AppleScript, so
    no Automation privacy prompt)."""
    code, asn = await _run("lsappinfo", "front")
    if code or not asn.strip():
        return None
    code, out = await _run("lsappinfo", "info", "-only", "bundleid", asn.strip())
    m = re.search(r'"CFBundleIdentifier"="([^"]+)"', out) or re.search(r'="([^"]+)"', out)
    return m.group(1) if m else None


async def restore_frontmost(bundle_id: str | None) -> None:
    """Give focus back to the app the user had in front before the launch."""
    if bundle_id and await frontmost_bundle_id() != bundle_id:
        await _run("open", "-b", bundle_id)


async def driver_browser_pid(profile_name: str = PROFILE_NAME) -> int | None:
    """Main process of the running driver-owned browser for this profile."""
    _, out = await _run("ps", "-axo", "pid=,command=")
    needle = f"CuaDriver/BrowserProfiles/{profile_name}"
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if needle in cmd and "--remote-debugging-port" in cmd and "--type=" not in cmd:
            return int(pid)
    return None


def _downscale(png: bytes, max_dim: int) -> tuple[bytes, int, int]:
    from PIL import Image

    img = Image.open(io.BytesIO(png))
    w, h = img.size
    if max_dim and max(w, h) > max_dim:
        s = max_dim / max(w, h)
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), img.size[0], img.size[1]
    return png, w, h


def web_elements(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Semantic refs -> the executor's element rows. ``element_index`` is a
    small int for the model; ``element_token`` keeps the cua-driver ref."""
    rows: list[dict[str, Any]] = []
    for r in refs:
        role = str(r.get("role") or "").lower()
        name = r.get("name") or ""
        value = r.get("value") or ""
        acts = r.get("actions") or []
        priced = bool(_PRICE.search(str(name)))
        if role in WEB_INTERACTIVE and ("click" in acts or "type" in acts):
            if not (name or value) and role not in ("textbox", "searchbox", "combobox", "textarea"):
                continue
        elif not ((role in WEB_CONTENT and name) or (role == "statictext" and priced)):
            continue
        rows.append({
            "element_index": len(rows), "role": role, "label": name, "value": value,
            "element_token": r.get("ref"), "actions": acts, "depth": 0,
            "visibility": r.get("visibility"),
        })
    return rows


def _navigation_in_flight(e: CuaDriverError) -> bool:
    text = f"{e.code or ''} {e}"
    return "browser_route_unavailable" in text and ("frameId" in text or "not found" in text) \
        or "Frame with the given frameId is not found" in text


@dataclass
class BrowserTarget:
    pid: int
    window_id: int
    target_id: str
    tab_id: str
    url: str = ""
    title: str = ""


class BrowserDesk:
    """Owns the driver-launched agent browser and turns it into observations."""

    kind = "browser"

    def __init__(self, driver: CuaDriver, *, profile_name: str = PROFILE_NAME,
                 max_image_dimension: int = 1280) -> None:
        self.driver = driver
        self.profile_name = profile_name
        self.max_image_dimension = max_image_dimension
        self.target: BrowserTarget | None = None
        self.restored_focus_to: str | None = None
        #: Waits (s) before re-binding and retrying a snapshot that hit a page mid-navigation.
        self.retry_delays: tuple[float, ...] = (0.5, 1.0, 2.0)

    async def _launch(self) -> int:
        pid = await driver_browser_pid(self.profile_name)
        if pid:
            return pid
        front = await frontmost_bundle_id()
        r = await self.driver.browser_prepare_isolated(self.profile_name)
        pid = r.get("prepared_pid")
        if not isinstance(pid, int):
            raise RuntimeError(f"cua-driver did not launch the agent browser: {r}")
        await asyncio.sleep(1.0)
        await restore_frontmost(front)
        self.restored_focus_to = front
        return pid

    async def bind(self) -> BrowserTarget:
        pid = self.target.pid if self.target else await self._launch()
        win = None
        for _ in range(40):
            win = pick_window(await self.driver.list_windows(pid))
            if win:
                break
            await asyncio.sleep(0.25)
        if not win:
            raise RuntimeError(f"agent browser (pid {pid}) has no window")
        st = await self.driver.browser_state(pid=pid, window_id=int(win["window_id"]))
        tabs = st.get("tabs") or []
        if not tabs or not st.get("target_id"):
            raise RuntimeError(f"agent browser (pid {pid}) has no bindable tab: {st}")
        tab = next((t for t in tabs if t.get("active")), tabs[0])
        self.target = BrowserTarget(pid=pid, window_id=int(win["window_id"]), target_id=st["target_id"],
                                    tab_id=tab["tab_id"], url=tab.get("url") or "",
                                    title=tab.get("title") or "")
        return self.target

    async def ensure(self, url: str | None = None) -> BrowserTarget:
        t = await self.bind()
        if url:
            await self.navigate(url)
            t = await self.bind()
        return t

    async def observe(self, *, include_tree: bool = True, max_elements: int | None = None,
                      max_image_dimension: int | None = None, **_: Any) -> WindowState:
        t, r = await self._snapshot()
        png = None
        w = h = None
        b64 = r.get("screenshot_png_b64")
        if b64:
            png, w, h = _downscale(base64.b64decode(b64),
                                   self.max_image_dimension if max_image_dimension is None else max_image_dimension)
        page = r.get("page") or {}
        elements = web_elements(r.get("refs") or []) if include_tree else []
        if max_elements:
            elements = elements[:max_elements]
        t.url = page.get("url") or t.url
        t.title = page.get("title") or t.title
        return WindowState(
            pid=t.pid, window_id=t.window_id, elements=elements, png=png,
            screenshot_width=w, screenshot_height=h, window_title=t.title,
            degraded_reason=None if elements else "no actionable page elements",
            raw={"url": t.url, "target_id": t.target_id, "tab_id": t.tab_id},
        )

    async def _snapshot(self) -> tuple[BrowserTarget, dict[str, Any]]:
        """Bind and snapshot the active tab. A click or open_url can leave the page
        mid-navigation, and then CDP refuses the snapshot because the old frame is
        gone ("Frame with the given frameId is not found"). That is transient:
        wait, re-bind (the tab may have new ids), and retry a few times."""
        for delay in (*self.retry_delays, None):
            t = await self.bind()
            try:
                return t, await self.driver.browser_state(target_id=t.target_id, tab_id=t.tab_id,
                                                          semantic=True, include_screenshot=True)
            except CuaDriverError as e:
                if delay is None or not _navigation_in_flight(e):
                    raise
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def navigate(self, url: str) -> dict[str, Any]:
        t = self.target or await self.bind()
        return await self.driver.browser_navigate(t.target_id, t.tab_id, url)

    async def click(self, ref: str) -> dict[str, Any]:
        t = self.target or await self.bind()
        return await self.driver.browser_click(t.target_id, t.tab_id, ref)

    async def type(self, ref: str, text: str, *, replace: bool) -> dict[str, Any]:
        t = self.target or await self.bind()
        return await self.driver.browser_type(t.target_id, t.tab_id, ref, text, replace=replace)

    async def close(self) -> None:
        """Quit the driver-owned agent browser (never the user's)."""
        pid = await driver_browser_pid(self.profile_name)
        if pid:
            await _run("kill", str(pid))
        self.target = None


__all__ = ["BrowserDesk", "BrowserTarget", "CuaDriverError", "web_elements", "driver_browser_pid"]
