// Pure mapping from a task's stored event stream to chat messages (track U2).
// A replay feeds the same events, so a replayed task renders exactly what the live
// run rendered. Ids derive from event seq, so they are stable as the stream grows.
// Type-only imports: node --test runs this file directly.
import type {
  CostPayload,
  FinalResultPayload,
  OversightEvent,
  PlanProgressPayload,
  PlanRevisedPayload,
  RunRecapPayload,
  StepRefPayload,
  StepResultPayload,
} from "../api/types";
import type { ChatInput, ChatMessage } from "./types";

type Msg<K extends ChatMessage["kind"]> = Extract<ChatMessage, { kind: K }>;

interface RunAcc {
  startTs: string;
  started: Msg<"run_started">;
  skipped: Set<string>;
  removed: StepRefPayload[];
  results: StepResultPayload[];
  running: Map<string, Msg<"step_running">>;
  costUsd: number;
  actions: number;
  recap: RunRecapPayload | null;
}

const HEADLINE: Record<string, string> = {
  completed: "Done. Here's what happened",
  stopped: "Stopped. Here's what got done",
  failed: "The run hit a problem",
  capped: "Stopped at the action limit",
};

/** Recap for runs with no `run_recap` event (legacy streams, or a daemon whose recap call failed). */
export function fallbackRecap(final: FinalResultPayload, results: StepResultPayload[], removed: StepRefPayload[]): RunRecapPayload {
  return {
    headline: HEADLINE[final.status] ?? final.message,
    done: results.filter((r) => r.status === "done").map((r) => ({ step_id: r.step_id, text: r.summary })),
    skipped: [
      ...removed.map((r) => ({ step_id: r.step_id, reason: "You left this step out." })),
      ...results.filter((r) => r.status !== "done").map((r) => ({ step_id: r.step_id, reason: r.summary })),
    ],
    source: "fallback",
  };
}

export function eventsToMessages(input: ChatInput): ChatMessage[] {
  const indexOf = new Map(input.steps.map((s) => [s.id, s.index]));
  const toIndexes = (ids: string[]) =>
    ids.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);

  const out: ChatMessage[] = [{ kind: "user", id: "user", text: input.prompt, attachments: input.attachments }];
  const drop = (m: ChatMessage) => {
    const i = out.indexOf(m);
    if (i >= 0) out.splice(i, 1);
  };

  let planning: Msg<"planning"> | null = null;
  let planned = false;
  let lastStage: PlanProgressPayload["stage"] | null = null;
  const runs = new Map<string, RunAcc>();

  const runFor = (ev: OversightEvent): RunAcc => {
    const id = ev.run_id as string;
    let r = runs.get(id);
    if (!r) {
      const started: Msg<"run_started"> = { kind: "run_started", id: `run-${ev.seq}`, approvedIndexes: [], skippedIndexes: [] };
      out.push(started);
      r = { startTs: ev.ts, started, skipped: new Set(), removed: [], results: [], running: new Map(), costUsd: 0, actions: 0, recap: null };
      runs.set(id, r);
    }
    return r;
  };

  for (const ev of input.events) {
    const p = ev.payload as unknown;

    if (ev.run_id === null) {
      if (ev.kind === "plan_progress") {
        const pp = p as PlanProgressPayload;
        lastStage = pp.stage;
        if (pp.stage === "planning" || pp.stage === "scoring") {
          if (planning) Object.assign(planning, { stage: pp.stage, message: pp.message, done: pp.done, total: pp.total });
          else {
            planning = { kind: "planning", id: `planning-${ev.seq}`, stage: pp.stage, message: pp.message, done: pp.done, total: pp.total };
            out.push(planning);
          }
        } else {
          if (planning) drop(planning);
          planning = null;
          if (pp.stage === "done" && !planned) {
            planned = true;
            out.push({ kind: "plan_ready", id: `plan-${ev.seq}`, stepCount: pp.total, revision: 0 });
          }
          if (pp.stage === "error") out.push({ kind: "plan_error", id: `plan-error-${ev.seq}`, error: pp.message });
        }
      } else if (ev.kind === "plan_revised") {
        const rv = p as PlanRevisedPayload;
        if (rv.instruction) out.push({ kind: "user", id: `user-${ev.seq}`, text: rv.instruction, attachments: [] });
        out.push({
          kind: "revised",
          id: `revised-${ev.seq}`,
          instruction: rv.instruction,
          changed: toIndexes(rv.changed_step_ids),
          added: toIndexes(rv.added_step_ids),
          dropped: rv.dropped_step_ids.length,
        });
      }
      continue;
    }

    const r = runFor(ev);
    switch (ev.kind) {
      case "step_removed": {
        const sr = p as StepRefPayload;
        r.skipped.add(sr.step_id);
        r.removed.push(sr);
        break;
      }
      case "step_started": {
        const sr = p as StepRefPayload;
        const m: Msg<"step_running"> = { kind: "step_running", id: `running-${ev.seq}`, stepId: sr.step_id, index: sr.index, title: sr.title };
        r.running.set(sr.step_id, m);
        out.push(m);
        break;
      }
      case "action":
        r.actions += 1;
        break;
      case "cost":
        r.costUsd += (p as CostPayload).usd_delta || 0;
        break;
      case "step_result": {
        const res = p as StepResultPayload;
        const running = r.running.get(res.step_id);
        if (running) drop(running);
        r.running.delete(res.step_id);
        r.results.push(res);
        out.push({
          kind: "step_done",
          id: `step-${ev.seq}`,
          stepId: res.step_id,
          index: res.index,
          status: res.status,
          summary: res.summary,
          actions: res.actions ?? null,
          durationMs: res.duration_ms ?? null,
        });
        if (res.status === "failed")
          out.push({ kind: "notice", id: `notice-${ev.seq}`, tone: "warn", text: `Step ${res.index} failed, so the steps after it did not run.` });
        break;
      }
      case "run_recap":
        r.recap = p as RunRecapPayload;
        break;
      case "final_result": {
        const f = p as FinalResultPayload;
        r.running.forEach(drop);
        r.running.clear();
        const ms = Date.parse(ev.ts) - Date.parse(r.startTs);
        out.push({
          kind: "recap",
          id: `recap-${ev.seq}`,
          recap: r.recap ?? fallbackRecap(f, r.results, r.removed),
          final: f,
          costUsd: Math.round(r.costUsd * 1e6) / 1e6,
          actions: r.actions,
          durationMs: Number.isFinite(ms) ? ms : null,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const r of runs.values()) {
    r.started.skippedIndexes = r.removed.map((x) => x.index).sort((a, b) => a - b);
    r.started.approvedIndexes = input.steps.filter((s) => !r.skipped.has(s.id)).map((s) => s.index).sort((a, b) => a - b);
  }

  if (input.planError && lastStage !== "error") out.push({ kind: "plan_error", id: "plan-error", error: input.planError });
  return out;
}
