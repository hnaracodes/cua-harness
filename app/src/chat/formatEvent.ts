// One line per event for the recap's Details log (track U2). Type-only imports.
import type { ActionPayload, CostPayload, FramePayload, OversightEvent, StepRefPayload, StepResultPayload } from "../api/types";

export function formatEvent(ev: OversightEvent): string {
  const t = ev.ts.slice(11, 19);
  const p = ev.payload as unknown;
  switch (ev.kind) {
    case "step_started": {
      const s = p as StepRefPayload;
      return `${t}  ▸ step ${s.index} started: ${s.title}`;
    }
    case "action": {
      const a = p as ActionPayload;
      return `${t}      ${a.ok ? "✓" : "✗"} ${a.mode} ${a.verb} ${a.target}${a.error ? ` (${a.error})` : ""}`;
    }
    case "step_result": {
      const r = p as StepResultPayload;
      return `${t}  ■ step ${r.index} ${r.status}: ${r.summary}`;
    }
    case "cost": {
      const c = p as CostPayload;
      return `${t}      $${c.usd_delta.toFixed(4)} ${c.model} ${c.latency_ms} ms`;
    }
    case "frame":
      return `${t}      frame ${(p as FramePayload).seq}`;
    default:
      return `${t}  ${ev.kind}`;
  }
}
