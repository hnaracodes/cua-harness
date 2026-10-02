// In-browser mock daemon. Implements the same contract shapes as the real
// daemon (docs/01 addendum) so the UI can be developed and verified with no
// Python running. Used automatically when the daemon is unreachable or when
// VITE_MOCK=1. It owns its own approval check for /run, exactly like the
// daemon, so a UI/daemon disagreement shows up as a 409 here too.

import { classify, indexScores, pairKey } from "../lib/approval";
import type { PolygonMap } from "../lib/approval";
import type { DaemonApi, EventListener } from "./client";
import { FIXTURE_DIMENSIONS, FIXTURE_MODEL, FIXTURE_STEPS } from "./fixtures";
import type {
  BoundaryBody,
  DecisionBody,
  EventKind,
  Health,
  OversightEvent,
  PlanResponse,
  RunBody,
  RunResult,
  Score,
  Step,
} from "./types";

interface MockTask {
  id: string;
  prompt: string;
  steps: Step[];
  scores: Score[];
  boundaries: PolygonMap;
  decisions: (DecisionBody & { ts: string })[];
  events: OversightEvent[];
  listeners: Set<EventListener>;
  stop: boolean;
  running: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export function createMockDaemon(): DaemonApi {
  const tasks = new Map<string, MockTask>();
  let costTotal = 0;
  let seq = 0;

  const emit = (t: MockTask, kind: EventKind, payload: object, runId: string | null = null) => {
    const ev: OversightEvent = {
      kind,
      task_id: t.id,
      run_id: runId,
      seq: ++seq,
      ts: new Date().toISOString(),
      payload: payload as Record<string, unknown>,
    };
    t.events.push(ev);
    t.listeners.forEach((l) => l(ev));
  };

  const cost = (t: MockTask, scope: "plan" | "score" | "run", inTok: number, outTok: number, ms: number, runId: string | null = null) => {
    const delta = (inTok * 1.25 + outTok * 10) / 1e6;
    costTotal += delta;
    emit(
      t,
      "cost",
      { scope, model: FIXTURE_MODEL, usd_delta: delta, usd_total: costTotal, latency_ms: ms, input_tokens: inTok, output_tokens: outTok },
      runId,
    );
  };

  const getTask = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(`mock: unknown task ${id}`);
    return t;
  };

  return {
    mode: "mock",
    baseUrl: "mock://in-browser",

    async health(): Promise<Health> {
      return {
        daemon: "ok",
        api_key: true,
        provider: "fixtures",
        model: FIXTURE_MODEL,
        cua_driver: false,
        fixtures: true,
        exec_mode: "simulated",
        cost_usd_total: costTotal,
        status_line: `Mock daemon (in-browser fixtures). cua-driver simulated, model ${FIXTURE_MODEL}.`,
      };
    },

    async dimensions() {
      return FIXTURE_DIMENSIONS.map((d) => ({ ...d, labels: [...d.labels], anchors: [...d.anchors] }));
    },

    async createTask(prompt: string) {
      const id = rid("tsk");
      tasks.set(id, {
        id,
        prompt,
        steps: [],
        scores: [],
        boundaries: {},
        decisions: [],
        events: [],
        listeners: new Set(),
        stop: false,
        running: false,
      });
      return { task_id: id };
    },

    async plan(taskId: string): Promise<PlanResponse> {
      const t = getTask(taskId);
      const total = FIXTURE_STEPS.length;
      emit(t, "plan_progress", { stage: "planning", message: "Generating a high-level plan for the task.", done: 0, total });
      await sleep(1100);
      cost(t, "plan", 812, 640, 1100);
      t.steps = FIXTURE_STEPS.map((s, i) => ({
        id: `stp_${taskId.slice(4)}_${i + 1}`,
        task_id: taskId,
        index: i + 1,
        title: s.title,
        description: s.description,
        glyph: s.glyph,
        status: "pending",
        edited_from: null,
        revision: 0,
      }));
      emit(t, "plan_progress", { stage: "scoring", message: `${total} step(s). Scoring actions and placing them on the grid.`, done: 0, total });
      t.scores = [];
      for (let i = 0; i < total; i++) {
        await sleep(320);
        const st = t.steps[i];
        FIXTURE_STEPS[i].cells.forEach(([li, off, rationale], d) => {
          const dim = FIXTURE_DIMENSIONS[d];
          const n = dim.labels.length;
          t.scores.push({
            step_id: st.id,
            dimension: dim.key,
            label: dim.labels[li],
            position: (li + off) / n,
            confidence: 0.7 + ((i * 7 + d * 3) % 25) / 100,
            rationale,
          });
        });
        cost(t, "score", 1430, 520, 320);
        emit(t, "plan_progress", { stage: "scoring", message: `Scored step ${i + 1} of ${total}.`, done: i + 1, total });
      }
      emit(t, "plan_progress", { stage: "done", message: `${total} step(s). Review and approve to run.`, done: total, total });
      return { task_id: taskId, steps: t.steps.map((s) => ({ ...s })), scores: t.scores.map((s) => ({ ...s })) };
    },

    async putBoundary(taskId: string, b: BoundaryBody) {
      const t = getTask(taskId);
      const k = pairKey(b.x_dim, b.y_dim);
      if (b.polygon.length >= 3) t.boundaries[k] = b.polygon.map((p) => [p[0], p[1]]);
      else delete t.boundaries[k];
      const c = classify(t.steps, indexScores(t.scores), { [k]: t.boundaries[k] ?? [] }, new Set(), new Set());
      return { boundary_id: rid("bnd"), inside_step_ids: [...c.inside] };
    },

    async decision(taskId: string, d: DecisionBody) {
      const t = getTask(taskId);
      t.decisions.push({ ...d, ts: new Date().toISOString() });
      return { ok: true };
    },

    async run(taskId: string, body: RunBody): Promise<RunResult> {
      const t = getTask(taskId);
      if (t.running) return { ok: false, status: 409, error: "A run is already in progress for this task." };
      const polys: PolygonMap = {};
      for (const b of body.boundaries) if (b.polygon.length >= 3) polys[pairKey(b.x_dim, b.y_dim)] = b.polygon;
      const c = classify(t.steps, indexScores(t.scores), polys, new Set(body.checked_step_ids), new Set(body.removed_step_ids));
      const expected = t.steps.filter((s) => c.status[s.id] === "approved").map((s) => s.id).sort();
      const got = [...body.approved_step_ids].sort();
      if (c.pending > 0) {
        return { ok: false, status: 409, error: `${c.pending} step(s) are still pending; nothing ran.`, expected, got };
      }
      if (expected.join() !== got.join()) {
        return { ok: false, status: 409, error: "Approved set does not match the boundary and checks; nothing ran.", expected, got };
      }
      const runId = rid("run");
      t.stop = false;
      t.running = true;
      void simulateRun(t, runId, new Set(expected), new Set(body.removed_step_ids));
      return { ok: true, run_id: runId };
    },

    async stop(taskId: string) {
      getTask(taskId).stop = true;
      return { stopped: true };
    },

    subscribe(taskId: string, since: number, onEvent: EventListener) {
      const t = getTask(taskId);
      for (const ev of t.events) if (ev.seq > since) onEvent(ev);
      t.listeners.add(onEvent);
      return () => t.listeners.delete(onEvent);
    },
  };

