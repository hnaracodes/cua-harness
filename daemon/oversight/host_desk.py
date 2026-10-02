"""The agent's own desk on the user's machine (docs/05 "Layer 1").

* The agent gets its own Chrome instance with its own profile
  (``--user-data-dir=<appdev>/.agent-desk/chrome-profile``), launched in the
  background, so it never sees the user's tabs or logged-in sessions.
* The desk tracks that Chrome by pid and window id. Every observation is a
  window-scoped ``get_window_state`` of that one window.

``HostDeskEnvironment`` adapts the desk to Peripheral's
``peripheral.vm.base.Environment`` so ``testing/`` can run the harness as a
condition. It is imported lazily and only when ``testing/`` is importable; the
executor never depends on it.
"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from oversight.cua import CuaDriver, CuaDriverError, WindowState

CHROME_APP = "/Applications/Google Chrome.app"
CHROME_BIN = f"{CHROME_APP}/Contents/MacOS/Google Chrome"
CHROME_BUNDLE_ID = "com.google.Chrome"


def appdev_root() -> Path:
    """``appdev/``, also when running from ``appdev/.worktrees/<name>``."""
    env = os.environ.get("OVERSIGHT_APPDEV_ROOT")
    if env:
        return Path(env)
    root = Path(__file__).resolve().parents[2]
    if root.parent.name == ".worktrees":
        root = root.parent.parent
    return root


def default_profile_dir() -> str:
    return str(appdev_root() / ".agent-desk" / "chrome-profile")


async def _run(*argv: str, timeout: float = 15.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", "timeout"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


async def frontmost_app() -> str | None:
    """Name of the frontmost app, via ``lsappinfo`` (no TCC grant needed)."""
    code, asn, _ = await _run("lsappinfo", "front")
    if code != 0 or not asn.strip():
        return None
    code, out, _ = await _run("lsappinfo", "info", "-only", "name", asn.strip())
    m = re.search(r'"(?:LSDisplayName|name)"\s*=\s*"([^"]*)"', out)
    return m.group(1) if m else (out.strip() or None)


async def chrome_pids_for_profile(profile_dir: str | None) -> list[int]:
    """Main (browser) Chrome pids. ``profile_dir=None`` means the user's own
    Chrome, i.e. a main process launched without ``--user-data-dir``."""
    code, out, _ = await _run("ps", "-axo", "pid=,command=")
    if code != 0:
        return []
    pids: list[int] = []
    for line in out.splitlines():
        line = line.strip()
        if not line or CHROME_BIN not in line or "--type=" in line:
            continue
        pid_s, _, cmd = line.partition(" ")
        has_profile = "--user-data-dir=" in cmd
        if profile_dir is None:
            if has_profile:
                continue
        elif f"--user-data-dir={profile_dir}" not in cmd:
            continue
        try:
            pids.append(int(pid_s))
        except ValueError:
            pass
    return pids


def pick_window(windows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the browser window among a Chrome process's windows.

    Chrome also owns off-screen, untitled helper surfaces (500x500, 1118x139,
    1728x33, 1x1) that can sit above the real window in z-order. Picking one
    makes captures blank and input fail with ``off_space_or_ax_unresolved``.
    A browser window is real-sized, on layer 0, and either on screen or
    titled; on-screen windows win, then the frontmost z_index."""
    real = []
    for w in windows:
        b = w.get("bounds") or {}
        if (b.get("width") or 0) < 300 or (b.get("height") or 0) < 200:
            continue
        if w.get("layer") not in (None, 0):
            continue
        if w.get("is_on_screen") is not True and not (w.get("title") or "").strip():
            continue
        real.append(w)
    if not real:
        return None
    return max(real, key=lambda w: (
        w.get("is_on_screen") is True,
        w["z_index"] if isinstance(w.get("z_index"), int) else -1,
        w["bounds"]["width"] * w["bounds"]["height"],
    ))


@dataclass
class DeskTarget:
    pid: int
    window_id: int
    bounds: dict[str, Any] | None = None


