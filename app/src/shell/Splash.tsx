import { useEffect, useState } from "react";
import { daemonLogTail, daemonStatus, isTauri, type SupervisorStatus } from "../lib/tauri";
import type { DaemonConn } from "../state/useDaemon";
import s from "./Splash.module.css";

// Shown until the app has a DaemonApi. Inside Tauri it reflects the supervisor; when the
// daemon won't start it shows the last log lines with Copy log (spec: Error handling).
export function Splash(_props: { conn: DaemonConn }) {
  const [sup, setSup] = useState<SupervisorStatus | null>(null);
  const [log, setLog] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = async () => {
      const x = await daemonStatus().catch(() => null);
      if (!alive) return;
      setSup(x);
      if (x?.state === "failed") setLog(await daemonLogTail(40).catch(() => ""));
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const failed = sup?.state === "failed";
  const title = failed ? "The daemon won't start" : sup?.state === "restarting" ? "Restarting the daemon…" : "Starting the daemon…";
  const copy = async () => {
    await navigator.clipboard.writeText(log);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={s.splash} data-testid="splash">
      <div className={s.logo} aria-hidden>
        ◎
      </div>
      <div className={s.title}>{title}</div>
      {!failed && <div className={s.spinner} />}
      {sup && sup.restarts > 0 && !failed && <div className={s.muted}>Restart {sup.restarts} of 3.</div>}
      {failed && (
        <>
          <div className={s.muted}>{sup?.last_error ?? "It exited during startup three times."}</div>
          <pre className={s.log}>{log || "(no output captured)"}</pre>
          <button className={s.btn} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy log"}
          </button>
        </>
      )}
    </div>
  );
}
