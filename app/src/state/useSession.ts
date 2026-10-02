// Every daemon call the screens make goes through here (the daemon owns logic;
// screens render and capture gestures). Actions are stable for the session's life.
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { DaemonApi } from "../api/client";
import type { Attachment, DecisionAction, DecisionSource, Point, RunBody } from "../api/types";
import { classify, indexScores, pairKey, splitPairKey, type Classification, type ScoreIndex } from "../lib/approval";
import { initialSession, openTaskInto, sessionReducer, stopRun, type SessionState } from "./session";

export interface Counts { approved: number; pending: number; removed: number }

export interface SessionActions {
  submit(prompt: string, attachments: Attachment[]): Promise<void>;
  retryPlan(): Promise<void>;
  /** Resolves true once the daemon has the revised plan, false on failure. The failure goes
   *  to `onError` when given (the caller shows it), else to the session notice. */
  revise(instruction: string, onError?: (message: string) => void): Promise<boolean>;
  editStep(stepId: string, patch: { title?: string; description?: string }): Promise<void>;
  check(stepId: string, on: boolean, source?: DecisionSource): void;
  remove(stepId: string, source?: DecisionSource): void;
  restore(stepId: string, source?: DecisionSource): void;
  approveAll(): void;
  select(stepId: string | null): void;
  setAxes(x: string, y: string): void;
  onPolygonChange(poly: Point[] | null, final: boolean): void;
  run(): Promise<void>;
  skipUndecidedAndRun(): Promise<void>;
  stop(): Promise<void>;
  newTask(): void;
  openTask(taskId: string): Promise<void>;
  dismissNotice(): void;
}