class AgentDesk:
    """Owns the agent's Chrome and turns it into window-scoped observations."""

    def __init__(
        self,
        driver: CuaDriver,
        *,
        own_browser_profile: bool = True,
        profile_dir: str | None = None,
        window_size: tuple[int, int] = (1280, 860),
    ) -> None:
        self.driver = driver
        self.own_browser_profile = own_browser_profile
        self.profile_dir = profile_dir or default_profile_dir()
        self.window_size = window_size
        self.target: DeskTarget | None = None

    def chrome_args(self) -> list[str]:
        args = ["--no-first-run", "--no-default-browser-check"]
        if self.own_browser_profile:
            args.insert(0, f"--user-data-dir={self.profile_dir}")
            w, h = self.window_size
            args += [f"--window-size={w},{h}", "--window-position=80,60"]
        return args

    async def _find_pid(self) -> int | None:
        pids = await chrome_pids_for_profile(self.profile_dir if self.own_browser_profile else None)
        return pids[0] if pids else None

    async def launch_chrome(self, url: str | None = None) -> int:
        """Start (or reuse) the agent's Chrome in the background. Returns the pid."""
        pid = await self._find_pid()
        if pid:
            return pid
        if self.own_browser_profile:
            Path(self.profile_dir).mkdir(parents=True, exist_ok=True)
        urls = [url] if url else []
        try:
            r = await self.driver.launch_app(
                bundle_id=CHROME_BUNDLE_ID,
                creates_new_application_instance=self.own_browser_profile,
                additional_arguments=self.chrome_args(),
                urls=urls,
            )
            if isinstance(r.get("pid"), int) and await self._pid_matches(r["pid"]):
                return r["pid"]
        except CuaDriverError:
            pass
        # Fallback: LaunchServices in the background (-g), new instance (-n).
        argv = ["open", "-g"]
        if self.own_browser_profile:
            argv.append("-n")
        argv += ["-a", CHROME_APP]
        if urls:
            argv += urls
        argv += ["--args", *self.chrome_args()]
        await _run(*argv)
        for _ in range(60):
            pid = await self._find_pid()
            if pid:
                return pid
            await asyncio.sleep(0.25)
        raise RuntimeError("agent Chrome did not start")

    async def launch(self, url: str | None = None) -> int:
        """Start (or reuse) this desk's app. Returns the pid."""
        return await self.launch_chrome(url)

    async def _pid_matches(self, pid: int) -> bool:
        return pid in await chrome_pids_for_profile(self.profile_dir if self.own_browser_profile else None)

    async def ensure(self, url: str | None = None) -> DeskTarget:
        pid = await self.launch(url)
        win = None
        for _ in range(40):
            win = pick_window(await self.driver.list_windows(pid))
            if win:
                break
            await asyncio.sleep(0.25)
        if not win:
            raise RuntimeError(f"agent Chrome (pid {pid}) has no window")
        self.target = DeskTarget(pid=pid, window_id=int(win["window_id"]), bounds=win.get("bounds"))
        return self.target

    async def refresh_window(self) -> DeskTarget:
        assert self.target is not None
        win = pick_window(await self.driver.list_windows(self.target.pid))
        if not win:
            raise RuntimeError("agent Chrome window disappeared")
        self.target = DeskTarget(pid=self.target.pid, window_id=int(win["window_id"]), bounds=win.get("bounds"))
        return self.target

    async def observe(
        self,
        *,
        include_tree: bool = True,
        max_elements: int | None = None,
        max_image_dimension: int | None = None,
        screenshot_path: str | Path | None = None,
    ) -> WindowState:
        if self.target is None:
            await self.ensure()
        assert self.target is not None
        for attempt in range(2):
            try:
                return await self.driver.window_state(
                    self.target.pid,
                    self.target.window_id,
                    include_tree=include_tree,
                    include_screenshot=True,
                    max_elements=max_elements,
                    max_image_dimension=max_image_dimension,
                    timeout_ms=4000 if include_tree else None,
                    screenshot_path=screenshot_path,
                )
            except CuaDriverError as e:
                if attempt == 0 and (e.code in ("window_id_not_found", "window_owner_pid_mismatch")):
                    await self.refresh_window()
                    continue
                raise
        raise RuntimeError("unreachable")

    async def close(self) -> None:
        """Quit the agent's Chrome (never the user's)."""
        if not self.own_browser_profile:
            return
        for pid in await chrome_pids_for_profile(self.profile_dir):
            await _run("kill", str(pid))


# ---------------------------------------------------------------------------
# Native app desks
# ---------------------------------------------------------------------------

#: Native apps a step can be routed to: (bundle id, display name).
MESSAGES_APP = ("com.apple.MobileSMS", "Messages")
NOTES_APP = ("com.apple.Notes", "Notes")

_MESSAGES_WORDS = re.compile(r"\b(imessages?|messages)\b")
_MESSAGING_WORDS = re.compile(r"\b(message|messages|text|recipients?|contacts?|send|chat)\b")
_NOTES_WORDS = re.compile(r"\b(apple notes|notes app|notes)\b")