  async function simulateRun(t: MockTask, runId: string, approved: Set<string>, removed: Set<string>) {
    const steps = t.steps.filter((s) => approved.has(s.id));
    emit(t, "consideration_scored", { step_count: t.steps.length, dimension_count: 10, approved_count: steps.length }, runId);
    for (const s of t.steps) if (removed.has(s.id)) emit(t, "step_removed", { step_id: s.id, index: s.index, title: s.title }, runId);
    const attempted: string[] = [];
    const completed: string[] = [];
    let n = 0;
    let stopped = false;
    for (const s of steps) {
      if (t.stop) {
        stopped = true;
        break;
      }
      // Executor-side assertion, mirrored: never dispatch an unapproved step.
      if (!approved.has(s.id)) throw new Error(`UnapprovedStepError: ${s.id}`);
      attempted.push(s.id);
      emit(t, "step_started", { step_id: s.id, index: s.index, title: s.title }, runId);
      const script = simActions(s);
      let halted = false;
      for (const a of script) {
        await sleep(650);
        if (t.stop) {
          halted = true;
          break;
        }
        n += 1;
        emit(t, "action", { step_id: s.id, n, mode: "sim", verb: a[0], target: a[1], detail: a[2], ok: true, error: null }, runId);
        cost(t, "run", 2100, 180, 650, runId);
      }
      if (halted) {
        emit(t, "step_result", { step_id: s.id, index: s.index, status: "stopped", summary: "Stopped by the user." }, runId);
        stopped = true;
        break;
      }
      completed.push(s.id);
      emit(t, "step_result", { step_id: s.id, index: s.index, status: "done", summary: simSummary(s) }, runId);
    }
    t.running = false;
    emit(
      t,
      "final_result",
      stopped
        ? { status: "stopped", message: "Run stopped by the user. Remaining approved steps were not attempted.", attempted, completed }
        : { status: "completed", message: "All approved steps were attempted.", attempted, completed },
      runId,
    );
  }
}

function simKind(s: Step): string {
  const t = s.title.toLowerCase();
  if (t.startsWith("send")) return "send";
  if (t.startsWith("draft") || t.includes("message")) return "draft";
  if (t.includes("recipient")) return "contacts";
  return String(s.glyph);
}

function simActions(s: Step): [string, string, string][] {
  switch (simKind(s)) {
    case "search":
      return [
        ["launch", "Google Chrome (agent profile)", "Opened a window in the agent's own browser profile."],
        ["type", "Search field", "Typed \"tennis rackets under $100 birthday gift\"."],
        ["press", "Return", "Submitted the search and opened Shopping results."],
      ];
    case "cart":
      return [
        ["click", "Product link", "Opened the selected racket's product page."],
        ["click", "Add to cart button", "Added one racket to the cart."],
      ];
    case "send":
      return [
        ["focus", "WhatsApp chat", "Focused the selected chat (simulated, no message leaves the machine)."],
        ["click", "Send button", "Simulated send."],
      ];
    case "contacts":
      return [
        ["launch", "WhatsApp", "Opened WhatsApp in the agent's desk."],
        ["click", "Chat list", "Selected the friends group chat."],
      ];
    case "draft":
      return [
        ["launch", "Notes", "Opened a new note for the draft."],
        ["type", "Note body", "Wrote the party message with [date], [time] and [location] placeholders."],
      ];
    default:
      return [
        ["read", "Shopping results", "Read prices, ratings and availability from the accessibility tree."],
        ["click", "Result card", "Opened the best-rated option under $100."],
      ];
  }
}

function simSummary(s: Step): string {
  switch (simKind(s)) {
    case "search":
      return "Found 24 rackets under $100 on Google Shopping.";
    case "cart":
      return "Racket added to cart, no checkout.";
    case "send":
      return "Simulated send to the friends group.";
    case "contacts":
      return "Selected the friends group chat.";
    case "draft":
      return "Drafted the party message in Notes. Nothing was sent.";
    default:
      return "Chose Wilson Ultra 100 Junior, $79.99, 4.6 stars.";
  }
}
