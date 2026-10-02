# Track R1: Tauri shell as daemon supervisor

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read Global Constraints, Contract C7, and the Ownership matrix first. Spec section: "Tauri shell". Wave 1, Batch A. Worktree: `.worktrees/rd-R1`, branch `rd/R1`.

**Owns:**
- `app/src-tauri/**`: `Cargo.toml`, `src/lib.rs`, new `src/supervisor.rs`, `capabilities/default.json`
- `app/src/lib/tauri.ts`
- the `connectDaemon` function in `app/src/api/client.ts`, plus the one import line it needs
- `app/tests/tauri.test.mts` (new)

**Must not touch:** any other part of `client.ts`, `mock.ts`, `useDaemon.ts`, or any screen. The shell holds no logic beyond launch, health, restart, and quit. It never opens URLs, stores keys, or checks permissions; the daemon does all of that.

**Rust toolchain:** every cargo command runs with the repo-local env, from `appdev/`:

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
export CARGO_HOME="$PWD/.toolchain/cargo" RUSTUP_HOME="$PWD/.toolchain/rustup" PATH="$PWD/.toolchain/cargo/bin:$PATH"
```

(In a worktree, `$PWD` is the worktree root. `.toolchain/` lives only in the main checkout, so use its absolute path: `/Users/hrudaynara/Research/Security CUAs Week 1/appdev/.toolchain/...`.)

**State machine (C7 `SupervisorStatus.state`):**

```
                health already answers on :8765
   launch ───────────────────────────────────────────▶ external   (never spawns, never kills)
     │
     ▼ spawn
  starting ──/health 200──▶ running
     │  ▲                     │ child exits
     │  │ spawn after         ▼
     │  └── backoff ◀── restarting   (exits 1,2,3 → wait 1 s, 2 s, 4 s; restarts += 1)
     │                        │ 4th consecutive exit (initial start + 3 restarts all failed)
     └─ not healthy in 60 s ──┤
                              ▼
                            failed   (last_error set; log tail kept)
A run that stayed up ≥ 30 s resets the consecutive-failure count.
```

---

## Task R1-1: Pure supervisor core (ring buffer, restart policy, HTTP check, command/PATH)

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (add `serde`, `serde_json`)
- Create: `app/src-tauri/src/supervisor.rs` (the pure parts plus their `#[cfg(test)]` tests)
- Modify: `app/src-tauri/src/lib.rs` (`mod supervisor;` only, in this task)

**Interfaces:**
- Consumes: nothing.
- Produces (used by R1-2):
  - `DaemonState` (serializes lowercase), `SupervisorStatus { state, restarts, last_error }` (serializes to C7 exactly), `LogRing`
  - `Policy::on_exit(ran_for) -> Next`, with `Next::{RestartAfter(Duration), GiveUp}`
  - `is_http_ok(&[u8])`, `parse_command(&str) -> Option<(String, Vec<String>)>`, `augment_path(cur, home) -> String`, `default_daemon_dir() -> PathBuf`
  - Constants `HEALTH_ADDR`, `LOG_CAPACITY = 400`, `BACKOFF_SECS = [1, 2, 4]`, `READY_TIMEOUT`, `STABLE_AFTER`

- [ ] **Step 1: Add the two allowed dependencies**

In `app/src-tauri/Cargo.toml` `[dependencies]`, add:

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Write the failing tests and the module skeleton**

Create `app/src-tauri/src/supervisor.rs` with only the tests first:

