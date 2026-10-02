// The chat column (track U2): reads like an AI chat, never like a log. The full log
// lives only behind the recap card's Details.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { Counts } from "../state/useSession";
import s from "./ChatThread.module.css";
import { formatEvent } from "./formatEvent";
import type { ChatMessage } from "./types";

export interface ChatThreadProps {
  api: DaemonApi;
  messages: ChatMessage[];
  counts: Counts | null;
  meta: string | null;
  events: OversightEvent[];
  steps: Step[];
  onRetryPlan?: () => void;
  /** Re-sends a failed revise; shown on revise errors that carry their instruction. */
  onRetryRevise?: (instruction: string) => void;
}

type Msg<K extends ChatMessage["kind"]> = Extract<ChatMessage, { kind: K }>;

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const list = (xs: number[]) => xs.join(", ");

export function ChatThread({ api, messages, counts, meta, events, steps, onRetryPlan, onRetryRevise }: ChatThreadProps) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new messages unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  let lastPlan = -1;
  messages.forEach((m, i) => {
    if (m.kind === "plan_ready") lastPlan = i;
  });
  const indexOf = useMemo(() => new Map(steps.map((x) => [x.id, x.index])), [steps]);

  return (
    <div
      ref={box}
      className={s.thread}
      data-testid="chat-thread"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {messages.map((m, i) => {
        switch (m.kind) {
          case "user":
            return <UserBubble key={m.id} m={m} api={api} />;
          case "planning":
            return (
              <div key={m.id} className={s.progress} data-testid="chat-planning">
                <span className={s.spinner} />
                {m.stage === "planning" ? "Planning the steps…" : `Scoring actions and placing them on the grid (${m.done}/${m.total})…`}
              </div>
            );
          case "plan_ready":
            return <PlanReady key={m.id} m={m} counts={i === lastPlan ? counts : null} meta={i === lastPlan ? meta : null} />;
          case "plan_error":
            return (
              <div key={m.id} className={s.error} data-testid="chat-plan-error">
                {m.error}
                {onRetryPlan && (
                  <button className={s.btn} data-testid="chat-retry" onClick={onRetryPlan}>
                    Try again
                  </button>
                )}
              </div>
            );
          case "revise_error":
            return (
              <div key={m.id} className={s.error} data-testid="chat-revise-error">
                I couldn't revise the plan: {m.error}
                {m.instruction !== null && " Your message is back in the box, and the plan is unchanged."}
                {m.instruction !== null && onRetryRevise && (
                  <button className={s.btn} data-testid="chat-revise-retry" onClick={() => onRetryRevise(m.instruction!)}>
                    Try again
                  </button>
                )}
              </div>
            );
          case "revised":
            return (
              <div key={m.id} className={s.assistant} data-testid="chat-revised">
                {revisedText(m)}
              </div>
            );
          case "run_started":
            return (
              <div key={m.id} className={s.muted} data-testid="chat-run-started">
                Plan approved: steps {list(m.approvedIndexes)}
                {m.skippedIndexes.length > 0 && ` · skipped ${list(m.skippedIndexes)}`}
              </div>
            );
          case "step_running":
            return (
              <div key={m.id} className={s.progress} data-testid="chat-step-running">
                <span className={s.spinner} />
                {m.title}…
              </div>
            );
          case "step_done":
            return <StepRow key={m.id} m={m} />;
          case "recap":
            return <RecapCard key={m.id} m={m} events={events} indexOf={indexOf} />;
          case "notice":
            return (
              <div key={m.id} className={`${s.notice} ${m.tone !== "info" ? s.warn : ""}`} data-testid="chat-notice">
                {m.text}
              </div>
            );
        }
      })}
    </div>
  );
}

function UserBubble({ m, api }: { m: Msg<"user">; api: DaemonApi }) {
  return (
    <div className={s.user} data-testid="chat-msg-user">
      {m.attachments.length > 0 && (
        <div className={s.thumbs}>
          {m.attachments.map((a) => (
            <img key={a.attachment_id} className={s.thumb} src={api.attachmentUrl(a.attachment_id)} alt="Attached image" />
          ))}
        </div>
      )}
      {m.text}
    </div>
  );
}

function PlanReady({ m, counts, meta }: { m: Msg<"plan_ready">; counts: Counts | null; meta: string | null }) {
  return (
    <div className={s.assistant} data-testid="chat-plan-ready">
      I'd do this in <b>{m.stepCount} steps</b> and placed them on the grid. <b>Drag a loop around the ones you're OK with</b>; anything
      outside the loop still needs your call.
      {counts && (
        <div className={s.chips}>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.ok}`} />
            {counts.approved} approved
          </span>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.pend}`} />
            {counts.pending} need a decision
          </span>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.rm}`} />
            {counts.removed} removed
          </span>
        </div>
      )}
      {meta && <div className={s.meta}>{meta}</div>}
    </div>
  );
}

function revisedText(m: Msg<"revised">): string {
  const parts: string[] = [];
  if (m.changed.length) parts.push(`changed step${m.changed.length > 1 ? "s" : ""} ${list(m.changed)}`);
  if (m.added.length) parts.push(`added step${m.added.length > 1 ? "s" : ""} ${list(m.added)}`);
  if (m.dropped) parts.push(`dropped ${m.dropped} step${m.dropped > 1 ? "s" : ""}`);
  return parts.length ? `Updated the plan: ${parts.join("; ")}.` : "Revised the plan; no steps changed.";
}

function StepRow({ m }: { m: Msg<"step_done"> }) {
  const mark = m.status === "done" ? "✓" : m.status === "failed" ? "✗" : m.status === "stopped" ? "■" : "–";
  const cls = m.status === "done" ? s.markDone : m.status === "failed" ? s.markFailed : s.markOther;
  const meta = [`step ${m.index}`, m.actions !== null ? `${m.actions} actions` : null, m.durationMs !== null ? secs(m.durationMs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={s.step} data-testid="chat-msg-step" data-status={m.status}>
      <span className={`${s.mark} ${cls}`}>{mark}</span>
      <div>
        {m.summary}
        <div className={s.meta}>{meta}</div>
      </div>
    </div>
  );
}

function RecapCard({ m, events, indexOf }: { m: Msg<"recap">; events: OversightEvent[]; indexOf: Map<string, number> }) {
  const [open, setOpen] = useState(false);
  const label = (id: string) => (indexOf.has(id) ? `Step ${indexOf.get(id)}: ` : "");
  const summary = [`${m.actions} actions`, m.durationMs !== null ? secs(m.durationMs) : null, `$${m.costUsd.toFixed(2)}`].filter(Boolean).join(" · ");
  return (
    <div className={s.recap} data-testid="chat-recap" data-status={m.final?.status ?? ""}>
      <h4>{m.recap.headline}</h4>
      {m.recap.done.map((d) => (
        <div key={`d-${d.step_id}`} className={s.li}>
          <span className={s.liDone}>✓</span>
          <span>
            {label(d.step_id)}
            {d.text}
          </span>
        </div>
      ))}
      {m.recap.skipped.map((d) => (
        <div key={`s-${d.step_id}`} className={s.li}>
          <span className={s.liSkip}>–</span>
          <span>
            {label(d.step_id)}
            {d.reason}
          </span>
        </div>
      ))}
      <div className={s.details}>
        <button className={s.linkBtn} data-testid="chat-recap-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Details: {summary}
        </button>
        {open && (
          <pre className={s.log} data-testid="chat-recap-log">
            {events
              .filter((e) => e.run_id !== null)
              .map(formatEvent)
              .join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
