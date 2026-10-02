//! Daemon supervisor (spec: "Tauri shell"). Launch, health, restart, quit. Nothing else.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

pub const HEALTH_ADDR: &str = "127.0.0.1:8765";
pub const LOG_CAPACITY: usize = 400;
pub const BACKOFF_SECS: [u64; 3] = [1, 2, 4];
/// First launch may run `uv sync`; give the daemon a minute to answer /health.
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// A child that answered /health for this long was stable; its exit starts a fresh streak.
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
    /// `healthy_for` is time since the child first answered /health (zero if it never
    /// did), not time since spawn: a child that never became healthy is always a failure.
    pub fn on_exit(&mut self, healthy_for: Duration) -> Next {
        if healthy_for >= STABLE_AFTER {
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

/// Dev layout: app/src-tauri/../../daemon == appdev/daemon. Packaged builds run the
/// sidecar instead (`sidecar_path`).
pub fn default_daemon_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("daemon")
}

/// The frozen daemon that `externalBin` places next to the app binary
/// (Contents/MacOS/oversight-daemon on macOS). Debug builds ignore it, because
/// `tauri dev` copies sidecars too and dev must keep running the source daemon.
pub fn sidecar_path() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let name = if cfg!(windows) { "oversight-daemon.exe" } else { "oversight-daemon" };
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

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

/// `OVERSIGHT_DAEMON_CMD` wins; else the bundled sidecar (release builds); else
/// `uv run oversight-daemon` in appdev/daemon.
pub fn daemon_command() -> ((String, Vec<String>), PathBuf) {
    if let Some(cmd) = std::env::var("OVERSIGHT_DAEMON_CMD").ok().and_then(|s| parse_command(&s)) {
        return (cmd, default_daemon_dir());
    }
    if let Some(bin) = sidecar_path() {
        let dir = bin.parent().map(PathBuf::from).unwrap_or_default();
        return ((bin.to_string_lossy().into_owned(), vec![]), dir);
    }
    (("uv".into(), vec!["run".into(), "oversight-daemon".into()]), default_daemon_dir())
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
        Self::start_with(cmd, cwd, HEALTH_ADDR)
    }

    pub fn start_with(cmd: (String, Vec<String>), cwd: PathBuf, health_addr: &'static str) -> Self {
        Self::start_configured(cmd, cwd, health_addr, READY_TIMEOUT)
    }

    fn start_configured(cmd: (String, Vec<String>), cwd: PathBuf, health_addr: &'static str,
                        ready_timeout: Duration) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            status: SupervisorStatus { state: DaemonState::Starting, restarts: 0, last_error: None },
            log: LogRing::new(LOG_CAPACITY),
            child: None,
            stopping: false,
        }));
        let me = Self { inner: inner.clone() };
        thread::spawn(move || run_loop(inner, cmd, cwd, health_addr, ready_timeout));
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
    if state == DaemonState::Running {
        g.status.last_error = None; // a recovered daemon must not report a stale error
    } else if err.is_some() {
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
    let line = format!("spawned `{} {}` (pid {}) in {}", cmd.0, cmd.1.join(" "), child.id(), cwd.display());
    let mut g = inner.lock().unwrap();
    g.log.push(line);
    if g.stopping {
        // shutdown() ran between spawn() and here and found no child to stop: stop it now,
        // under the same lock shutdown() takes, so it cannot be orphaned.
        drop(g);
        terminate(&mut child);
        return Ok(());
    }
    g.child = Some(child);
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
    #[cfg(windows)]
    {
        // child.kill() would stop `uv` but orphan the python it started; kill the tree.
        // TODO(packaging): put the sidecar in a Job object (kill-on-close) instead.
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Take any stored child and stop it (used when quitting races a spawn).
fn take_and_terminate(inner: &Arc<Mutex<Inner>>) {
    let child = inner.lock().unwrap().child.take();
    if let Some(mut c) = child {
        terminate(&mut c);
    }
}

fn run_loop(inner: Arc<Mutex<Inner>>, cmd: (String, Vec<String>), cwd: PathBuf,
            health_addr: &'static str, ready_timeout: Duration) {
    if health_ok(health_addr, Duration::from_millis(500)) {
        note(&inner, format!("a daemon already answers on {health_addr}; using it, not spawning one"));
        set_state(&inner, DaemonState::External, None);
        return;
    }
    let mut policy = Policy::default();
    loop {
        if inner.lock().unwrap().stopping {
            take_and_terminate(&inner);
            return;
        }
        let started = Instant::now();
        // When this spawn first answered /health; restart policy counts healthy time only.
        let mut healthy_at: Option<Instant> = None;
        if let Err(e) = spawn_child(&inner, &cmd, &cwd) {
            note(&inner, format!("spawn failed: {e}"));
            inner.lock().unwrap().status.last_error = Some(format!("spawn failed: {e}"));
        } else {
            // Wait for readiness, then for exit.
            loop {
                thread::sleep(Duration::from_millis(250));
                let mut g = inner.lock().unwrap();
                if g.stopping {
                    drop(g);
                    take_and_terminate(&inner);
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
                drop(g);
                if healthy_at.is_none() {
                    if health_ok(health_addr, Duration::from_millis(400)) {
                        healthy_at = Some(Instant::now());
                        note(&inner, "daemon healthy");
                        set_state(&inner, DaemonState::Running, None);
                    } else if started.elapsed() > ready_timeout {
                        // Diagram: "not healthy in 60 s → failed". Restarting would only
                        // repeat the same wait (for example a slow, broken `uv sync`).
                        let secs = ready_timeout.as_secs();
                        note(&inner, format!("daemon not healthy after {secs} s; giving up"));
                        take_and_terminate(&inner);
                        set_state(&inner, DaemonState::Failed, Some(format!(
                            "The daemon won't start (last: not healthy within {secs} s). See the log.")));
                        return;
                    }
                }
            }
        }
        match policy.on_exit(healthy_at.map(|t| t.elapsed()).unwrap_or(Duration::ZERO)) {
            Next::RestartAfter(d) => {
                {
                    let mut g = inner.lock().unwrap();
                    g.status.state = DaemonState::Restarting;
                    g.status.restarts += 1;
                }
                note(&inner, format!("restarting in {} s", d.as_secs()));
                thread::sleep(d);
                // restarting → backoff → spawn → starting
                inner.lock().unwrap().status.state = DaemonState::Starting;
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
    fn policy_gives_up_when_the_child_never_became_healthy() {
        // A child that never answered /health counts as zero healthy time, however
        // long it ran, so the streak never resets and the policy ends in GiveUp.
        let mut p = Policy::default();
        assert_eq!(p.on_exit(Duration::ZERO), Next::RestartAfter(Duration::from_secs(1)));
        assert_eq!(p.on_exit(Duration::ZERO), Next::RestartAfter(Duration::from_secs(2)));
        assert_eq!(p.on_exit(Duration::ZERO), Next::RestartAfter(Duration::from_secs(4)));
        assert_eq!(p.on_exit(Duration::ZERO), Next::GiveUp);
    }

    #[test]
    fn running_clears_a_stale_error() {
        let inner = Arc::new(Mutex::new(Inner {
            status: SupervisorStatus { state: DaemonState::Restarting, restarts: 1,
                                       last_error: Some("daemon exited (signal: 15)".into()) },
            log: LogRing::new(4),
            child: None,
            stopping: false,
        }));
        set_state(&inner, DaemonState::Running, None);
        let st = inner.lock().unwrap().status.clone();
        assert_eq!(st.state, DaemonState::Running);
        assert_eq!(st.last_error, None);
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

    #[test]
    fn supervisor_gives_up_on_a_command_that_always_exits() {
        // `false` exits immediately: three backoff restarts (1+2+4 s), then failed.
        // Uses an unused port so a live daemon on :8765 cannot turn this into `external`.
        let addr = "127.0.0.1:59871";
        assert!(!health_ok(addr, Duration::from_millis(300)), "{addr} must be free");
        let sup = Supervisor::start_with(("false".into(), vec![]), std::env::temp_dir(), addr);
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

    #[test]
    fn supervisor_fails_when_the_daemon_never_becomes_healthy() {
        // `sleep 1000` never answers /health: after the ready timeout it is killed and the
        // state is failed (not restarted forever).
        let addr = "127.0.0.1:59872";
        assert!(!health_ok(addr, Duration::from_millis(300)), "{addr} must be free");
        let sup = Supervisor::start_configured(("sleep".into(), vec!["1000".into()]),
                                               std::env::temp_dir(), addr, Duration::from_secs(2));
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while sup.status().state != DaemonState::Failed && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let s = sup.status();
        assert_eq!(s.state, DaemonState::Failed);
        assert_eq!(s.restarts, 0);
        assert!(s.last_error.unwrap_or_default().contains("won't start"));
        assert!(sup.inner.lock().unwrap().child.is_none(), "timed-out child must be terminated");
    }
}
