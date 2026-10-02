// Daemon client. The app renders and captures gestures; everything else goes
// through here. Base URL from VITE_DAEMON_URL (default http://127.0.0.1:8765).
// Falls back to the in-browser mock when the daemon is unreachable or when
// VITE_MOCK=1.

import { HttpError } from "./errors";
import { createMockDaemon } from "./mock";
import {
  EVENT_KINDS,
  type AppSettings,
  type Attachment,
  type BoundaryBody,
  type DecisionBody,
  type Dimension,
  type Health,
  type OversightEvent,
  type PlanResponse,
  type Provider,
  type RunBody,
  type RunResult,
  type Score,
  type SetupStatus,
  type Step,
  type TaskDetail,
  type TaskSummary,
} from "./types";

export { HttpError } from "./errors";

export type EventListener = (ev: OversightEvent) => void;

export interface DaemonApi {
  mode: "live" | "mock";
  baseUrl: string;
  health(): Promise<Health>;
  dimensions(): Promise<Dimension[]>;
  createTask(prompt: string, selectedApp?: string | null, attachmentIds?: string[]): Promise<{ task_id: string }>;
  plan(taskId: string): Promise<PlanResponse>;
  putBoundary(taskId: string, b: BoundaryBody): Promise<{ boundary_id: string; inside_step_ids: string[] }>;
  decision(taskId: string, d: DecisionBody): Promise<{ ok: boolean }>;
  run(taskId: string, body: RunBody): Promise<RunResult>;
  stop(taskId: string): Promise<{ stopped: boolean }>;
  /** Replays stored events with seq > since, then streams live. Returns unsubscribe. */
  subscribe(taskId: string, since: number, onEvent: EventListener): () => void;
  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  uploadAttachment(file: Blob, name: string): Promise<Attachment>;
  attachmentUrl(attachmentId: string): string;
  repropose(taskId: string, instruction: string | null): Promise<PlanResponse>;
  editStep(taskId: string, stepId: string, patch: { title?: string; description?: string }): Promise<{ step: Step; scores: Score[] }>;
  frameUrl(taskId: string, seq: number): string;
  setupStatus(): Promise<SetupStatus>;
  setKey(provider: Provider, key: string): Promise<{ ok: boolean; error: string | null }>;
  installDriver(): Promise<{ ok: boolean; version: string | null; log_tail: string }>;
  startDriver(): Promise<{ ok: boolean; error: string | null }>;
  openPermission(which: "accessibility" | "screen_recording"): Promise<{ ok: boolean }>;
  selfTest(): Promise<{ ok: boolean; detail: string }>;
  completeSetup(): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  putSettings(patch: Partial<Pick<AppSettings, "provider" | "model" | "plan_only">>): Promise<AppSettings>;
}

export const DAEMON_URL: string = (import.meta.env.VITE_DAEMON_URL as string | undefined)?.replace(/\/$/, "") || "http://127.0.0.1:8765";
const FORCE_MOCK = import.meta.env.VITE_MOCK === "1" || new URLSearchParams(location.search).has("mock");

