// Paper view: the source-video layout (docs/02) on the shared session store.
import { useMemo, useState } from "react";
import { DEFAULT_TASK } from "../api/fixtures";
import type { CostPayload, PlanProgressPayload } from "../api/types";
import type { ScreenProps } from "../screens";
import { ExecutionView } from "./ExecutionView";
import { Icon } from "./Glyph";
import { Header, Tabs, TaskCard } from "./Header";
import { OversightPanel } from "./OversightPanel";
import { PlanPanel } from "./PlanPanel";
import "./paper.css";

// Paper has no instruction box (docs/02). The daemon already sends the planner every
// approve/remove/edit decision; this sentence only asks it to respect them.
const PAPER_REPROPOSE = "Re-propose the plan, keeping my approved steps and leaving out the ones I removed.";

export function PaperView({ api, conn, session, setPaperView }: ScreenProps) {
  const { state, cls, counts, idx, canRun, actions } = session;
  const [draft, setDraft] = useState(DEFAULT_TASK);
  const [stopping, setStopping] = useState(false);

  const planProgress = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "plan_progress") return state.events[i].payload as unknown as PlanProgressPayload;
    return null;
  }, [state.events]);
  const cost = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "cost") return (state.events[i].payload as unknown as CostPayload).usd_total;
    return conn.health?.cost_usd_total ?? 0;
  }, [state.events, conn.health]);

  const phase = state.phase === "home" ? "idle" : state.phase === "planning" ? "planning" : "review";
  const indexOf = (id: string) => state.steps.find((s) => s.id === id)?.index ?? id;
  const runErr = state.runError;

  return (
    <div className="paper-root">
      <div className={`app${api.mode === "mock" ? " is-mock" : ""}`}>
        <Header
          health={conn.health}
          mode={api.mode}
          reachable={conn.reachable}
          cost={cost}
          right={
            <button className="btn btn-small" data-testid="paper-exit" onClick={() => setPaperView(false)}>
              Exit Paper view
            </button>
          }
        />
        {state.notice && (
          <div className="notice" role="status">
            {state.notice}
            <button className="link-btn" onClick={actions.dismissNotice}>Dismiss</button>
          </div>
        )}
        {(state.phase === "running" || state.phase === "done") && state.run ? (
          <div className="exec-scroll">
            <ExecutionView steps={state.steps} approvedIds={state.run.approvedIds} removedIds={state.run.removedIds} runId={state.run.runId}
              events={state.events} idx={idx} dims={conn.dims}
              onStop={() => { setStopping(true); void actions.stop(); }}
              onNewTask={() => { setStopping(false); actions.newTask(); }} stopping={stopping} />
          </div>
        ) : (
          <>
            <div className="top">
              <Tabs />
              <TaskCard prompt={state.phase === "home" ? draft : state.prompt} setPrompt={setDraft} editable={state.phase === "home"}
                phase={phase} progress={planProgress} error={state.planError} onGenerate={() => void actions.submit(draft, [])} />
            </div>
            {state.phase === "review" && conn.dims.length > 0 && (
              <>
                <main className="columns">
                  <div className="col col-left">
                    <OversightPanel dims={conn.dims} steps={state.steps} idx={idx} xKey={state.axes.x} yKey={state.axes.y}
                      setAxes={actions.setAxes} polygons={state.polygons} status={cls.status} counts={counts}
                      selectedId={state.selectedId} onSelect={actions.select} onPolygonChange={actions.onPolygonChange} />
                  </div>
                  <div className="col col-right">
                    <PlanPanel steps={state.steps} status={cls.status} checked={state.checked} inside={cls.inside}
                      selectedId={state.selectedId} onSelect={actions.select}
                      onCheck={(id, on) => actions.check(id, on, "plan_panel")} onRemove={(id) => actions.remove(id, "plan_panel")}
                      onRestore={(id) => actions.restore(id, "plan_panel")} onSelectAll={actions.approveAll}
                      onEdit={(id, patch) => void actions.editStep(id, patch)} />
                  </div>
                </main>
                <footer className="footer">
                  {runErr && (
                    <div className="run-error" role="alert" data-testid="run-error">
                      <b>{runErr.status === 409 ? "409 Conflict, nothing ran." : `Run failed (${runErr.status || "network"}).`}</b> {runErr.error}
                      {runErr.expected && (
                        <span className="mono"> expected [{runErr.expected.map(indexOf).join(", ")}] got [{(runErr.got ?? []).map(indexOf).join(", ")}]</span>
                      )}
                    </div>
                  )}
                  <div className="footer-row">
                    <button className="btn" data-testid="start-over" onClick={actions.newTask}>Start over</button>
                    <div className="footer-right">
                      <button
                        className="btn"
                        data-testid="repropose"
                        disabled={state.busy !== null}
                        onClick={() => void actions.revise(PAPER_REPROPOSE)}
                      >
                        {Icon.refresh(13)} {state.busy === "revising" ? "Re-proposing..." : "Re-propose plan"}
                      </button>
                      <button className="btn btn-primary" data-testid="approve-run" disabled={!canRun} onClick={() => void actions.run()}>
                        {Icon.play(11)} {state.busy === "starting_run" ? "Starting..." : "Approve & Run"}
                      </button>
                    </div>
                  </div>
                  {!canRun && <div className="hint">Select all actions (draw a region or check them) to enable Approve &amp; Run.</div>}
                </footer>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
