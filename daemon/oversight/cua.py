"""Thin async wrapper over trycua's ``cua-driver`` CLI.

This module does not implement any input or capture itself. Every action goes
through ``cua-driver call <tool> <json>``, which talks to the long-running
``cua-driver serve`` daemon (``/Applications/CuaDriver.app``) that owns the
macOS Accessibility and Screen Recording grants. The daemon delivers input in
the background: no cursor movement and no focus steal, as long as we never ask
for ``delivery_mode: "foreground"`` (and we never do).

Two product rules are enforced here, structurally, rather than by convention:

* **Window-scoped capture only.** ``get_desktop_state`` (a full-display grab)
  and any ``scope: "desktop"`` argument are refused unless the wrapper was
  built with ``allow_full_screen=True``. The only caller allowed to do that is
  an explicit experimental condition (see ``executor.ExecConfig``).
* **Background only.** ``delivery_mode: "foreground"`` and the
  ``bring_to_front`` tool are refused.

Element tokens from ``get_window_state`` live in the daemon's per-session
snapshot cache. One-shot ``call`` processes would each get a fresh implicit
session, so every call carries the same explicit ``session`` label.

Interface learned from cua-driver 0.32.0 (``cua-driver list-tools`` and
``cua-driver describe <tool>``).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Tools that read the full display. Refused unless full-screen capture was
#: explicitly allowed for an experimental condition.
FULL_SCREEN_TOOLS = frozenset({"get_desktop_state"})
#: Tools that raise a window or steal focus. Always refused.
FOREGROUND_TOOLS = frozenset({"bring_to_front"})
#: Browser tools the agent never needs: files, downloads, the clipboard, page
#: dialogs and the legacy catch-all. Always refused.
BROWSER_DENIED = frozenset({"browser_download", "browser_set_input_files", "browser_dialog",
                            "clipboard_write", "page"})
#: Browser tools that must use the in-page ``dom_event`` route. The trusted CDP
#: Input route activates Chromium's window on macOS.
BROWSER_DOM_ONLY = frozenset({"browser_click", "browser_pointer"})

#: Tools whose schema accepts the ``session`` label.
_NO_SESSION_TOOLS = frozenset({"check_permissions", "check_for_update", "get_config", "set_config"})

PERMISSIONS_EXIT = 75


class CuaDriverError(RuntimeError):
    """A cua-driver call failed. ``code`` is the driver's error slug when one
    was printed (``permissions_pending``, ``window_id_not_found``, ...)."""

    def __init__(self, tool: str, message: str, code: str | None = None, exit_code: int | None = None):
        super().__init__(f"{tool}: {message}")
        self.tool = tool
        self.code = code
        self.exit_code = exit_code
        self.message = message


class PermissionsPending(CuaDriverError):
    """macOS Accessibility or Screen Recording has not been granted to CuaDriver."""


class ForbiddenCall(CuaDriverError):
    """The wrapper refused a call that would break a product rule."""


def find_binary() -> str | None:
    env = os.environ.get("CUA_DRIVER_BIN")
    if env and Path(env).exists():
        return env
    found = shutil.which("cua-driver")
    if found:
        return found
    for cand in (
        Path.home() / ".local/bin/cua-driver",
        Path("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"),
    ):
        if cand.exists():
            return str(cand)
    return None


def _first_line_code(text: str) -> str | None:
    """``permissions_pending: macOS ...`` -> ``permissions_pending``."""
    head = text.strip().split(":", 1)[0].strip()
    if head and " " not in head and head.replace("_", "").isalnum() and head.islower():
        return head
    return None


def parse_call_output(tool: str, stdout: str, stderr: str, exit_code: int) -> dict[str, Any]:
    """Normalise ``cua-driver call`` output into one dict.

    Accepts an MCP ``CallToolResult``-shaped JSON (``content`` +
    ``structuredContent`` + ``isError``), a bare JSON object, or plain text.
    Raises ``CuaDriverError`` / ``PermissionsPending`` on failure.
    """
    out = (stdout or "").strip()
    err = (stderr or "").strip()
    text_for_code = out or err
    code = _first_line_code(text_for_code) if text_for_code else None

    if code == "permissions_pending" or exit_code == PERMISSIONS_EXIT:
        raise PermissionsPending(tool, text_for_code or "permissions pending", "permissions_pending", exit_code)

    data: Any = None
    if out:
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            data = None

    if isinstance(data, dict):
        is_error = bool(data.get("isError") or data.get("is_error"))
        merged: dict[str, Any] = {}
        sc = data.get("structuredContent") or data.get("structured_content")
        if isinstance(sc, dict):
            merged.update(sc)
        for k, v in data.items():
            if k not in ("structuredContent", "structured_content"):
                merged.setdefault(k, v)
        texts = [
            c.get("text", "")
            for c in (data.get("content") or [])
            if isinstance(c, dict) and c.get("type") == "text"
        ]
        if texts:
            merged.setdefault("text", "\n".join(texts))
        images = [
            c for c in (data.get("content") or []) if isinstance(c, dict) and c.get("type") == "image"
        ]
        if images:
            merged.setdefault("_images", images)
        if is_error or exit_code != 0:
            msg = merged.get("error") or merged.get("text") or out
            if isinstance(msg, dict):
                msg = json.dumps(msg)
            raise CuaDriverError(tool, str(msg), merged.get("code") or _first_line_code(str(msg)), exit_code)
        if merged.get("effect") == "refused" or merged.get("status") == "refused":
            e = merged.get("error")
            ecode = e.get("code") if isinstance(e, dict) else None
            raise CuaDriverError(tool, json.dumps(e) if isinstance(e, dict) else str(e or out),
                                 ecode or "refused", exit_code)
        return merged

    if exit_code != 0:
        raise CuaDriverError(tool, text_for_code or f"exit {exit_code}", code, exit_code)
    if code and code.endswith(("_pending", "_not_found", "_error", "_denied", "_refused")):
        raise CuaDriverError(tool, out, code, exit_code)
    return {"text": out}


@dataclass
class WindowState:
    """One ``get_window_state`` result, trimmed to what the executor uses."""

    pid: int
    window_id: int
    elements: list[dict[str, Any]] = field(default_factory=list)
    tree_markdown: str = ""
    png: bytes | None = None
    screenshot_width: int | None = None
    screenshot_height: int | None = None
    screenshot_scale: float | None = None
    window_bounds: dict[str, Any] | None = None
    window_title: str | None = None
    degraded_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def token_for(self, element_index: int) -> str | None:
        for el in self.elements:
            if el.get("element_index") == element_index:
                return el.get("element_token")
        return None

    def element(self, element_index: int) -> dict[str, Any] | None:
        for el in self.elements:
            if el.get("element_index") == element_index:
                return el
        return None


class CuaDriver:
    """Async facade over ``cua-driver call``.

    ``runner`` is injectable for tests: ``async (argv) -> (exit, stdout, stderr)``.
    """

    def __init__(
        self,
        binary: str | None = None,
        session: str = "oversight-agent",
        timeout_s: float = 45.0,
        allow_full_screen: bool = False,
        shot_dir: str | Path | None = None,
        runner: Any = None,
    ) -> None:
        self.binary = binary or find_binary() or "cua-driver"
        self.session = session
        self.timeout_s = timeout_s
        self.allow_full_screen = allow_full_screen
        self.shot_dir = Path(shot_dir) if shot_dir else Path(tempfile.gettempdir()) / "oversight-shots"
        self._runner = runner or self._subprocess
        self.calls: list[tuple[str, dict[str, Any]]] = []

    # -- transport ---------------------------------------------------------
    async def _subprocess(self, argv: list[str]) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=self.timeout_s)
        except TimeoutError as e:
            proc.kill()
            await proc.wait()
            raise CuaDriverError(argv[2] if len(argv) > 2 else "?", f"timed out after {self.timeout_s}s",
                                 "timeout") from e
        return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")

    def _guard(self, tool: str, args: dict[str, Any]) -> None:
        if tool in FOREGROUND_TOOLS or args.get("delivery_mode") == "foreground":
            raise ForbiddenCall(tool, "foreground delivery is disabled: the agent never steals focus", "forbidden")
        if not self.allow_full_screen:
            if tool in FULL_SCREEN_TOOLS:
                raise ForbiddenCall(tool, "full-screen capture is disabled (window-scoped only)", "forbidden")
            if args.get("scope") == "desktop":
                raise ForbiddenCall(tool, "desktop scope is disabled (window-scoped only)", "forbidden")
            tgt = args.get("target")
            if isinstance(tgt, dict) and tgt.get("kind") == "desktop":
                raise ForbiddenCall(tool, "desktop target is disabled (window-scoped only)", "forbidden")
        if tool in BROWSER_DENIED:
            raise ForbiddenCall(tool, "not available to the agent (files, downloads, clipboard, dialogs)",
                                "forbidden")
        if tool == "browser_prepare":
            mode = (args.get("profile") or {}).get("mode")
            if args.get("strategy") or not args.get("allow_launch") or mode not in ("isolated_new",
                                                                                     "isolated_named"):
                raise ForbiddenCall(tool, "only a driver-owned isolated profile; never a user browser profile",
                                    "forbidden")
        if tool in BROWSER_DOM_ONLY and args.get("input_route") != "dom_event":
            raise ForbiddenCall(tool, "browser input must use input_route=dom_event (trusted input "
                                "activates the browser window)", "forbidden")
        if tool == "browser_type" and args.get("mode", "insert_text") != "insert_text":
            raise ForbiddenCall(tool, "browser typing uses insert_text only", "forbidden")

    async def call(self, tool: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        args = dict(args or {})
        self._guard(tool, args)
        if self.session and tool not in _NO_SESSION_TOOLS:
            args.setdefault("session", self.session)
        self.calls.append((tool, args))
        argv = [self.binary, "call", tool, json.dumps(args)]
        code, out, err = await self._runner(argv)
        try:
            return parse_call_output(tool, out, err, code)
        except CuaDriverError as e:
            # cua-driver can end a named session (idle, restart, cleanup) and then
            # rejects every call with that label; ordinary calls never revive it.
            # Revive it with start_session once and retry this call once.
            if tool == "start_session" or "session has ended" not in str(e) or "session" not in args:
                raise
            await self._runner([self.binary, "call", "start_session",
                                json.dumps({"session": args["session"]})])
            code, out, err = await self._runner(argv)
            return parse_call_output(tool, out, err, code)

    # -- status ------------------------------------------------------------
    async def daemon_running(self) -> bool:
        try:
            code, out, _ = await self._runner([self.binary, "status"])
        except (FileNotFoundError, CuaDriverError):
            return False
        return code == 0 and "is running" in out and "not running" not in out

    async def permissions(self) -> dict[str, Any]:
        """``{"status": "granted"|"unknown"|..., ...}`` from ``permissions status --json``."""
        try:
            code, out, err = await self._runner([self.binary, "permissions", "status", "--json"])
        except FileNotFoundError:
            return {"status": "missing", "reason": "cua-driver not installed"}
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return {"status": "unknown", "reason": (out or err).strip()}

    async def ready(self) -> tuple[bool, str]:
        """True when the daemon answers a harmless call (permissions granted)."""
        if not await self.daemon_running():
            return False, "cua-driver daemon not running (start: open -n -g -a CuaDriver --args serve)"
        try:
            await self.call("get_cursor_position", {})
        except PermissionsPending as e:
            return False, e.message
        except CuaDriverError as e:
            return False, str(e)
        return True, "ok"

    # -- tools -------------------------------------------------------------
    async def cursor_position(self) -> tuple[float, float] | None:
        r = await self.call("get_cursor_position", {})
        for kx, ky in (("x", "y"),):
            if kx in r and ky in r:
                return float(r[kx]), float(r[ky])
        pos = r.get("position") or r.get("cursor")
        if isinstance(pos, dict) and "x" in pos:
            return float(pos["x"]), float(pos["y"])
        return None

    async def list_windows(self, pid: int | None = None) -> list[dict[str, Any]]:
        args: dict[str, Any] = {}
        if pid is not None:
            args["pid"] = pid
        r = await self.call("list_windows", args)
        wins = r.get("windows")
        return wins if isinstance(wins, list) else []

    async def launch_app(self, **kwargs: Any) -> dict[str, Any]:
        return await self.call("launch_app", kwargs)

    async def window_state(
        self,
        pid: int,
        window_id: int,
        *,
        include_tree: bool = True,
        include_screenshot: bool = True,
        max_elements: int | None = None,
        max_image_dimension: int | None = None,
        query: str | None = None,
        timeout_ms: int | None = None,
        screenshot_path: str | Path | None = None,
    ) -> WindowState:
        """Window-scoped snapshot: AX tree and/or a screenshot of this window only."""
        args: dict[str, Any] = {"pid": pid, "window_id": window_id}
        if not include_tree:
            args["include_accessibility_tree"] = False
        if not include_screenshot:
            args["include_screenshot"] = False
        if max_elements:
            args["max_elements"] = max_elements
        if max_image_dimension is not None:
            args["max_image_dimension"] = max_image_dimension
        if query:
            args["query"] = query
        if timeout_ms:
            args["timeout_ms"] = timeout_ms
        shot_file: Path | None = None
        if include_screenshot:
            if screenshot_path:
                shot_file = Path(screenshot_path)
            else:
                self.shot_dir.mkdir(parents=True, exist_ok=True)
                fd, name = tempfile.mkstemp(prefix=f"w{window_id}-", suffix=".png", dir=self.shot_dir)
                os.close(fd)
                shot_file = Path(name)
            shot_file.parent.mkdir(parents=True, exist_ok=True)
            args["screenshot_out_file"] = str(shot_file)
        r = await self.call("get_window_state", args)
        png: bytes | None = None
        if shot_file is not None:
            p = Path(r.get("screenshot_file_path") or shot_file)
            if p.exists() and p.stat().st_size > 0:
                png = p.read_bytes()
            if not screenshot_path:
                for q in {p, shot_file}:
                    try:
                        q.unlink()
                    except OSError:
                        pass
        if png is None and r.get("_images"):
            import base64

            png = base64.b64decode(r["_images"][0].get("data", ""))
        return WindowState(
            pid=pid,
            window_id=window_id,
            elements=list(r.get("elements") or []),
            tree_markdown=str(r.get("tree_markdown") or ""),
            png=png,
            screenshot_width=_int(r.get("screenshot_width")),
            screenshot_height=_int(r.get("screenshot_height")),
            screenshot_scale=_float(r.get("screenshot_scale")),
            window_bounds=r.get("window_bounds"),
            window_title=r.get("window_title"),
            degraded_reason=r.get("degraded_reason"),
            raw={k: v for k, v in r.items() if k not in ("elements", "tree_markdown", "_images")},
        )

    async def click(
        self,
        pid: int,
        window_id: int,
        *,
        element_token: str | None = None,
        x: float | None = None,
        y: float | None = None,
        count: int | None = None,
        button: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"pid": pid}
        if element_token:
            args["element_token"] = element_token
        else:
            args.update({"window_id": window_id, "x": x, "y": y})
            if count:
                args["count"] = count
        if button and button != "left":
            args["button"] = button
        return await self.call("click", args)

    async def type_text(
        self,
        pid: int,
        window_id: int,
        text: str,
        *,
        element_token: str | None = None,
        x: float | None = None,
        y: float | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"pid": pid, "text": text}
        if element_token:
            args["element_token"] = element_token
        else:
            args["window_id"] = window_id
            if x is not None and y is not None:
                args.update({"x": x, "y": y})
        return await self.call("type_text", args)

    async def set_value(self, pid: int, element_token: str, value: str) -> dict[str, Any]:
        return await self.call("set_value", {"pid": pid, "element_token": element_token, "value": value})

    async def press_key(
        self,
        pid: int,
        window_id: int,
        key: str,
        *,
        modifiers: list[str] | None = None,
        element_token: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"pid": pid, "key": key}
        if element_token:
            args["element_token"] = element_token
        else:
            args["window_id"] = window_id
        if modifiers:
            args["modifiers"] = modifiers
        return await self.call("press_key", args)

    async def hotkey(
        self, pid: int, window_id: int, keys: list[str], *, element_token: str | None = None
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"pid": pid, "keys": keys}
        if element_token:
            args["element_token"] = element_token
        else:
            args["window_id"] = window_id
        return await self.call("hotkey", args)

    async def scroll(
        self,
        pid: int,
        window_id: int,
        direction: str,
        *,
        amount: int = 3,
        element_token: str | None = None,
        x: float | None = None,
        y: float | None = None,
        by: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"pid": pid, "direction": direction, "amount": max(1, min(50, int(amount)))}
        if element_token:
            args["element_token"] = element_token
        elif x is not None and y is not None:
            args.update({"window_id": window_id, "x": x, "y": y})
        if by:
            args["by"] = by
        return await self.call("scroll", args)


    # -- driver-owned browser (CDP) -----------------------------------------
    async def browser_prepare_isolated(self, profile_name: str) -> dict[str, Any]:
        """Launch a driver-owned Chromium with an isolated named profile."""
        return await self.call("browser_prepare", {
            "allow_launch": True, "profile": {"mode": "isolated_named", "name": profile_name},
        })

    async def browser_state(
        self,
        *,
        pid: int | None = None,
        window_id: int | None = None,
        target_id: str | None = None,
        tab_id: str | None = None,
        semantic: bool = False,
        include_screenshot: bool = False,
    ) -> dict[str, Any]:
        """Bind mode with pid + window_id (returns target_id and tabs), or a
        snapshot of one tab with target_id + tab_id (refs, optional PNG of the
        tab viewport only)."""
        args: dict[str, Any] = {}
        if target_id and tab_id:
            args.update({"target_id": target_id, "tab_id": tab_id})
            if semantic:
                args["snapshot_format"] = "semantic_v2"
            if include_screenshot:
                args["include_screenshot"] = True
        else:
            args.update({"pid": pid, "window_id": window_id})
        return await self.call("get_browser_state", args)

    async def browser_navigate(self, target_id: str, tab_id: str, url: str) -> dict[str, Any]:
        return await self.call("browser_navigate", {"target_id": target_id, "tab_id": tab_id, "url": url})

    async def browser_click(self, target_id: str, tab_id: str, ref: str) -> dict[str, Any]:
        return await self.call("browser_click", {"target_id": target_id, "tab_id": tab_id, "ref": ref,
                                                 "input_route": "dom_event"})

    async def browser_type(self, target_id: str, tab_id: str, ref: str, text: str, *,
                           replace: bool = False) -> dict[str, Any]:
        return await self.call("browser_type", {"target_id": target_id, "tab_id": tab_id, "ref": ref,
                                                "text": text, "replace": replace})


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None