```rust
//! Daemon supervisor (spec: "Tauri shell"). Launch, health, restart, quit. Nothing else.

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn ring_keeps_last_capacity_lines_and_tails() {
        let mut r = LogRing::new(3);
        for i in 0..5 {
            r.push(format!("l{i}"));
        }
        assert_eq!(r.tail(10), "l2\nl3\nl4");
        assert_eq!(r.tail(2), "l3\nl4");
        assert_eq!(LogRing::new(3).tail(5), "");
    }

    #[test]
    fn policy_backs_off_1_2_4_then_gives_up() {
        let mut p = Policy::default();
        let quick = Duration::from_secs(1);
        assert_eq!(p.on_exit(quick), Next::RestartAfter(Duration::from_secs(1)));
        assert_eq!(p.on_exit(quick), Next::RestartAfter(Duration::from_secs(2)));
        assert_eq!(p.on_exit(quick), Next::RestartAfter(Duration::from_secs(4)));
        assert_eq!(p.on_exit(quick), Next::GiveUp);
    }

    #[test]
    fn policy_resets_after_a_stable_run() {
        let mut p = Policy::default();
        p.on_exit(Duration::from_secs(1));
        p.on_exit(Duration::from_secs(1));
        assert_eq!(p.on_exit(STABLE_AFTER), Next::RestartAfter(Duration::from_secs(1)));
    }

    #[test]
    fn http_ok_only_for_200() {
        assert!(is_http_ok(b"HTTP/1.1 200 OK\r\ncontent-type: application/json"));
        assert!(is_http_ok(b"HTTP/1.0 200 OK"));
        assert!(!is_http_ok(b"HTTP/1.1 503 Service Unavailable"));
        assert!(!is_http_ok(b""));
    }

    #[test]
    fn parse_command_splits_program_and_args() {
        assert_eq!(parse_command("uv run oversight-daemon --fixtures"),
                   Some(("uv".into(), vec!["run".into(), "oversight-daemon".into(), "--fixtures".into()])));
        assert_eq!(parse_command("   "), None);
    }

    #[test]
    fn augment_path_adds_common_bins_once() {
        let p = augment_path("/usr/bin:/opt/homebrew/bin", "/Users/u");
        assert!(p.starts_with("/usr/bin:/opt/homebrew/bin"));
        assert_eq!(p.matches("/opt/homebrew/bin").count(), 1);
        assert!(p.contains("/usr/local/bin") && p.contains("/Users/u/.local/bin"));
    }

    #[test]
    fn status_serializes_to_contract_c7() {
        let s = SupervisorStatus { state: DaemonState::Restarting, restarts: 2, last_error: None };
        assert_eq!(serde_json::to_string(&s).unwrap(),
                   r#"{"state":"restarting","restarts":2,"last_error":null}"#);
    }

    #[test]
    fn default_daemon_dir_points_at_appdev_daemon() {
        assert!(default_daemon_dir().join("pyproject.toml").is_file());
    }
}
```

In `app/src-tauri/src/lib.rs`, add `mod supervisor;` as the first line after the comments.

Run (toolchain env exported): `cd app/src-tauri && cargo test --lib supervisor`
Expected: FAIL to compile, with `cannot find type LogRing` and similar errors.

- [ ] **Step 3: Implement the pure core**

Insert above the `#[cfg(test)]` block in `supervisor.rs`:

