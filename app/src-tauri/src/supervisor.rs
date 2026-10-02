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
}
