import { useEffect, useState } from "react";
import { daemonLogTail, daemonStatus, isTauri, type SupervisorStatus } from "../lib/tauri";
import type { SetupStepKey } from "../screens";
import type { DaemonConn } from "../state/useDaemon";
import { usd } from "./format";
import { healthView } from "./healthModel";
import s from "./HealthPill.module.css";

export function HealthPill({ conn, cost, openSetup, compact = false }: {
  conn: DaemonConn;
  cost: number;
  openSetup: (step?: SetupStepKey) => void;
  compact?: boolean;
}) {
  const [sup, setSup] = useState<SupervisorStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = () => daemonStatus().then((x) => alive && setSup(x), () => undefined);
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const v = healthView(conn.health, conn.reachable, sup);
  const copyLog = async () => {
    await navigator.clipboard.writeText(await daemonLogTail(40));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const fix = (step: SetupStepKey) => {
    setOpen(false);
    openSetup(step);
  };

  return (
    <div className={s.wrap}>
      <button
        className={`${s.pill} ${s[v.tone]} ${compact ? s.compact : ""}`}
        data-testid="health-pill"
        aria-expanded={open}
        title={v.label}
        onClick={() => setOpen((o) => !o)}
      >
        <i className={s.dot} />
        {compact ? <span className={s.sr}>{v.label}</span> : v.label}
      </button>
      {!compact && v.fix && (
        <button className={s.fix} onClick={() => fix(v.fix!)}>
          Fix
        </button>
      )}
      {open && (
        <div className={`${s.pop} ${compact ? s.popUp : ""}`} role="dialog" aria-label="Daemon status">
          <b>{v.label}</b>
          {v.reason && <div className={s.muted}>{v.reason}</div>}
          {conn.health && <div className={s.muted}>{conn.health.status_line}</div>}
          <div className={s.row}>
            <span>Model</span>
            <span className={s.mono}>{conn.health?.model ?? "…"}</span>
          </div>
          <div className={s.row}>
            <span>This session</span>
            <span className={s.mono}>{usd(cost)}</span>
          </div>
          <div className={s.actions}>
            {sup && <button onClick={() => void copyLog()}>{copied ? "Copied" : "Copy log"}</button>}
            {v.fix && (
              <button className={s.primary} onClick={() => fix(v.fix!)}>
                Fix
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
