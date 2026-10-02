// Wave 0 stub. Track U4 replaces this file; keep the exports and data-testids.
import { useMemo } from "react";
import { BoundaryCanvas } from "../canvas/BoundaryCanvas";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { pairKey } from "../lib/approval";
import type { ScreenProps } from "../screens";

export function ReviewScreen({ api, conn, session }: ScreenProps) {
  const { state, cls, counts, idx, canRun, actions } = session;
  const xDim = conn.dims.find((d) => d.key === state.axes.x);
  const yDim = conn.dims.find((d) => d.key === state.axes.y);
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: state.planError }),
    [state.prompt, state.attachments, state.steps, state.events, state.planError],
  );
  const live = state.steps.length - counts.removed;
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ width: "var(--chat-w)", borderRight: "1px solid var(--line)" }}>
        <ChatThread api={api} messages={messages} counts={counts} meta={null} events={state.events} steps={state.steps} onRetryPlan={() => void actions.retryPlan()} />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ flex: 1, minHeight: 300 }}>
          {state.phase === "review" && xDim && yDim && (
            <BoundaryCanvas steps={state.steps} idx={idx} xDim={xDim} yDim={yDim}
              polygon={state.polygons[pairKey(state.axes.x, state.axes.y)] ?? null} status={cls.status}
              selectedId={state.selectedId} hoveredId={null} onSelect={actions.select} onHover={() => undefined}
              onPolygonChange={actions.onPolygonChange} onApprove={(id) => actions.check(id, true, "fan_out")}
              onRemove={(id) => actions.remove(id, "fan_out")} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: 12 }}>
          <button data-testid="approve-all" onClick={actions.approveAll}>Approve all {live}</button>
          <button data-testid="run-primary" disabled={!canRun} onClick={() => void actions.run()}>Approve &amp; run</button>
        </div>
      </div>
    </div>
  );
}