```rust
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

pub const HEALTH_ADDR: &str = "127.0.0.1:8765";
pub const LOG_CAPACITY: usize = 400;
pub const BACKOFF_SECS: [u64; 3] = [1, 2, 4];
/// First launch may run `uv sync`; give the daemon a minute to answer /health.
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// A child that stayed up this long was healthy; its exit starts a fresh streak.
pub const STABLE_AFTER: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonState {
    Starting,
    Running,
    Restarting,
    Failed,
    External,
}

/// Contract C7 `SupervisorStatus`.
#[derive(Clone, Debug, Serialize)]
pub struct SupervisorStatus {
    pub state: DaemonState,
    pub restarts: u32,
    pub last_error: Option<String>,
}

pub struct LogRing {
    cap: usize,
    lines: VecDeque<String>,
}

impl LogRing {
    pub fn new(cap: usize) -> Self {
        Self { cap, lines: VecDeque::with_capacity(cap) }
    }
    pub fn push(&mut self, line: impl Into<String>) {
        if self.lines.len() == self.cap {
            self.lines.pop_front();
        }
        self.lines.push_back(line.into());
    }
    pub fn tail(&self, n: usize) -> String {
        let skip = self.lines.len().saturating_sub(n);
        self.lines.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    RestartAfter(Duration),
    GiveUp,
}

/// Restart policy: exits 1..=3 restart after 1 s / 2 s / 4 s; the 4th consecutive
/// exit gives up (initial start + three restarts all failed).
#[derive(Default)]
pub struct Policy {
    consecutive_failures: u32,
}

impl Policy {
    pub fn on_exit(&mut self, ran_for: Duration) -> Next {
        if ran_for >= STABLE_AFTER {
            self.consecutive_failures = 0;
        }
        self.consecutive_failures += 1;
        match BACKOFF_SECS.get((self.consecutive_failures - 1) as usize) {
            Some(s) => Next::RestartAfter(Duration::from_secs(*s)),
            None => Next::GiveUp,
        }
    }
}

pub fn is_http_ok(head: &[u8]) -> bool {
    head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200")
}

/// `OVERSIGHT_DAEMON_CMD` parsing: whitespace split, no shell, no quoting.
pub fn parse_command(s: &str) -> Option<(String, Vec<String>)> {
    let mut parts = s.split_whitespace().map(String::from);
    let program = parts.next()?;
    Some((program, parts.collect()))
}

/// GUI apps launched from Finder get a minimal PATH; add where `uv` usually lives.
pub fn augment_path(cur: &str, home: &str) -> String {
    let mut parts: Vec<String> = cur.split(':').filter(|p| !p.is_empty()).map(String::from).collect();
    for extra in ["/opt/homebrew/bin".to_string(), "/usr/local/bin".to_string(),
                  format!("{home}/.local/bin"), format!("{home}/.cargo/bin")] {
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

/// Dev layout: app/src-tauri/../../daemon == appdev/daemon. The packaging
/// sub-project replaces this with a sidecar binary (seam: `daemon_command`).
pub fn default_daemon_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("daemon")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app/src-tauri && cargo test --lib supervisor`
Expected: `8 passed`. There may be dead-code warnings until R1-2 uses the code; that's fine.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/supervisor.rs app/src-tauri/src/lib.rs
git commit -m "shell: supervisor core (log ring, restart policy, health parse, PATH)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task R1-2: Spawn, supervise, expose commands, kill on exit

**Files:**
- Modify: `app/src-tauri/src/supervisor.rs` (add `Supervisor`, `health_ok`, `daemon_command`, the run loop, and process-group kill)
- Modify: `app/src-tauri/src/lib.rs` (manage the supervisor, register commands, shut down on `RunEvent::Exit`)
- Modify: `app/src-tauri/capabilities/default.json` (description only; see the note)

**Interfaces:**
- Consumes: R1-1.
- Produces Tauri commands for R1-3:
  - `daemon_status() -> SupervisorStatus`
  - `daemon_log_tail(lines: usize) -> String`, invoked from JS as `invoke("daemon_log_tail", { lines })`

- [ ] **Step 1: Write the failing integration test (real child, fake daemon)**

Append inside `mod tests` in `supervisor.rs`:

```rust
    #[test]
    fn supervisor_gives_up_on_a_command_that_always_exits() {
        // `false` exits immediately: three backoff restarts (1+2+4 s), then failed.
        // Only meaningful when nothing listens on :8765 (otherwise state is external).
        if health_ok(HEALTH_ADDR, Duration::from_millis(300)) {
            return;
        }
        let sup = Supervisor::start_with(("false".into(), vec![]), std::env::temp_dir());
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while sup.status().state != DaemonState::Failed && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let s = sup.status();
        assert_eq!(s.state, DaemonState::Failed);
        assert_eq!(s.restarts, 3);
        assert!(s.last_error.unwrap_or_default().contains("won't start"));
        assert!(sup.log_tail(50).contains("exited"));
    }
```

Run: `cd app/src-tauri && cargo test --lib supervisor`
Expected: FAIL to compile (`cannot find function health_ok`, `Supervisor`).

- [ ] **Step 2: Implement the supervisor**

Append to `supervisor.rs`, above the tests:

