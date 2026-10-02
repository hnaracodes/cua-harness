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
