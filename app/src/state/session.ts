// The one source of truth for a task in the UI. Pure: no fetches, no value imports
// from relative modules (node --test runs this file directly).
import type { Attachment, OversightEvent, Point, Score, Step, TaskDetail } from "../api/types";

export type Phase = "home" | "planning" | "review" | "running" | "done";
export interface RunError { status: number; error: string; expected?: string[]; got?: string[] }
export interface RunInfo { runId: string; approvedIds: string[]; removedIds: string[] }
type PolygonMap = Record<string, Point[]>;

export interface SessionState {
  phase: Phase;
  taskId: string | null;
  prompt: string;
  attachments: Attachment[];
  steps: Step[];
  scores: Score[];
  axes: { x: string; y: string };
  polygons: PolygonMap;
  checked: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  selectedId: string | null;
  events: OversightEvent[];
  run: RunInfo | null;
  runError: RunError | null;
  planError: string | null;
  busy: "revising" | "starting_run" | null;
  notice: string | null;
}

export const DEFAULT_AXES = { x: "action_uncertainty", y: "reversibility" };
const EMPTY: ReadonlySet<string> = new Set();

export const initialSession: SessionState = {
  phase: "home",
  taskId: null,
  prompt: "",
  attachments: [],
  steps: [],
  scores: [],
  axes: DEFAULT_AXES,
  polygons: {},
  checked: EMPTY,
  removed: EMPTY,
  selectedId: null,
  events: [],
  run: null,
  runError: null,
  planError: null,
  busy: null,
  notice: null,
};

export type SessionAction =
  | { type: "reset" }
  | { type: "start_task"; taskId: string; prompt: string; attachments: Attachment[] }
  | { type: "plan_loaded"; steps: Step[]; scores: Score[] }
  | { type: "plan_failed"; error: string }
  | { type: "retry_plan" }
  | { type: "load_task"; detail: TaskDetail }
  | { type: "event"; event: OversightEvent }
  | { type: "set_axes"; x: string; y: string }
  | { type: "set_polygon"; key: string; polygon: Point[] | null }
  | { type: "check"; stepId: string; on: boolean }
  | { type: "remove"; stepId: string }
  | { type: "restore"; stepId: string }
  | { type: "check_all" }
  | { type: "select"; stepId: string | null }
  | { type: "busy"; busy: SessionState["busy"] }
  | { type: "plan_revised"; steps: Step[]; scores: Score[] }
  | { type: "step_edited"; step: Step; scores: Score[] }
  | { type: "run_started"; run: RunInfo }
  | { type: "run_failed"; error: RunError }
  | { type: "notice"; text: string | null };

const byIndex = (steps: Step[]) => [...steps].sort((a, b) => a.index - b.index);
const without = (set: ReadonlySet<string>, id: string) => {
  if (!set.has(id)) return set;
  const n = new Set(set);
  n.delete(id);
  return n;
};
const withId = (set: ReadonlySet<string>, id: string) => (set.has(id) ? set : new Set(set).add(id));
const keepIds = (set: ReadonlySet<string>, ids: Set<string>) => new Set([...set].filter((x) => ids.has(x)));

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "reset":
      return { ...initialSession, axes: s.axes };
    case "start_task":
      return { ...initialSession, axes: s.axes, phase: "planning", taskId: a.taskId, prompt: a.prompt, attachments: a.attachments };
    case "plan_loaded":
      return { ...s, phase: "review", steps: byIndex(a.steps), scores: a.scores, planError: null };
    case "plan_failed":
      return { ...s, planError: a.error };
    case "retry_plan":
      return { ...s, planError: null };
    case "load_task": {
      const d = a.detail;
      const steps = byIndex(d.steps);
      const polygons: PolygonMap = {};
      for (const b of d.boundaries) if (b.polygon.length >= 3) polygons[`${b.x_dim}|${b.y_dim}`] = b.polygon;
      const last = d.runs.length ? d.runs[d.runs.length - 1] : null;
      const run = last ? { runId: last.id, approvedIds: last.approved, removedIds: last.removed } : null;
      const phase: Phase = last ? (last.finished_at ? "done" : "running") : steps.length ? "review" : "planning";
      return {
        ...initialSession,
        axes: s.axes,
        phase,
        taskId: d.task.id,
        prompt: d.task.prompt,
        attachments: d.task.attachments ?? [],
        steps,
        scores: d.scores,
        polygons,
        checked: new Set(steps.filter((x) => x.status === "approved").map((x) => x.id)),
        removed: new Set(steps.filter((x) => x.status === "removed").map((x) => x.id)),
        run,
        planError: steps.length ? null : "This task has no plan yet.",
      };
    }
    case "event": {
      const last = s.events[s.events.length - 1];
      if (last && last.seq >= a.event.seq) return s;
      const events = [...s.events, a.event];
      const ended = a.event.kind === "final_result" && s.run !== null && a.event.run_id === s.run.runId;
      return { ...s, events, phase: ended ? "done" : s.phase };
    }
    case "set_axes":
      return { ...s, axes: { x: a.x, y: a.y } };
    case "set_polygon": {
      const polygons = { ...s.polygons };
      if (a.polygon && a.polygon.length) polygons[a.key] = a.polygon;
      else delete polygons[a.key];
      return { ...s, polygons };
    }
    case "check":
      return { ...s, checked: a.on ? withId(s.checked, a.stepId) : without(s.checked, a.stepId), runError: null };
    case "remove":
      return { ...s, removed: withId(s.removed, a.stepId), checked: without(s.checked, a.stepId), runError: null };
    case "restore":
      return { ...s, removed: without(s.removed, a.stepId) };
    case "check_all":
      return { ...s, checked: new Set(s.steps.filter((x) => !s.removed.has(x.id)).map((x) => x.id)), runError: null };
    case "select":
      return { ...s, selectedId: a.stepId };
    case "busy":
      return { ...s, busy: a.busy };
    case "plan_revised": {
      // The daemon resets rewritten steps to pending and keeps statuses of unchanged ones,
      // so trust its statuses: a check survives only on a step it still has approved.
      const ids = new Set(a.steps.map((x) => x.id));
      const approved = new Set(a.steps.filter((x) => x.status === "approved").map((x) => x.id));
      const removedNow = new Set(a.steps.filter((x) => x.status === "removed").map((x) => x.id));
      return {
        ...s,
        phase: "review",
        steps: byIndex(a.steps),
        scores: a.scores,
        checked: keepIds(s.checked, approved),
        removed: keepIds(s.removed, removedNow),
        selectedId: s.selectedId && ids.has(s.selectedId) ? s.selectedId : null,
        busy: null,
        planError: null,
      };
    }
    case "step_edited":
      // An edited step is re-scored and pending again on the daemon: uncheck it here too.
      return {
        ...s,
        checked: without(s.checked, a.step.id),
        steps: s.steps.map((x) => (x.id === a.step.id ? a.step : x)),
        scores: [...s.scores.filter((x) => x.step_id !== a.step.id), ...a.scores],
      };
    case "run_started":
      return { ...s, phase: "running", run: a.run, busy: null, runError: null };
    case "run_failed":
      return { ...s, runError: a.error, busy: null };
    case "notice":
      return { ...s, notice: a.text };
  }
}