```rust
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

pub fn health_ok(addr: &str, timeout: Duration) -> bool {
    let Ok(sock) = addr.parse::<SocketAddr>() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&sock, timeout) else { return false };
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    if s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    let n = s.read(&mut buf).unwrap_or(0);
    is_http_ok(&buf[..n])
}

/// `OVERSIGHT_DAEMON_CMD` wins; else `uv run oversight-daemon` in appdev/daemon.
pub fn daemon_command() -> ((String, Vec<String>), PathBuf) {
    let cmd = std::env::var("OVERSIGHT_DAEMON_CMD").ok().and_then(|s| parse_command(&s));
    (cmd.unwrap_or_else(|| ("uv".into(), vec!["run".into(), "oversight-daemon".into()])), default_daemon_dir())
}

struct Inner {
    status: SupervisorStatus,
    log: LogRing,
    child: Option<Child>,
    stopping: bool,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

impl Supervisor {
    pub fn start() -> Self {
        let (cmd, cwd) = daemon_command();
        Self::start_with(cmd, cwd)
    }

    pub fn start_with(cmd: (String, Vec<String>), cwd: PathBuf) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            status: SupervisorStatus { state: DaemonState::Starting, restarts: 0, last_error: None },
            log: LogRing::new(LOG_CAPACITY),
            child: None,
            stopping: false,
        }));
        let me = Self { inner: inner.clone() };
        thread::spawn(move || run_loop(inner, cmd, cwd));
        me
    }

    pub fn status(&self) -> SupervisorStatus {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn log_tail(&self, n: usize) -> String {
        self.inner.lock().unwrap().log.tail(n)
    }

    /// App quit: stop restarting and take the daemon (and uv's child python) down.
    pub fn shutdown(&self) {
        let mut g = self.inner.lock().unwrap();
        g.stopping = true;
        if let Some(mut child) = g.child.take() {
            terminate(&mut child);
        }
    }
}

fn note(inner: &Arc<Mutex<Inner>>, line: impl Into<String>) {
    inner.lock().unwrap().log.push(line);
}

fn set_state(inner: &Arc<Mutex<Inner>>, state: DaemonState, err: Option<String>) {
    let mut g = inner.lock().unwrap();
    g.status.state = state;
    if err.is_some() {
        g.status.last_error = err;
    }
}

fn pump(inner: Arc<Mutex<Inner>>, src: impl Read + Send + 'static, tag: &'static str) {
    thread::spawn(move || {
        for line in BufReader::new(src).lines().map_while(Result::ok) {
            inner.lock().unwrap().log.push(format!("[{tag}] {line}"));
        }
    });
}

fn spawn_child(inner: &Arc<Mutex<Inner>>, cmd: &(String, Vec<String>), cwd: &PathBuf) -> std::io::Result<()> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut c = Command::new(&cmd.0);
    c.args(&cmd.1)
        .current_dir(cwd)
        .env("PATH", augment_path(&std::env::var("PATH").unwrap_or_default(), &home))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // own group: quitting kills uv AND the python it started
    }
    let mut child = c.spawn()?;
    if let Some(o) = child.stdout.take() {
        pump(inner.clone(), o, "out");
    }
    if let Some(e) = child.stderr.take() {
        pump(inner.clone(), e, "err");
    }
    note(inner, format!("spawned `{} {}` (pid {}) in {}", cmd.0, cmd.1.join(" "), child.id(), cwd.display()));
    inner.lock().unwrap().child = Some(child);
    Ok(())
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // SIGTERM to the whole group so `uv run` forwards it and python exits cleanly.
        let _ = Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).status();
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_loop(inner: Arc<Mutex<Inner>>, cmd: (String, Vec<String>), cwd: PathBuf) {
    if health_ok(HEALTH_ADDR, Duration::from_millis(500)) {
        note(&inner, "a daemon already answers on 127.0.0.1:8765; using it, not spawning one");
        set_state(&inner, DaemonState::External, None);
        return;
    }
    let mut policy = Policy::default();
    loop {
        if inner.lock().unwrap().stopping {
            return;
        }
        let started = Instant::now();
        if let Err(e) = spawn_child(&inner, &cmd, &cwd) {
            note(&inner, format!("spawn failed: {e}"));
            inner.lock().unwrap().status.last_error = Some(format!("spawn failed: {e}"));
        } else {
            // Wait for readiness, then for exit.
            loop {
                thread::sleep(Duration::from_millis(250));
                let mut g = inner.lock().unwrap();
                if g.stopping {
                    return;
                }
                let exited = match g.child.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(code)) => Some(format!("daemon exited ({code})")),
                        Ok(None) => None,
                        Err(e) => Some(format!("daemon wait failed: {e}")),
                    },
                    None => Some("daemon exited".into()),
                };
                if let Some(why) = exited {
                    g.child = None;
                    g.log.push(why.clone());
                    g.status.last_error = Some(why);
                    break;
                }
                let state = g.status.state;
                drop(g);
                if state != DaemonState::Running {
                    if health_ok(HEALTH_ADDR, Duration::from_millis(400)) {
                        note(&inner, "daemon healthy");
                        set_state(&inner, DaemonState::Running, None);
                    } else if started.elapsed() > READY_TIMEOUT {
                        note(&inner, "daemon not healthy after 60 s; restarting it");
                        // Take the child in its own statement so the lock is released before
                        // terminate() (which can wait up to 3 s) and before we lock again.
                        let child = inner.lock().unwrap().child.take();
                        if let Some(mut c) = child {
                            terminate(&mut c);
                        }
                        inner.lock().unwrap().status.last_error = Some("not healthy within 60 s".into());
                        break;
                    }
                }
            }
        }
        match policy.on_exit(started.elapsed()) {
            Next::RestartAfter(d) => {
                {
                    let mut g = inner.lock().unwrap();
                    g.status.state = DaemonState::Restarting;
                    g.status.restarts += 1;
                }
                note(&inner, format!("restarting in {} s", d.as_secs()));
                thread::sleep(d);
            }
            Next::GiveUp => {
                let last = inner.lock().unwrap().status.last_error.clone().unwrap_or_default();
                set_state(&inner, DaemonState::Failed,
                          Some(format!("The daemon won't start (last: {last}). See the log.")));
                note(&inner, "giving up after 3 restarts");
                return;
            }
        }
    }
}
```

