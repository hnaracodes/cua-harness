import { useEffect, useMemo, useState } from "react";
import type {
  ActionPayload,
  ConsiderationScoredPayload,
  CostPayload,
  Dimension,
  FinalResultPayload,
  OversightEvent,
  PlanProgressPayload,
  Step,
  StepRefPayload,
  StepResultPayload,
} from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import { Icon } from "./Glyph";
import { WhyThisMattered } from "./WhyThisMattered";

// Execution view, driven entirely by the SSE event stream. Original step
// indices are preserved (1, 2, 4 with 3 removed); nothing is renumbered.

interface Props {
  steps: Step[];
  approvedIds: string[];
  removedIds: string[];
  runId: string;
  events: OversightEvent[];
  idx: ScoreIndex;
  dims: Dimension[];
  onStop: () => void;
  onNewTask: () => void;
  stopping: boolean;
}

type StepRun = "queued" | "running" | "done" | "failed" | "stopped" | "skipped";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function ExecutionView(p: Props) {
  const runEvents = useMemo(() => p.events.filter((e) => e.run_id === p.runId), [p.events, p.runId]);
  const byId = useMemo(() => new Map(p.steps.map((s) => [s.id, s])), [p.steps]);

  const { stepRun, final, removedFromStream, costTotal, runStart } = useMemo(() => {
    const stepRun: Record<string, StepRun> = {};
    let final: FinalResultPayload | null = null;
    const removedFromStream: string[] = [];
    let costTotal = 0;
    let runStart: number | null = null;
    for (const e of runEvents) {
      if (runStart === null) runStart = Date.parse(e.ts);
      if (e.kind === "step_started") stepRun[(e.payload as unknown as StepRefPayload).step_id] = "running";
      else if (e.kind === "step_result") {
        const r = e.payload as unknown as StepResultPayload;
        stepRun[r.step_id] = r.status;
      } else if (e.kind === "final_result") final = e.payload as unknown as FinalResultPayload;
      else if (e.kind === "step_removed") removedFromStream.push((e.payload as unknown as StepRefPayload).step_id);
    }
    for (const e of p.events) if (e.kind === "cost") costTotal = (e.payload as unknown as CostPayload).usd_total;
    return { stepRun, final: final as FinalResultPayload | null, removedFromStream, costTotal, runStart };
  }, [runEvents, p.events]);

  const running = !final;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const endTs = final ? Date.parse(runEvents[runEvents.length - 1]?.ts ?? new Date().toISOString()) : now;
  const elapsed = runStart ? endTs - runStart : 0;

  const [logOpen, setLogOpen] = useState<boolean | null>(null);
  const open = logOpen ?? running; // expanded while running, collapses at the end unless toggled

  const approvedSteps = p.approvedIds.map((id) => byId.get(id)).filter(Boolean) as Step[];
  const removedIds = removedFromStream.length ? removedFromStream : p.removedIds;
  const removedSteps = removedIds.map((id) => byId.get(id)).filter(Boolean) as Step[];

  return (
    <div className="exec" data-testid="execution-view">
      <section>
        <h2 className="panel-title">Plan progress</h2>
        <ul className="progress" data-testid="plan-progress">
          {approvedSteps.map((s) => {
            const st = stepRun[s.id] ?? (final ? "skipped" : "queued");
            return (
              <li key={s.id} className={`pr pr-${st}`} data-testid={`progress-${s.index}`} data-state={st}>
                <ProgressIcon st={st} />
                <span>
                  {s.index}. {s.title}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="exec-actions">
          {running ? (
            <>
              <button className="btn" data-testid="stop" onClick={p.onStop} disabled={p.stopping}>
                {Icon.stop(10)} {p.stopping ? "Stopping" : "Stop"}
              </button>
              <span className="spinner" aria-label="Running" />
            </>
          ) : (
            <button className="btn btn-primary" data-testid="new-task" onClick={p.onNewTask}>
              New task
            </button>
          )}
        </div>
      </section>

      {removedSteps.length > 0 && (
        <div className="block removed-block" data-testid="removed-action">
          <div className="block-label">Removed action</div>
          {removedSteps.map((s) => (
            <div key={s.id} className="removed-line">
              <span className="red">{Icon.xCircleFilled(15)}</span>
              <s>{s.title}</s>
            </div>
          ))}
          <div className="block-label" style={{ marginTop: 10 }}>
            Task continued with
          </div>
          <div className="continued">
            {Icon.arrowRight(12)} Remaining steps in the plan
          </div>
        </div>
      )}

      {final && (
        <div className={`block final final-${final.status}`} data-testid="final-result">
          <div className="block-label">
            {Icon.flag(12)} Final result
          </div>
          <div className="final-msg">{final.message}</div>
        </div>
      )}

      {final && <WhyThisMattered removed={removedSteps} approved={approvedSteps} idx={p.idx} dims={p.dims} />}

      <section className="log">
        <button className="log-toggle" data-testid="log-toggle" onClick={() => setLogOpen(!open)} aria-expanded={open}>
          <span className={`chev${open ? " open" : ""}`}>{Icon.chevron(11)}</span>
          <span className="panel-title">Proposed actions and results</span>
          <span className="log-meta mono">
            {mmss(elapsed)} · ${costTotal.toFixed(4)}
          </span>
        </button>
        {open && <LogEntries events={p.events} runId={p.runId} byId={byId} approvedCount={approvedSteps.length} now={now} final={!!final} />}
      </section>
    </div>
  );
}

function ProgressIcon({ st }: { st: StepRun }) {
  if (st === "running") return <span className="spinner small" aria-label="running" />;
  if (st === "done") return <span className="green">{Icon.checkCircle(14)}</span>;
  if (st === "failed") return <span className="red">{Icon.xCircleFilled(14)}</span>;
  if (st === "stopped" || st === "skipped") return <span className="muted">{Icon.minusCircle(14)}</span>;
  return <span className="ring" />;
}

interface Entry {
  key: string;
  title: string;
  detail: string;
  t: number;
  tone?: "ok" | "bad" | "muted";
  chip?: string;
  live?: boolean;
}

function LogEntries({
  events,
  runId,
  byId,
  approvedCount,
  now,
  final,
}: {
  events: OversightEvent[];
  runId: string;
  byId: Map<string, Step>;
  approvedCount: number;
  now: number;
  final: boolean;
}) {
  const entries = useMemo(() => {
    const out: Entry[] = [];
    if (!events.length) return out;
    const t0 = Date.parse(events[0].ts);
    let stepN = 0;
    for (const e of events) {
      if (e.run_id !== null && e.run_id !== runId) continue;
      const t = Date.parse(e.ts) - t0;
      const k = `${e.seq}`;
      switch (e.kind) {
        case "plan_progress": {
          const pp = e.payload as unknown as PlanProgressPayload;
          if (pp.stage === "planning") out.push({ key: k, title: "Planning", detail: pp.message, t });
          else if (pp.stage === "done") {
            out.push({ key: k + "s", title: "Considerations scored", detail: `Labelled ${pp.total} step(s) with consideration values.`, t });
            out.push({ key: k, title: "Plan ready", detail: pp.message, t });
          } else if (pp.stage === "error") out.push({ key: k, title: "Planning failed", detail: pp.message, t, tone: "bad" });
          break;
        }
        case "consideration_scored": {
          const c = e.payload as unknown as ConsiderationScoredPayload;
          out.push({ key: k + "c", title: "Considerations scored", detail: `Labelled ${c.step_count} step(s) with consideration values.`, t });
          out.push({ key: k, title: "Executing plan", detail: `${c.approved_count} approved step(s).`, t, live: !final });
          break;
        }
        case "step_removed": {
          const r = e.payload as unknown as StepRefPayload;
          out.push({ key: k, title: "Removed by oversight", detail: `${r.index}. ${r.title}`, t, tone: "muted" });
          break;
        }
        case "step_started": {
          stepN += 1;
          const r = e.payload as unknown as StepRefPayload;
          out.push({ key: k, title: `Step ${stepN}/${approvedCount}`, detail: r.title, t });
          break;
        }
        case "action": {
          const a = e.payload as unknown as ActionPayload;
          const s = byId.get(a.step_id);
          out.push({
            key: k,
            title: `Action ${a.n} · ${a.verb}${s ? ` (step ${s.index})` : ""}`,
            detail: `${a.target}: ${a.detail}${a.error ? ` Error: ${a.error}` : ""}`,
            t,
            tone: a.ok ? undefined : "bad",
            chip: a.mode,
          });
          break;
        }
        case "step_result": {
          const r = e.payload as unknown as StepResultPayload;
          out.push({
            key: k,
            title: `Result, step ${r.index}: ${r.status}`,
            detail: r.summary,
            t,
            tone: r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "muted",
          });
          break;
        }
        case "cost": {
          const c = e.payload as unknown as CostPayload;
          if (c.scope === "plan")
            out.push({ key: k, title: "Running cost", detail: `$${c.usd_total.toFixed(4)} (planner ${c.model}, ${c.latency_ms} ms, ${c.input_tokens}+${c.output_tokens} tokens)`, t, tone: "muted" });
          break;
        }
        case "final_result": {
          const f = e.payload as unknown as FinalResultPayload;
          out.push({ key: k, title: "Final result", detail: f.message, t, tone: f.status === "completed" ? "ok" : "bad" });
          break;
        }
        default:
          break;
      }
    }
    return out.reverse(); // newest first, as in the source
  }, [events, runId, byId, approvedCount, final]);

  const last = events.length ? Date.parse(events[0].ts) : now;
  return (
    <div className="log-list" data-testid="log-list">
      {entries.map((en) => (
        <div key={en.key} className={`log-entry${en.tone ? " tone-" + en.tone : ""}`}>
          <div className="log-row">
            <span className="log-title">
              {Icon.info(11)} {en.title}
              {en.chip && <span className="chip mono">{en.chip}</span>}
            </span>
            <span className="log-time mono">{mmss(en.live ? now - last : en.t)}</span>
          </div>
          <div className="log-detail">{en.detail}</div>
        </div>
      ))}
    </div>
  );
}
