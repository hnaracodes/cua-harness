import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { TaskSummary } from "../api/types";
import type { ScreenProps } from "../screens";
import { latestCost, relTime } from "./format";
import { HealthPill } from "./HealthPill";
import { ModelPicker } from "./ModelPicker";
import s from "./AppShell.module.css";

export function AppShell({ api, conn, session, openSetup, children }: ScreenProps & { children: ReactNode }) {
  const { state, actions } = session;
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  // Refresh history whenever the task or its phase changes (a new task, a plan, a finished run).
  useEffect(() => {
    let alive = true;
    api.listTasks().then((t) => alive && setTasks(t), () => undefined);
    return () => {
      alive = false;
    };
  }, [api, state.phase, state.taskId, conn.reachable]);

  const cost = useMemo(() => latestCost(state.events, conn.health?.cost_usd_total ?? 0), [state.events, conn.health]);
  const home = state.phase === "home";

  return (
    <div className={s.shell}>
      <nav className={`${s.rail} ${open ? s.open : ""}`} aria-label="Tasks">
        <div className={s.top}>
          <div className={s.logo} aria-hidden>
            ◎
          </div>
          <button className={s.railBtn} data-testid="new-task" title="New task" aria-label="New task" onClick={actions.newTask}>
            +
          </button>
          <button className={s.railBtn} data-testid="history-toggle" title="Past tasks" aria-label="Past tasks" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>
            ☰
          </button>
        </div>
        {open ? (
          <div className={s.history}>
            <div className={s.historyHead}>Past tasks</div>
            {tasks.length === 0 && <div className={s.empty}>No tasks yet.</div>}
            {tasks.map((t) => (
              <button key={t.id} data-testid="history-item" className={`${s.item} ${t.id === state.taskId ? s.current : ""}`} title={t.prompt}
                onClick={() => void actions.openTask(t.id)}>
                <span className={s.itemText}>{t.prompt}</span>
                <span className={s.itemMeta}>
                  {relTime(t.created_at)} · {t.step_count} steps
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={s.spacer} />
        )}
        <div className={s.bottom}>
          {!home && <HealthPill conn={conn} cost={cost} openSetup={openSetup} compact />}
          <button className={s.railBtn} data-testid="settings" title="Setup and settings" aria-label="Setup and settings" onClick={() => openSetup()}>
            ⚙
          </button>
        </div>
      </nav>
      <main className={s.main}>
        {!conn.reachable && (
          <div className={s.banner} role="status">
            Reconnecting to the daemon…
          </div>
        )}
        {state.notice && (
          <div className={s.notice} data-testid="notice" role="alert">
            <span>{state.notice}</span>
            <button data-testid="notice-dismiss" onClick={actions.dismissNotice}>
              Dismiss
            </button>
          </div>
        )}
        {home && (
          <div className={s.topRight}>
            <HealthPill conn={conn} cost={cost} openSetup={openSetup} />
            <ModelPicker api={api} conn={conn} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