- [ ] **Step 3: Wire it into the app**

Replace `app/src-tauri/src/lib.rs` with:

```rust
// The shell is thin glue: it supervises the Python daemon and hosts the webview.
// All logic lives in the daemon; the webview renders and captures gestures.
mod supervisor;

use supervisor::{Supervisor, SupervisorStatus};
use tauri::{Manager, RunEvent};

#[tauri::command]
fn daemon_status(sup: tauri::State<'_, Supervisor>) -> SupervisorStatus {
    sup.status()
}

#[tauri::command]
fn daemon_log_tail(sup: tauri::State<'_, Supervisor>, lines: usize) -> String {
    sup.log_tail(lines.min(supervisor::LOG_CAPACITY))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Supervisor::start())
        .invoke_handler(tauri::generate_handler![daemon_status, daemon_log_tail])
        .build(tauri::generate_context!())
        .expect("error while building Agent Oversight");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Supervisor>().shutdown();
        }
    });
}
```

In `app/src-tauri/capabilities/default.json`, change `description` to `"Main window: always-on-top during execution, daemon supervisor status/log commands."`. App-defined commands in Tauri 2 are allowed for every window unless the build script declares an app manifest, and this app declares none. So no new permission identifier is needed. Step 5 below proves the commands work end to end.

- [ ] **Step 4: Run the Rust tests**

Run: `cd app/src-tauri && cargo test --lib supervisor -- --test-threads=1`
Expected: `9 passed`. The integration test takes about 8 s, because of the 1+2+4 s backoff.

- [ ] **Step 5: Manual verification in the real window**

From `appdev/`, with the toolchain env exported and **no daemon running** (`curl -s 127.0.0.1:8765/health` fails):

```bash
cd app && npm run tauri dev
```

