// Review: chat left (revise by typing), workspace right (axes, canvas, steps, action bar).
import { useMemo, useState } from "react";
import type { CostPayload, OversightEvent, PlanProgressPayload } from "../api/types";
import type { ChatMessage } from "../chat/types";
import { BoundaryCanvas } from "../canvas/BoundaryCanvas";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { Composer } from "../home/Composer";
import { pairKey } from "../lib/approval";
import type { ScreenProps } from "../screens";
import { ActionBar } from "./ActionBar";
import { AxisPicker } from "./AxisPicker";
import s from "./ReviewScreen.module.css";
import { StepList } from "./StepList";

/** "model · planned + scored in 9.4s · $0.11", from the first planning session's events. */
function planMeta(events: OversightEvent[], model: string | null): string | null {
  let start: number | null = null;
  let end: number | null = null;
  let cost = 0;
  for (const e of events) {
    if (e.run_id !== null) continue;
    if (e.kind === "plan_progress") {
      const p = e.payload as unknown as PlanProgressPayload;
      if (start === null) start = Date.parse(e.ts);
      if (p.stage === "done" && end === null) end = Date.parse(e.ts);
    } else if (e.kind === "cost") cost = (e.payload as unknown as CostPayload).usd_total;
  }
  if (start === null || end === null) return null;
  return [model, `planned + scored in ${((end - start) / 1000).toFixed(1)}s`, `$${cost.toFixed(2)}`].filter(Boolean).join(" · ");
}

/** Attach the failed instruction to that attempt's streamed revise error (so it gets Try
 *  again), or add the error when the request failed before the daemon streamed one. */
function withReviseFailure(messages: ChatMessage[], fail: { instruction: string; error: string; afterSeq: number } | null): ChatMessage[] {
  if (!fail) return messages;
  let i = messages.length - 1;
  while (i >= 0 && !(messages[i].kind === "revise_error" && ((messages[i] as { seq: number | null }).seq ?? -1) > fail.afterSeq)) i--;
  if (i >= 0) return messages.map((m, j) => (j === i ? { ...m, instruction: fail.instruction } as ChatMessage : m));
  return [...messages, { kind: "revise_error", id: `revise-error-local-${fail.afterSeq}`, seq: null, error: fail.error, instruction: fail.instruction }];
}

export function ReviewScreen(props: ScreenProps) {
  const { api, conn, session, setPaperView, openSetup } = props;
  const { state, cls, counts, idx, actions } = session;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The last revise that failed: its instruction (for Try again) and why. `afterSeq` is the
  // stream position when it was sent, so only that attempt's streamed error picks it up.
  const [reviseFail, setReviseFail] = useState<{ instruction: string; error: string; afterSeq: number } | null>(null);

  const streamed = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: state.planError }),
    [state.prompt, state.attachments, state.steps, state.events, state.planError],
  );
  const messages = useMemo(() => withReviseFailure(streamed, reviseFail), [streamed, reviseFail]);

  const sendRevise = (instruction: string) => {
    const afterSeq = state.events.length ? state.events[state.events.length - 1].seq : 0;
    setReviseFail(null);
    // Keep the draft until the daemon has the revision, so a failure loses nothing.
    void actions.revise(instruction, (error) => setReviseFail({ instruction, error, afterSeq })).then((ok) => {
      if (ok) setDraft((d) => (d === instruction ? "" : d));
      else setDraft((d) => (d.trim() ? d : instruction));
    });
  };
  const meta = useMemo(() => planMeta(state.events, conn.health?.model ?? null), [state.events, conn.health?.model]);
  const progress = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "plan_progress") return state.events[i].payload as unknown as PlanProgressPayload;
    return null;
  }, [state.events]);

  const xDim = conn.dims.find((d) => d.key === state.axes.x);
  const yDim = conn.dims.find((d) => d.key === state.axes.y);
  const reviewing = state.phase === "review";
  const disabledReason =
    state.phase === "planning" ? "Wait for the plan to finish." :
    state.busy === "revising" ? "Revising the plan…" :
    state.busy === "starting_run" ? "Starting the run…" : null;

  return (
    <div className={s.screen}>
      <section className={s.chat}>
        <ChatThread api={api} messages={messages} counts={reviewing ? counts : null} meta={meta} events={state.events}
          steps={state.steps} onRetryPlan={() => void actions.retryPlan()} onRetryRevise={sendRevise} />
        <div className={s.dock}>
          <Composer api={api} value={draft} onChange={setDraft} attachments={[]} onAttachmentsChange={() => undefined}
            allowAttachments={false} providerLabel={conn.health?.provider === "openai" ? "OpenAI" : "Anthropic"}
            placeholder="Reply, or ask me to change a step…" size="dock" disabledReason={disabledReason} running={false}
            onSend={() => sendRevise(draft)} />
        </div>
      </section>

      <section className={s.workspace}>
        <header className={s.head}>
          <span className={s.title}>Plan review</span>
          {conn.dims.length > 0 && <AxisPicker dims={conn.dims} x={state.axes.x} y={state.axes.y} onChange={actions.setAxes} />}
          <div className={s.seg}>
            <button className={s.segOn} aria-pressed="true">Grid</button>
            <button data-testid="paper-toggle" onClick={() => setPaperView(true)}>Paper view</button>
          </div>
        </header>

        <div className={s.canvas}>
          {reviewing && xDim && yDim ? (
            <BoundaryCanvas steps={state.steps} idx={idx} xDim={xDim} yDim={yDim}
              polygon={state.polygons[pairKey(state.axes.x, state.axes.y)] ?? null} status={cls.status}
              selectedId={state.selectedId} hoveredId={hoveredId} onSelect={actions.select} onHover={setHoveredId}
              onPolygonChange={actions.onPolygonChange} onApprove={(id) => actions.check(id, true, "fan_out")}
              onRemove={(id) => actions.remove(id, "fan_out")} />
          ) : state.phase === "planning" && !state.planError ? (
            <div className={s.preparing} data-testid="planning-panel">
              <span className={s.spinner} />
              <div>
                <div className={s.prepTitle}>{progress?.stage === "scoring" ? "Preparing oversight view…" : "Planning…"}</div>
                <div className={s.prepSub}>Scoring actions and placing them on the grid.</div>
                {progress && progress.total > 0 && (
                  <div className={s.bar}><i style={{ width: `${(100 * progress.done) / progress.total}%` }} /></div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {reviewing && (
          <>
            <StepList session={session} hoveredId={hoveredId} onHover={setHoveredId} />
            <ActionBar session={session} conn={conn} openSetup={openSetup} />
          </>
        )}
      </section>
    </div>
  );
}