export interface Session {
  state: SessionState;
  cls: Classification;
  counts: Counts;
  idx: ScoreIndex;
  canRun: boolean;
  actions: SessionActions;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useSession(api: DaemonApi | null): Session {
  const [state, dispatch] = useReducer(sessionReducer, initialSession);
  const ref = useRef(state);
  ref.current = state;
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!api || !state.taskId) return;
    return api.subscribe(state.taskId, 0, (event) => dispatch({ type: "event", event }));
  }, [api, state.taskId]);

  const idx = useMemo(() => indexScores(state.scores), [state.scores]);
  const raw = useMemo(
    () => classify(state.steps, idx, state.polygons, state.checked, state.removed),
    [state.steps, idx, state.polygons, state.checked, state.removed],
  );
  // Keep identity while the result is unchanged so lists don't re-render on every pointermove.
  const stable = useRef({ cls: raw, steps: state.steps });
  if (stable.current.steps !== state.steps || stable.current.cls.signature !== raw.signature) stable.current = { cls: raw, steps: state.steps };
  const cls = stable.current.cls;
  const clsRef = useRef(cls);
  clsRef.current = cls;
  const counts = useMemo(() => ({ approved: cls.approved, pending: cls.pending, removed: cls.removed }), [cls]);
  const canRun = state.phase === "review" && state.steps.length > 0 && cls.pending === 0 && cls.approved > 0 && state.busy === null;

  const actions = useMemo<SessionActions>(() => {
    const notice = (text: string) => dispatch({ type: "notice", text });
    const putTimers: Record<string, ReturnType<typeof setTimeout>> = {};

    const decide = (stepId: string, action: DecisionAction, source: DecisionSource): Promise<void> => {
      const a = apiRef.current;
      const t = ref.current.taskId;
      if (!a || !t) return Promise.resolve();
      return a.decision(t, { step_id: stepId, action, source }).then(
        () => undefined,
        (e) => notice(`Saving your decision failed: ${msg(e)}`),
      );
    };

    const planNow = async (taskId: string) => {
      const a = apiRef.current;
      if (!a) return;
      await new Promise((r) => setTimeout(r, 30)); // let the SSE subscription attach first
      try {
        const plan = await a.plan(taskId);
        if (ref.current.taskId === taskId) dispatch({ type: "plan_loaded", steps: plan.steps, scores: plan.scores });
      } catch (e) {
        if (ref.current.taskId === taskId) dispatch({ type: "plan_failed", error: `Planning failed: ${msg(e)}` });
      }
    };

    const startRun = async (removed: ReadonlySet<string>, c: Classification) => {
      const s = ref.current;
      const a = apiRef.current;
      if (!a || !s.taskId) return;
      const approved = s.steps.filter((st) => !removed.has(st.id) && c.status[st.id] === "approved").map((st) => st.id);
      if (!approved.length) return notice("Nothing is approved yet.");
      const body: RunBody = {
        approved_step_ids: approved,
        checked_step_ids: [...s.checked].filter((id) => !removed.has(id)),
        removed_step_ids: [...removed],
        boundaries: Object.entries(s.polygons)
          .filter(([, p]) => p.length >= 3)
          .map(([k, polygon]) => {
            const [x_dim, y_dim] = splitPairKey(k);
            return { x_dim, y_dim, polygon };
          }),
      };
      dispatch({ type: "busy", busy: "starting_run" });
      const r = await a.run(s.taskId, body);
      if (r.ok) dispatch({ type: "run_started", run: { runId: r.run_id, approvedIds: approved, removedIds: body.removed_step_ids } });
      else dispatch({ type: "run_failed", error: { status: r.status, error: r.error, expected: r.expected, got: r.got } });
    };

    return {
      async submit(prompt, attachments) {
        const a = apiRef.current;
        const text = prompt.trim();
        if (!a || !text) return;
        try {
          const { task_id } = await a.createTask(text, null, attachments.map((x) => x.attachment_id));
          dispatch({ type: "start_task", taskId: task_id, prompt: text, attachments });
          await planNow(task_id);
        } catch (e) {
          notice(`Couldn't start the task: ${msg(e)}`);
        }
      },
      async retryPlan() {
        const t = ref.current.taskId;
        if (!t) return;
        dispatch({ type: "retry_plan" });
        await planNow(t);
      },
      async revise(instruction, onError) {
        const a = apiRef.current;
        const t = ref.current.taskId;
        if (!a || !t || !instruction.trim()) return false;
        dispatch({ type: "busy", busy: "revising" });
        try {
          const p = await a.repropose(t, instruction.trim());
          dispatch({ type: "plan_revised", steps: p.steps, scores: p.scores });
          return true;
        } catch (e) {
          dispatch({ type: "busy", busy: null });
          if (onError) onError(msg(e));
          else notice(`Revising the plan failed: ${msg(e)}`);
          return false;
        }
      },
      async editStep(stepId, patch) {
        const a = apiRef.current;
        const t = ref.current.taskId;
        if (!a || !t) return;
        try {
          const r = await a.editStep(t, stepId, patch);
          dispatch({ type: "step_edited", step: r.step, scores: r.scores });
        } catch (e) {
          notice(`Editing the step failed: ${msg(e)}`);
        }
      },
      check(stepId, on, source = "step_list") {
        dispatch({ type: "check", stepId, on });
        void decide(stepId, on ? "check" : "uncheck", source);
      },
      remove(stepId, source = "step_list") {
        dispatch({ type: "remove", stepId });
        void decide(stepId, "remove", source);
      },
      restore(stepId, source = "step_list") {
        dispatch({ type: "restore", stepId });
        void decide(stepId, "restore", source);
      },
      approveAll() {
        const s = ref.current;
        const todo = s.steps.filter((x) => !s.removed.has(x.id) && !s.checked.has(x.id));
        dispatch({ type: "check_all" });
        todo.forEach((x) => void decide(x.id, "check", "step_list"));
      },
      select(stepId) {
        dispatch({ type: "select", stepId });
      },
      setAxes(x, y) {
        dispatch({ type: "set_axes", x, y });
      },
      onPolygonChange(poly, final) {
        const k = pairKey(ref.current.axes.x, ref.current.axes.y);
        dispatch({ type: "set_polygon", key: k, polygon: poly });
        if (!final) return;
        clearTimeout(putTimers[k]);
        putTimers[k] = setTimeout(() => {
          const a = apiRef.current;
          const t = ref.current.taskId;
          if (!a || !t) return;
          const [x_dim, y_dim] = splitPairKey(k);
          a.putBoundary(t, { x_dim, y_dim, polygon: poly && poly.length >= 3 ? poly : [] }).catch((e) =>
            notice(`Saving the boundary failed: ${msg(e)}`),
          );
        }, 250);
      },
      async run() {
        const s = ref.current;
        const c = clsRef.current;
        if (s.phase !== "review" || c.pending > 0 || s.busy) return;
        await startRun(s.removed, c);
      },
      async skipUndecidedAndRun() {
        const s = ref.current;
        const c = clsRef.current;
        if (s.phase !== "review" || s.busy) return;
        const pending = s.steps.filter((st) => c.status[st.id] === "pending").map((st) => st.id);
        pending.forEach((id) => dispatch({ type: "remove", stepId: id }));
        await Promise.all(pending.map((id) => decide(id, "remove", "skip_undecided")));
        await startRun(new Set([...s.removed, ...pending]), c);
      },
      async stop() {
        const a = apiRef.current;
        if (!a) return;
        // {stopped:false} during a run reloads the task (see stopRun).
        await stopRun(a, () => ref.current, dispatch);
      },
      newTask() {
        Object.values(putTimers).forEach(clearTimeout);
        dispatch({ type: "reset" });
      },
      async openTask(taskId) {
        const a = apiRef.current;
        if (!a) return;
        await openTaskInto(a, taskId, dispatch);
      },
      dismissNotice() {
        dispatch({ type: "notice", text: null });
      },
    };
  }, []);

  return useMemo(() => ({ state, cls, counts, idx, canRun, actions }), [state, cls, counts, idx, canRun, actions]);
}