Check each of these:
1. The window opens, and within about 10 s (longer on the first `uv sync`) `curl -s 127.0.0.1:8765/health` answers. In the webview devtools console, `await window.__TAURI_INTERNALS__.invoke("daemon_status")` returns `{state: "running", restarts: 0, last_error: null}`.
2. `await window.__TAURI_INTERNALS__.invoke("daemon_log_tail", { lines: 5 })` returns recent uvicorn lines prefixed `[err]` or `[out]`.
3. `pkill -f oversight-daemon`: within 1 s the status reads `restarting` (restarts 1), then `running` again.
4. Quit the app (⌘Q): `pgrep -f oversight-daemon` prints nothing, and the health curl fails. No orphan python remains.
5. Start `cd daemon && uv run oversight-daemon --fixtures` in a terminal first, then `npm run tauri dev`: the status is `external`, and quitting the app leaves the terminal daemon running.
6. `OVERSIGHT_DAEMON_CMD=false npm run tauri dev`: after about 7 s the status is `failed`, `last_error` contains `won't start`, and the log tail shows the three `restarting in …` lines.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src app/src-tauri/capabilities/default.json
git commit -m "shell: supervise the daemon (spawn, health, backoff restart, group kill on quit)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task R1-3: TS bridge (`lib/tauri.ts`) and `connectDaemon` waits for the supervisor

**Files:**
- Modify: `app/src/lib/tauri.ts` (implement the C7 stubs; add `pollUntil`)
- Modify: `app/src/api/client.ts`: the `connectDaemon` function and one import line only
- Test: `app/tests/tauri.test.mts`

**Interfaces:**
- Consumes: the R1-2 commands `daemon_status` and `daemon_log_tail`.
- Produces:
  - C7 `daemonStatus()` and `daemonLogTail(lines)`.
  - `pollUntil(probe, { intervalMs, timeoutMs, sleep?, now? }) -> Promise<boolean>`.
  - `connectDaemon()`: in Tauri it **never returns the mock**. It polls `/health` every 500 ms while the supervisor is starting or restarting the daemon, up to `TAURI_CONNECT_TIMEOUT_MS` (120 s). It stops early if the supervisor reports `failed`. On failure or timeout it still returns `createHttpDaemon(DAEMON_URL)`, so `conn.reachable` is false and U1 shows "won't start" with the log tail. Outside Tauri (or with `VITE_MOCK=1` / `?mock`), behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Create `app/tests/tauri.test.mts`:

```ts
// Run: npm test. tauri.ts has no top-level value imports (Tauri APIs load lazily),
// so node can import it directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonLogTail, daemonStatus, pollUntil } from "../src/lib/tauri.ts";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("pollUntil resolves true as soon as the probe succeeds", async () => {
  const c = fakeClock();
  let n = 0;
  const ok = await pollUntil(async () => ++n === 3, { intervalMs: 500, timeoutMs: 30_000, ...c });
  assert.equal(ok, true);
  assert.equal(n, 3);
  assert.equal(c.now(), 1000);
});

test("pollUntil gives up at the timeout", async () => {
  const c = fakeClock();
  let n = 0;
  const ok = await pollUntil(async () => (n++, false), { intervalMs: 500, timeoutMs: 2000, ...c });
  assert.equal(ok, false);
  assert.equal(n, 5); // t = 0, 500, 1000, 1500, 2000
});

test("outside Tauri the bridge is inert", async () => {
  assert.equal(await daemonStatus(), null);
  assert.equal(await daemonLogTail(10), "");
});
```

Run: `cd app && npm test`
Expected: FAIL with `does not provide an export named 'pollUntil'`.

- [ ] **Step 2: Implement the bridge**

In `app/src/lib/tauri.ts`, replace the two Wave 0 stub functions (`daemonStatus` and `daemonLogTail`) with the code below. Keep the `SupervisorStatus` interface as it is.

```ts
/** Daemon supervisor status from the Rust shell. Null outside Tauri or on error. */
export async function daemonStatus(): Promise<SupervisorStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SupervisorStatus>("daemon_status");
  } catch (e) {
    console.warn("daemon_status failed", e);
    return null;
  }
}

/** Last `lines` lines of daemon output captured by the shell. "" outside Tauri. */
export async function daemonLogTail(lines: number): Promise<string> {
  if (!isTauri()) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("daemon_log_tail", { lines });
  } catch (e) {
    console.warn("daemon_log_tail failed", e);
    return "";
  }
}

/** Probe every `intervalMs` until it returns true or `timeoutMs` elapses (inclusive). */
export async function pollUntil(
  probe: () => Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const end = now() + opts.timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (now() >= end) return false;
    await sleep(opts.intervalMs);
  }
}
```