async function request<T>(base: string, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctl = new AbortController();
  const timer = init?.timeoutMs ? setTimeout(() => ctl.abort(), init.timeoutMs) : undefined;
  try {
    const res = await fetch(base + path, {
      ...init,
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text };
    }
    if (!res.ok) throw new HttpError(res.status, body);
    return body as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHttpDaemon(base: string): DaemonApi {
  const json = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    mode: "live",
    baseUrl: base,
    health: () => request<Health>(base, "/health", { timeoutMs: 3000 }),
    dimensions: async () => (await request<{ dimensions: Dimension[] }>(base, "/dimensions")).dimensions,
    createTask: (prompt, selectedApp = null, attachmentIds = []) =>
      request(base, "/task", json("POST", { prompt, selected_app: selectedApp, attachment_ids: attachmentIds })),
    plan: (taskId) => request<PlanResponse>(base, `/task/${taskId}/plan`, json("POST", {})),
    putBoundary: (taskId, b) => request(base, `/task/${taskId}/boundary`, json("PUT", b)),
    decision: (taskId, d) => request(base, `/task/${taskId}/decision`, json("POST", d)),
    async run(taskId, body) {
      try {
        const r = await request<{ run_id: string }>(base, `/task/${taskId}/run`, json("POST", body));
        return { ok: true, run_id: r.run_id };
      } catch (e) {
        if (e instanceof HttpError) {
          return {
            ok: false,
            status: e.status,
            error: String(e.body.error ?? e.message),
            expected: e.body.expected as string[] | undefined,
            got: e.body.got as string[] | undefined,
          };
        }
        return { ok: false, status: 0, error: (e as Error).message };
      }
    },
    stop: (taskId) => request(base, `/task/${taskId}/stop`, json("POST", {})),
    listTasks: async () => (await request<{ tasks: TaskSummary[] }>(base, "/tasks")).tasks,
    getTask: (taskId) => request<TaskDetail>(base, `/task/${taskId}`),
    async uploadAttachment(file, name) {
      const fd = new FormData();
      fd.append("file", file, name);
      const res = await fetch(`${base}/attachments`, { method: "POST", body: fd });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text };
      }
      if (!res.ok) throw new HttpError(res.status, body);
      return body as unknown as Attachment;
    },
    attachmentUrl: (id) => `${base}/attachments/${id}`,
    repropose: (taskId, instruction) => request<PlanResponse>(base, `/task/${taskId}/repropose`, json("POST", { instruction })),
    editStep: (taskId, stepId, patch) => request<{ step: Step; scores: Score[] }>(base, `/task/${taskId}/step/${stepId}`, json("PATCH", patch)),
    frameUrl: (taskId, seq) => `${base}/task/${taskId}/frames/${seq}.jpg`,
    setupStatus: () => request<SetupStatus>(base, "/setup/status", { timeoutMs: 8000 }),
    setKey: (provider, key) => request(base, "/setup/key", json("PUT", { provider, key })),
    installDriver: () => request(base, "/setup/driver/install", json("POST", {})),
    startDriver: () => request(base, "/setup/driver/start", json("POST", {})),
    openPermission: (which) => request(base, "/setup/permissions/open", json("POST", { which })),
    selfTest: () => request(base, "/setup/self-test", json("POST", {})),
    completeSetup: () => request(base, "/setup/complete", json("POST", {})),
    getSettings: () => request<AppSettings>(base, "/settings"),
    putSettings: (patch) => request<AppSettings>(base, "/settings", json("PUT", patch)),
    subscribe(taskId, since, onEvent) {
      let last = since;
      let es: EventSource | null = null;
      let closed = false;
      const handler = (m: MessageEvent) => {
        try {
          const ev = JSON.parse(m.data) as OversightEvent;
          if (typeof ev.seq === "number") {
            if (ev.seq <= last) return; // dedupe replays after reconnect
            last = ev.seq;
          }
          onEvent(ev);
        } catch {
          /* ignore malformed frames */
        }
      };
      const open = () => {
        if (closed) return;
        es = new EventSource(`${base}/task/${taskId}/events?since=${last}`);
        for (const k of EVENT_KINDS) es.addEventListener(k, handler as (e: Event) => void);
        es.onmessage = handler;
        es.onerror = () => {
          // Reconnect from the last seen seq instead of the original `since`.
          es?.close();
          if (!closed) setTimeout(open, 1000);
        };
      };
      open();
      return () => {
        closed = true;
        es?.close();
      };
    },
  };
}

/** Decide once at startup: the real daemon if it answers /health, else the mock. */
export async function connectDaemon(): Promise<DaemonApi> {
  if (FORCE_MOCK) return createMockDaemon();
  try {
    await request<Health>(DAEMON_URL, "/health", { timeoutMs: 1500 });
    return createHttpDaemon(DAEMON_URL);
  } catch {
    return createMockDaemon();
  }
}