def route_app(task_prompt: str, title: str, description: str) -> tuple[str, str] | None:
    """Which native app a step runs in, or None for the browser.

    A step goes to Messages when it names Messages/iMessage, or when it is a
    messaging step (message, recipient, send...) in a task that asked for
    iMessage. That covers "Draft a short party message to Amogh" in a task
    that said "via iMessages", which never names the app itself."""
    step = f"{title} {description}".lower()
    task = task_prompt.lower()
    if _MESSAGES_WORDS.search(step):
        return MESSAGES_APP
    if _MESSAGING_WORDS.search(step) and _MESSAGES_WORDS.search(task):
        return MESSAGES_APP
    if _NOTES_WORDS.search(step):
        return NOTES_APP
    return None


class AppDesk(AgentDesk):
    """One of the user's own native apps (Messages, Notes), driven in the
    background through cua-driver: launched with ``launch_app`` (never brought
    to the front), observed window-scoped (AX tree + window screenshot), acted
    on with AX actions and background input. The executor never quits it."""

    kind = "app"

    def __init__(self, driver: CuaDriver, bundle_id: str, app_name: str) -> None:
        super().__init__(driver, own_browser_profile=False)
        self.bundle_id = bundle_id
        self.app_name = app_name

    async def launch(self, url: str | None = None) -> int:
        r = await self.driver.launch_app(bundle_id=self.bundle_id)
        pid = r.get("pid")
        if isinstance(pid, int):
            return pid
        _, out, _ = await _run("pgrep", "-x", self.app_name)
        if out.strip():
            return int(out.split()[0])
        raise RuntimeError(f"{self.app_name} did not start")

    async def close(self) -> None:
        return  # the user's app: never quit it


# ---------------------------------------------------------------------------
# Peripheral adapter. Optional: only built when testing/ is importable.
# ---------------------------------------------------------------------------


def make_host_desk_environment(desk: AgentDesk) -> Any:
    """Build a ``HostDeskEnvironment`` (subclass of Peripheral's ``Environment``).

    Raises ``ImportError`` when ``testing/`` (package ``peripheral``) is not on
    ``sys.path``. Imported, never copied, per CLAUDE.md.
    """
    from oversight.executor import execute_pixel_action
    from peripheral.actions import Action, ActionResult  # noqa: F401
    from peripheral.vm.base import EnvCapabilities, Environment, EnvObservation

    class HostDeskEnvironment(Environment):
        """cua-driver on the user's own machine, agent desk, window-scoped capture."""

        name = "host-desk"

        def __init__(self, desk: AgentDesk) -> None:
            self.desk = desk
            self._last: WindowState | None = None

        async def boot(self) -> None:
            await self.desk.ensure()

        async def teardown(self) -> None:
            await self.desk.close()

        def capabilities(self) -> EnvCapabilities:
            return EnvCapabilities(
                name=self.name,
                real_network=True,
                notes="Real host. Window-scoped capture of the agent's own Chrome. Not disposable.",
            )

        def is_disposable(self) -> bool:
            # The user's real machine. Never True.
            return False

        async def has_snapshot(self, name: str) -> bool:
            return False

        async def snapshot(self, name: str) -> str:
            raise NotImplementedError("the host desk has no snapshots")

        async def restore(self, name: str) -> None:
            raise NotImplementedError("the host desk has no snapshots")

        async def delete_snapshot(self, name: str) -> None:
            raise NotImplementedError("the host desk has no snapshots")

        async def observe(self) -> EnvObservation:
            ws = await self.desk.observe(include_tree=False, max_image_dimension=1280)
            self._last = ws
            png = ws.png or b""
            return EnvObservation(
                png=png,
                width=ws.screenshot_width or 0,
                height=ws.screenshot_height or 0,
                meta={"window_id": ws.window_id, "pid": ws.pid, "window_title": ws.window_title,
                      "scope": "window"},
            )

        async def execute(self, action: Action) -> ActionResult:
            t = self.desk.target
            if t is None:
                t = await self.desk.ensure()
            ok, detail, error = await execute_pixel_action(
                self.desk.driver, t.pid, t.window_id, action.kind,
                {"coordinate": list(action.coordinate) if action.coordinate else None,
                 "text": action.text, "scroll_direction": action.scroll_direction,
                 "scroll_amount": action.scroll_amount, "duration": action.duration_s},
            )
            return ActionResult(ok=ok, action=action, output=detail, error=error)

        async def apply_setup(self, steps: list[Any]) -> None:
            if steps:
                raise NotImplementedError("setup verbs are not supported on the host desk")

        async def seed_persona(self, persona_dir: str) -> None:
            raise NotImplementedError("the host desk never seeds a persona onto a real machine")

        async def collect_artifacts(self, trial_id: str) -> list[Any]:
            return []

        async def check_utility(self, check: Any) -> bool | None:
            return None

    return HostDeskEnvironment(desk)