- [ ] **Step 3: `connectDaemon` waits for the supervisor in Tauri**

In `app/src/api/client.ts`, add the import line and the constant next to `FORCE_MOCK`:

```ts
import { daemonStatus, isTauri, pollUntil } from "../lib/tauri";
```

```ts
/** Desktop only: how long to wait for the supervised daemon (> Rust's 60 s readiness timeout). */
export const TAURI_CONNECT_TIMEOUT_MS = 120_000;
```

Replace only the `connectDaemon` function with:

```ts
/** Decide once at startup.
 *  Browser: the real daemon if it answers /health, else the mock (unchanged).
 *  Desktop app: NEVER the mock. Wait while the shell's supervisor is starting or
 *  restarting the daemon (up to 120 s, which covers a first-launch `uv sync`). If it reports
 *  `failed` or the wait times out, still return the HTTP daemon, so conn.reachable
 *  goes false and Splash/HealthPill show "won't start" + the log tail (track U1). */
export async function connectDaemon(): Promise<DaemonApi> {
  if (FORCE_MOCK) return createMockDaemon();
  const probe = async () => {
    try {
      await request<Health>(DAEMON_URL, "/health", { timeoutMs: 1500 });
      return true;
    } catch {
      return false;
    }
  };
  if (isTauri()) {
    await pollUntil(
      async () => (await probe()) || (await daemonStatus())?.state === "failed",
      { intervalMs: 500, timeoutMs: TAURI_CONNECT_TIMEOUT_MS },
    );
    return createHttpDaemon(DAEMON_URL);
  }
  return (await probe()) ? createHttpDaemon(DAEMON_URL) : createMockDaemon();
}
```

- [ ] **Step 4: Verify**

Run: `cd app && npm run typecheck && npm test`
Expected: clean; `tauri.test.mts` gives 3 passed, and every other test still passes.

Run: `cd app && E2E_PORT=1430 npx playwright test e2e/smoke.spec.ts`
Expected: `2 passed`. This runs in the browser, so `?mock` behavior is unchanged.

Manual (desktop, toolchain env exported):
1. Cold start (no daemon running, `npm run tauri dev`): the splash stays up while the daemon boots, including a first-launch `uv sync` of over 30 s. Then the real UI appears, and the health pill shows "Ready", never "mock".
2. `OVERSIGHT_DAEMON_CMD=false npm run tauri dev`: after about 7 s (when the supervisor reaches `failed`) the app leaves the splash **without** the mock. The health pill is red or unreachable, and no fixture plan can be generated. U1's "won't start" UI and log tail show once U1 merges.
3. Browser `npm run dev` with no daemon: still falls back to the mock, as before.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tauri.ts app/src/api/client.ts app/tests/tauri.test.mts
git commit -m "app: tauri bridge for supervisor status/log; connect waits for the shell's daemon" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

**Track R1 exit check:** `cargo test --lib supervisor -- --test-threads=1` passes, `npm run typecheck && npm test` passes, the smoke e2e passes, and every manual check in R1-2 Step 5 is observed. `git diff --name-only ui-redesign...HEAD` lists only `app/src-tauri/**`, `app/src/lib/tauri.ts`, `app/src/api/client.ts`, and `app/tests/tauri.test.mts`.

---

## Contract notes

- **The desktop app never uses the mock.** On `failed` or after the 120 s wait, `connectDaemon` returns the HTTP daemon anyway, so `conn.api` is non-null and `conn.reachable` is false. U1 shows "The daemon won't start" in Tauri when `daemonStatus()?.state === "failed"`, with `daemonLogTail(40)` and Copy log. Otherwise it shows "Reconnecting…". If the daemon comes up later (a manual restart), `useDaemon`'s 5 s health poll flips `reachable` back to true on its own, with no reconnect needed.
- **No capability change was needed.** Tauri 2 allows app-defined commands without capability entries when no app manifest is declared, so `capabilities/default.json` only gets a description update.
