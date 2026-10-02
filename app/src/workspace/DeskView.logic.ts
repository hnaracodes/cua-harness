// What the agent's-desk panel shows for one run (track U5). Type-only imports.
import type { FramePayload, OversightEvent, Step, StepRefPayload, StepResultPayload } from "../api/types";
import type { RunInfo } from "../state/session";

export type BarState = "todo" | "active" | "done" | "failed" | "stopped";
export interface DeskState {
  total: number;
  position: number;
  current: { index: number; title: string } | null;
  frameSeq: number | null;
  bars: BarState[];
  finished: boolean;
  doneCount: number;
}

export function deskState(events: OversightEvent[], steps: Step[], run: RunInfo): DeskState {
  const approved = steps.filter((s) => run.approvedIds.includes(s.id)).sort((a, b) => a.index - b.index);
  const status = new Map<string, BarState>();
  let current: DeskState["current"] = null;
  let frameSeq: number | null = null;
  let finished = false;
  for (const e of events) {
    if (e.run_id !== run.runId) continue;
    const p = e.payload as unknown;
    if (e.kind === "step_started") {
      const s = p as StepRefPayload;
      status.set(s.step_id, "active");
      current = { index: s.index, title: s.title };
    } else if (e.kind === "step_result") {
      const r = p as StepResultPayload;
      status.set(r.step_id, r.status === "done" ? "done" : r.status === "failed" ? "failed" : r.status === "stopped" ? "stopped" : "todo");
      if (current?.index === r.index) current = null;
    } else if (e.kind === "frame") frameSeq = (p as FramePayload).seq;
    else if (e.kind === "final_result") {
      finished = true;
      current = null;
    }
  }
  const bars = approved.map((s) => status.get(s.id) ?? "todo");
  const doneCount = bars.filter((b) => b === "done").length;
  const cur = current as DeskState["current"];
  const position = cur
    ? approved.findIndex((s) => s.index === cur.index) + 1
    : bars.filter((b) => b !== "todo" && b !== "active").length;
  return { total: approved.length, position, current, frameSeq, bars, finished, doneCount };
}

export function deskLabel(d: DeskState): string {
  if (d.finished) return `${d.doneCount} of ${d.total} done`;
  if (d.current) return `step ${d.position} of ${d.total}`;
  return d.position === 0 ? "Starting…" : `step ${d.position} of ${d.total}`;
}
