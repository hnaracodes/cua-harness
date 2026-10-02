// The agent's own window, exactly what the model saw (window-scoped frames only).
import { useMemo, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { RunInfo } from "../state/session";
import { deskLabel, deskState } from "./DeskView.logic";
import s from "./DeskView.module.css";

export function DeskView({ api, taskId, events, steps, run }: { api: DaemonApi; taskId: string; events: OversightEvent[]; steps: Step[]; run: RunInfo }) {
  const d = useMemo(() => deskState(events, steps, run), [events, steps, run]);
  const url = d.frameSeq !== null ? api.frameUrl(taskId, d.frameSeq) : "";
  const [broken, setBroken] = useState<string | null>(null);
  const placeholder =
    api.mode === "mock" ? "Simulated run: there is no agent window to show." :
    d.finished ? "No view was captured for this run." : "Waiting for the agent's first view…";
  return (
    <div className={s.desk} data-testid="desk-view">
      <div className={s.head}>
        <span className={s.title}>Agent's desk</span>
        <span className={s.pill}>only this window is visible to the model</span>
        <span className={s.spacer} />
        <span className={s.where} data-testid="desk-label">{deskLabel(d)}</span>
      </div>
      <div className={s.progress} data-testid="desk-progress">
        {d.bars.map((b, i) => (
          <span key={i} className={`${s.seg} ${s[b]}`} />
        ))}
      </div>
      <div className={s.frame} data-testid="desk-frame">
        {url && broken !== url ? (
          <img className={s.img} src={url} alt={d.current ? `Agent window during step ${d.current.index}` : "Agent window"} onError={() => setBroken(url)} />
        ) : (
          <div className={s.placeholder}>{placeholder}</div>
        )}
      </div>
    </div>
  );
}
