import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectDaemon, type DaemonApi } from "./api/client";
import { DEFAULT_TASK } from "./api/fixtures";
import type {
  CostPayload,
  DecisionAction,
  Dimension,
  Health,
  OversightEvent,
  PlanProgressPayload,
  Point,
  RunBody,
  Score,
  Step,
} from "./api/types";
import { classify, indexScores, pairKey, splitPairKey, type Classification, type PolygonMap } from "./lib/approval";
import { setAlwaysOnTop } from "./lib/tauri";
import { ExecutionView } from "./components/ExecutionView";
import { Icon } from "./components/Glyph";
import { Header, Tabs, TaskCard } from "./components/Header";
import { OversightPanel } from "./components/OversightPanel";
import { PlanPanel } from "./components/PlanPanel";

type Phase = "idle" | "planning" | "review" | "executing";

interface RunState {
  runId: string;
  approvedIds: string[];
  removedIds: string[];
}

interface RunError {
  status: number;
  error: string;
  expected?: string[];
  got?: string[];
}

const EMPTY: ReadonlySet<string> = new Set();

export default function App() {
  const [api, setApi] = useState<DaemonApi | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState(true);
  const [dims, setDims] = useState<Dimension[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [prompt, setPrompt] = useState(DEFAULT_TASK);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [scores, setScores] = useState<Score[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);

  const [axes, setAxesState] = useState({ x: "action_uncertainty", y: "reversibility" });
  const [polygons, setPolygons] = useState<PolygonMap>({});
  const [checked, setChecked] = useState<ReadonlySet<string>>(EMPTY);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [events, setEvents] = useState<OversightEvent[]>([]);
  const [run, setRun] = useState<RunState | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- daemon connection, health, dimensions -------------------------------
  useEffect(() => {
    let alive = true;
    connectDaemon().then(async (a) => {
      if (!alive) return;
      setApi(a);
      try {
        setDims(await a.dimensions());
      } catch (e) {
        setNotice(`GET /dimensions failed: ${(e as Error).message}`);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        setHealth(h);
        setReachable(true);
      } catch {
        if (alive) setReachable(false);
      }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api]);

  // ---- event stream for the current task ----------------------------------
  useEffect(() => {
    if (!api || !taskId) return;
    setEvents([]);
    return api.subscribe(taskId, 0, (ev) => setEvents((prev) => (prev.length && prev[prev.length - 1].seq >= ev.seq ? prev : [...prev, ev])));
  }, [api, taskId]);

  const planProgress = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "plan_progress") return events[i].payload as unknown as PlanProgressPayload;
    return null;
  }, [events]);

  const cost = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "cost") return (events[i].payload as unknown as CostPayload).usd_total;
    return health?.cost_usd_total ?? 0;
  }, [events, health]);

  // ---- classification: live, same frame as the pointer ---------------------
  const idx = useMemo(() => indexScores(scores), [scores]);
  const raw = useMemo(() => classify(steps, idx, polygons, checked, removed), [steps, idx, polygons, checked, removed]);
  // Keep the object identity stable while the result is unchanged so the plan
  // panel does not re-render on every pointermove of a drag.
  const stableRef = useRef<{ cls: Classification; steps: Step[] }>({ cls: raw, steps });
  if (stableRef.current.steps !== steps || stableRef.current.cls.signature !== raw.signature) {
    stableRef.current = { cls: raw, steps };
  }
  const cls = stableRef.current.cls;
  const counts = useMemo(() => ({ approved: cls.approved, pending: cls.pending, removed: cls.removed }), [cls]);

  // ---- boundary persistence (debounced PUT per axis pair) ------------------
  const axesRef = useRef(axes);
  axesRef.current = axes;
  const taskRef = useRef(taskId);
  taskRef.current = taskId;
  const apiRef = useRef(api);
  apiRef.current = api;
  const putTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const schedulePut = useCallback((k: string, poly: Point[] | null) => {
    clearTimeout(putTimers.current[k]);
    putTimers.current[k] = setTimeout(() => {
      const a = apiRef.current;
      const t = taskRef.current;
      if (!a || !t) return;
      const [x_dim, y_dim] = splitPairKey(k);
      a.putBoundary(t, { x_dim, y_dim, polygon: poly && poly.length >= 3 ? poly : [] }).catch((e) =>
        setNotice(`PUT /boundary failed: ${(e as Error).message}`),
      );
    }, 250);
  }, []);

  const onPolygonChange = useCallback(
    (poly: Point[] | null, final: boolean) => {
      const k = pairKey(axesRef.current.x, axesRef.current.y);
      setPolygons((prev) => {
        const next = { ...prev };
        if (poly && poly.length) next[k] = poly;
        else delete next[k];
        return next;
      });
      if (final) schedulePut(k, poly);
    },
    [schedulePut],
  );

  const setAxes = useCallback((x: string, y: string) => setAxesState({ x, y }), []);

  // ---- decisions ------------------------------------------------------------
  const decide = useCallback((step_id: string, action: DecisionAction) => {
    const a = apiRef.current;
    const t = taskRef.current;
    if (!a || !t) return;
    a.decision(t, { step_id, action, source: "plan_panel" }).catch((e) => setNotice(`POST /decision failed: ${(e as Error).message}`));
  }, []);

  const onCheck = useCallback(
    (id: string, on: boolean) => {
      setChecked((prev) => {
        const n = new Set(prev);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
      decide(id, on ? "check" : "uncheck");
      setRunError(null);
    },
    [decide],
  );
  const onRemove = useCallback(
    (id: string) => {
      setRemoved((prev) => new Set(prev).add(id));
      setChecked((prev) => {
        if (!prev.has(id)) return prev;
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      decide(id, "remove");
      setRunError(null);
    },
    [decide],
  );
  const onRestore = useCallback(
    (id: string) => {
      setRemoved((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      decide(id, "restore");
    },
    [decide],
  );
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const removedRef = useRef(removed);
  removedRef.current = removed;
  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  const onSelectAll = useCallback(() => {
    const toCheck = stepsRef.current.filter((s) => !removedRef.current.has(s.id) && !checkedRef.current.has(s.id));
    if (!toCheck.length) return;
    setChecked((prev) => {
      const n = new Set(prev);
      toCheck.forEach((s) => n.add(s.id));
      return n;
    });
    toCheck.forEach((s) => decide(s.id, "check"));
  }, [decide]);

  // ---- plan ---------------------------------------------------------------
  const resetReview = () => {
    setSteps([]);
    setScores([]);
    setPolygons({});
    setChecked(EMPTY);
    setRemoved(EMPTY);
    setSelectedId(null);
    setRun(null);
    setRunError(null);
    setStopping(false);
  };

  const generate = async () => {
    if (!api || !prompt.trim()) return;
    resetReview();
    setPlanError(null);
    setPhase("planning");
    try {
      const { task_id } = await api.createTask(prompt.trim(), null);
      setTaskId(task_id);
      // Let the subscription attach before planning so plan_progress streams in.
      await new Promise((r) => setTimeout(r, 30));
      const plan = await api.plan(task_id);
      setSteps([...plan.steps].sort((a, b) => a.index - b.index));
      setScores(plan.scores);
      setPhase("review");
    } catch (e) {
      setPlanError(`Planning failed: ${(e as Error).message}`);
      setPhase("idle");
    }
  };

  const startOver = () => {
    resetReview();
    setTaskId(null);
    setEvents([]);
    setPhase("idle");
  };

  // ---- run ----------------------------------------------------------------
  const canRun = phase === "review" && steps.length > 0 && cls.pending === 0 && cls.approved > 0 && !submitting;

  const approveAndRun = async () => {
    if (!api || !taskId || !canRun) return;
    const approved = steps.filter((s) => cls.status[s.id] === "approved").map((s) => s.id);
    const body: RunBody = {
      approved_step_ids: approved,
      checked_step_ids: [...checked].filter((id) => !removed.has(id)),
      removed_step_ids: [...removed],
      boundaries: Object.entries(polygons)
        .filter(([, p]) => p.length >= 3)
        .map(([k, polygon]) => {
          const [x_dim, y_dim] = splitPairKey(k);
          return { x_dim, y_dim, polygon };
        }),
    };
    setSubmitting(true);
    setRunError(null);
    const r = await api.run(taskId, body);
    setSubmitting(false);
    if (r.ok) {
      setRun({ runId: r.run_id, approvedIds: approved, removedIds: body.removed_step_ids });
      setPhase("executing");
    } else {
      setRunError({ status: r.status, error: r.error, expected: r.expected, got: r.got });
    }
  };

  const stop = async () => {
    if (!api || !taskId) return;
    setStopping(true);
    try {
      await api.stop(taskId);
    } catch (e) {
      setNotice(`POST /stop failed: ${(e as Error).message}`);
      setStopping(false);
    }
  };

  const runFinished = useMemo(() => !!run && events.some((e) => e.kind === "final_result" && e.run_id === run.runId), [events, run]);

  // Float above the agent's desk while it works (Tauri only, guarded).
  useEffect(() => {
    void setAlwaysOnTop(phase === "executing" && !runFinished);
  }, [phase, runFinished]);

  const indexOf = (id: string) => steps.find((s) => s.id === id)?.index ?? id;
  const ready = dims.length > 0;

  return (
    <div className={`app${api?.mode === "mock" ? " is-mock" : ""}`}>
      <Header health={health} mode={api?.mode ?? null} reachable={reachable} cost={cost} />
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {phase === "executing" && run ? (
        <div className="exec-scroll">
          <ExecutionView
            steps={steps}
            approvedIds={run.approvedIds}
            removedIds={run.removedIds}
            runId={run.runId}
            events={events}
            idx={idx}
            dims={dims}
            onStop={stop}
            onNewTask={startOver}
            stopping={stopping}
          />
        </div>
      ) : (
        <>
          <div className="top">
            <Tabs />
            <TaskCard
              prompt={prompt}
              setPrompt={setPrompt}
              editable={phase === "idle"}
              phase={phase === "executing" ? "review" : phase}
              progress={planProgress}
              error={planError}
              onGenerate={generate}
            />
          </div>

          {phase === "review" && ready && (
            <>
              <main className="columns">
                <div className="col col-left">
                  <OversightPanel
                    dims={dims}
                    steps={steps}
                    idx={idx}
                    xKey={axes.x}
                    yKey={axes.y}
                    setAxes={setAxes}
                    polygons={polygons}
                    status={cls.status}
                    counts={counts}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onPolygonChange={onPolygonChange}
                  />
                </div>
                <div className="col col-right">
                  <PlanPanel
                    steps={steps}
                    status={cls.status}
                    checked={checked}
                    inside={cls.inside}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onCheck={onCheck}
                    onRemove={onRemove}
                    onRestore={onRestore}
                    onSelectAll={onSelectAll}
                  />
                </div>
              </main>

              <footer className="footer">
                {runError && (
                  <div className="run-error" role="alert" data-testid="run-error">
                    <b>{runError.status === 409 ? "409 Conflict, nothing ran." : `Run failed (${runError.status || "network"}).`}</b> {runError.error}
                    {runError.expected && (
                      <span className="mono">
                        {" "}
                        expected [{runError.expected.map(indexOf).join(", ")}] got [{(runError.got ?? []).map(indexOf).join(", ")}]
                      </span>
                    )}
                  </div>
                )}
                <div className="footer-row">
                  <button className="btn" data-testid="start-over" onClick={startOver}>
                    Start over
                  </button>
                  <div className="footer-right">
                    <span title="Re-propose is cut for the sprint (designed in docs/01, step 6)">
                      <button className="btn" disabled data-testid="repropose">
                        {Icon.refresh(13)} Re-propose plan
                      </button>
                    </span>
                    <button className="btn btn-primary" data-testid="approve-run" disabled={!canRun} onClick={approveAndRun}>
                      {Icon.play(11)} {submitting ? "Starting..." : "Approve & Run"}
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
  );
}
