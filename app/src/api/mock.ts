// In-browser mock daemon. Implements the same contract shapes as the real
// daemon (docs/01 addendum) so the UI can be developed and verified with no
// Python running. Used automatically when the daemon is unreachable or when
// VITE_MOCK=1. It owns its own approval check for /run, exactly like the
// daemon, so a UI/daemon disagreement shows up as a 409 here too.

import { classify, indexScores, pairKey, splitPairKey } from "../lib/approval";
import type { PolygonMap } from "../lib/approval";
import type { DaemonApi, EventListener } from "./client";
import { HttpError } from "./errors";
import { FIXTURE_DIMENSIONS, FIXTURE_MODEL, FIXTURE_STEPS, syntheticCells } from "./fixtures";
import type {
  AppSettings,
  Attachment,
  BoundaryBody,
  DecisionBody,
  EventKind,
  Health,
  OversightEvent,
  PlanResponse,
  RunBody,
  ImageMime,
  RunRecord,
  RunResult,
  Score,
  SetupStatus,
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
  createdAt: string;
  attachments: Attachment[];
  runs: RunRecord[];
  revision: number;
  frameSeq: number;
  frames: Map<number, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export function createMockDaemon(): DaemonApi {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const MODE = {
    fast: q.has("fast"),
    setup: q.has("setup"),
    nonmac: q.has("nonmac"),
    down: q.get("down") === "1",
    many: q.has("many") ? Math.min(60, Math.max(6, Number(q.get("many")) || 6)) : 0,
  };
  const ms = (n: number) => (MODE.fast ? Math.max(10, Math.round(n / 10)) : n);
  const ACTION_MS = MODE.fast ? 60 : 650;
  const tasks = new Map<string, MockTask>();
  const blobs = new Map<string, { att: Attachment; url: string }>();
  const settings: AppSettings = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    plan_only: false,
    models: { anthropic: ["claude-sonnet-5-5", "claude-opus-5-5"], openai: ["gpt-5.5"] },
  };
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

  const api: DaemonApi = {
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
        setup_complete: true,
        plan_only: settings.plan_only,
        status_line: `Mock daemon (in-browser fixtures). cua-driver simulated, model ${FIXTURE_MODEL}.`,
      };
    },

    async dimensions() {
      return FIXTURE_DIMENSIONS.map((d) => ({ ...d, labels: [...d.labels], anchors: [...d.anchors] }));
    },

    async createTask(prompt: string, _selectedApp?: string | null, attachmentIds: string[] = []) {
      if (attachmentIds.length > 4) throw new HttpError(400, { error: "at most 4 images per task" });
      const unknown = attachmentIds.filter((a) => !blobs.has(a));
      if (unknown.length) throw new HttpError(400, { error: "unknown attachment ids", unknown });
      const id = rid("tsk");
      tasks.set(id, {
        id, prompt, steps: [], scores: [], boundaries: {}, decisions: [], events: [],
        listeners: new Set(), stop: false, running: false,
        createdAt: new Date().toISOString(),
        attachments: attachmentIds.map((a) => blobs.get(a)!.att),
        runs: [], revision: 0,
        frameSeq: 0, frames: new Map(),
      });
      return { task_id: id };
    },

    async plan(taskId: string): Promise<PlanResponse> {
      const t = getTask(taskId);
      const n = MODE.many || FIXTURE_STEPS.length;
      const specs = Array.from({ length: n }, (_, i) =>
        i < FIXTURE_STEPS.length
          ? FIXTURE_STEPS[i]
          : { title: `Extra step ${Math.floor((i - FIXTURE_STEPS.length) / 2) + 1}`, description: "Synthetic step for crowding (?many).", glyph: "generic" as const, cells: syntheticCells(`Extra step ${Math.floor((i - FIXTURE_STEPS.length) / 2) + 1}`) },
      );
      const total = n;
      emit(t, "plan_progress", { stage: "planning", message: "Generating a high-level plan for the task.", done: 0, total });
      await sleep(ms(1100));
      cost(t, "plan", 812, 640, 1100);
      t.steps = specs.map((s, i) => ({
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
        await sleep(ms(320));
        const st = t.steps[i];
        specs[i].cells.forEach(([li, off, rationale], d) => {
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
      t.runs.push({ id: runId, task_id: t.id, status: "running", exec_mode: "simulated", approved: expected,
        removed: [...body.removed_step_ids], started_at: new Date().toISOString(), finished_at: null, final: null });
      void simulateRun(t, runId, new Set(expected), new Set(body.removed_step_ids));
      return { ok: true, run_id: runId };
    },

    async stop(taskId: string) {
      getTask(taskId).stop = true;
      return { stopped: true };
    },

    async listTasks() {
      return [...tasks.values()].reverse().map((t) => ({ id: t.id, prompt: t.prompt, created_at: t.createdAt, step_count: t.steps.length }));
    },
    async getTask(taskId: string) {
      const t = getTask(taskId);
      return {
        task: { id: t.id, prompt: t.prompt, selected_app: null, created_at: t.createdAt, mode: "fixtures", attachments: t.attachments },
        steps: t.steps.map((s) => ({ ...s })),
        scores: t.scores.map((s) => ({ ...s })),
        boundaries: Object.entries(t.boundaries).map(([k, polygon]) => {
          const [x_dim, y_dim] = splitPairKey(k);
          return { x_dim, y_dim, polygon };
        }),
        runs: t.runs.map((r) => ({ ...r })),
        cost_usd: costTotal,
      };
    },
    async uploadAttachment(file: Blob) {
      const mime = file.type as ImageMime;
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
        throw new HttpError(400, { error: `Unsupported image type ${file.type || "unknown"}. Use PNG, JPEG or WebP.` });
      if (file.size === 0) throw new HttpError(400, { error: "The file is empty." });
      if (file.size > 5 * 1024 * 1024) throw new HttpError(413, { error: "Images must be 5 MB or smaller." });
      const att: Attachment = { attachment_id: rid("att"), mime, bytes: file.size };
      blobs.set(att.attachment_id, { att, url: URL.createObjectURL(file) });
      return att;
    },
    attachmentUrl: (id: string) => blobs.get(id)?.url ?? "",
    async repropose(taskId: string, instruction: string | null) {
      const t = getTask(taskId);
      t.revision += 1;
      emit(t, "plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: t.steps.length });
      await sleep(400);
      emit(t, "plan_revised", { revision: t.revision, instruction, changed_step_ids: [], added_step_ids: [], dropped_step_ids: [] });
      emit(t, "plan_progress", { stage: "done", message: "Plan revised.", done: t.steps.length, total: t.steps.length });
      return { task_id: taskId, steps: t.steps.map((s) => ({ ...s })), scores: t.scores.map((s) => ({ ...s })), revision: t.revision };
    },
    async editStep(taskId: string, stepId: string, patch: { title?: string; description?: string }) {
      const t = getTask(taskId);
      const s = t.steps.find((x) => x.id === stepId);
      if (!s) throw new HttpError(404, { error: "step not found in task" });
      if (!patch.title?.trim() && !patch.description?.trim()) throw new HttpError(400, { error: "nothing to change" });
      s.edited_from = s.edited_from ?? s.title;
      if (patch.title?.trim()) s.title = patch.title.trim();
      if (patch.description?.trim()) s.description = patch.description.trim();
      return { step: { ...s }, scores: t.scores.filter((x) => x.step_id === stepId).map((x) => ({ ...x })) };
    },
    frameUrl: (taskId: string, seq: number) => tasks.get(taskId)?.frames.get(seq) ?? "",
    async setupStatus(): Promise<SetupStatus> {
      return {
        platform: "macos",
        key: { provider: settings.provider, present: true, source: "env", tested: true, warning: null },
        driver: { installed: true, version: "mock", running: true },
        permissions: { accessibility: "granted", screen_recording: "granted" },
        self_test: { passed_at: new Date().toISOString() },
        plan_only: settings.plan_only,
        complete: true,
      };
    },
    async setKey() { return { ok: true, error: null }; },
    async installDriver() { return { ok: true, version: "mock", log_tail: "" }; },
    async startDriver() { return { ok: true, error: null }; },
    async openPermission() { return { ok: true }; },
    async selfTest() { return { ok: true, detail: "mock self-test passed" }; },
    async completeSetup() { return { ok: true }; },
    async getSettings() { return { ...settings, models: { ...settings.models } }; },
    async putSettings(patch: Partial<Pick<AppSettings, "provider" | "model" | "plan_only">>) {
      Object.assign(settings, patch);
      return { ...settings, models: { ...settings.models } };
    },

    subscribe(taskId: string, since: number, onEvent: EventListener) {
      const t = getTask(taskId);
      for (const ev of t.events) if (ev.seq > since) onEvent(ev);
      t.listeners.add(onEvent);
      return () => t.listeners.delete(onEvent);
    },
  };
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__oversightMock = {
      api,
      setDown: (v: boolean) => {
        MODE.down = v;
      },
    };
  }
  return api;

  async function simulateRun(t: MockTask, runId: string, approved: Set<string>, removed: Set<string>) {
    const steps = t.steps.filter((s) => approved.has(s.id));
    emit(t, "consideration_scored", { step_count: t.steps.length, dimension_count: 10, approved_count: steps.length }, runId);
    for (const s of t.steps) if (removed.has(s.id)) emit(t, "step_removed", { step_id: s.id, index: s.index, title: s.title }, runId);
    const attempted: string[] = [];
    const completed: string[] = [];
    const summaries = new Map<string, string>();
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
      const t0 = Date.now();
      let stepActions = 0;
      let halted = false;
      for (const a of simActions(s)) {
        await sleep(ACTION_MS);
        if (t.stop) {
          halted = true;
          break;
        }
        n += 1;
        stepActions += 1;
        emit(t, "action", { step_id: s.id, n, mode: "sim", verb: a[0], target: a[1], detail: a[2], ok: true, error: null }, runId);
        cost(t, "run", 2100, 180, ACTION_MS, runId);
        t.frameSeq += 1;
        t.frames.set(t.frameSeq, frameSvg(s.title, a[0], a[1], n));
        emit(t, "frame", { step_id: s.id, seq: t.frameSeq }, runId);
      }
      const duration_ms = Date.now() - t0;
      if (halted) {
        emit(t, "step_result", { step_id: s.id, index: s.index, status: "stopped", summary: "Stopped by the user.", actions: stepActions, duration_ms }, runId);
        stopped = true;
        break;
      }
      completed.push(s.id);
      summaries.set(s.id, simSummary(s));
      emit(t, "step_result", { step_id: s.id, index: s.index, status: "done", summary: summaries.get(s.id)!, actions: stepActions, duration_ms }, runId);
    }
    t.running = false;
    const skipped = [
      ...t.steps.filter((s) => removed.has(s.id)).map((s) => ({ step_id: s.id, reason: "You removed this step before the run." })),
      ...steps.filter((s) => !attempted.includes(s.id)).map((s) => ({ step_id: s.id, reason: "Not run: the run was stopped." })),
    ];
    emit(t, "run_recap", {
      headline: stopped
        ? `Stopped after ${completed.length} of ${steps.length} approved steps.`
        : `Done. Completed ${completed.length} of ${steps.length} approved steps.`,
      done: completed.map((id) => ({ step_id: id, text: summaries.get(id)! })),
      skipped,
      source: "fallback",
    }, runId);
    const final = stopped
      ? { status: "stopped" as const, message: "Run stopped by the user. Remaining approved steps were not attempted.", attempted, completed }
      : { status: "completed" as const, message: "All approved steps were attempted.", attempted, completed };
    const rec = t.runs.find((r) => r.id === runId);
    if (rec) Object.assign(rec, { status: final.status, finished_at: new Date().toISOString(), final });
    emit(t, "final_result", final, runId);
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A small deterministic stand-in for the agent's window capture. */
function frameSvg(title: string, verb: string, target: string, n: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">` +
    `<rect width="640" height="400" fill="#101010"/>` +
    `<rect width="640" height="28" fill="#1d1d1d"/>` +
    `<circle cx="16" cy="14" r="5" fill="#e46a5c"/><circle cx="32" cy="14" r="5" fill="#e8a948"/><circle cx="48" cy="14" r="5" fill="#5fc48a"/>` +
    `<text x="68" y="18" fill="#8f8f8f" font-family="sans-serif" font-size="12">agent desk · simulated</text>` +
    `<text x="24" y="84" fill="#ececec" font-family="sans-serif" font-size="20">${esc(title)}</text>` +
    `<text x="24" y="118" fill="#8f8f8f" font-family="sans-serif" font-size="14">action ${n}: ${esc(verb)} ${esc(target)}</text>` +
    `<rect x="24" y="150" width="592" height="220" rx="10" fill="#1b1b1b" stroke="#262626"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
