// Run: npm test. Pure reducer for the session layer (contract C5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialSession, sessionReducer, stopRun, type SessionAction, type SessionState } from "../src/state/session.ts";
import type { OversightEvent, Step, TaskDetail } from "../src/api/types.ts";

const step = (i: number, status: Step["status"] = "pending"): Step => ({
  id: `s${i}`, task_id: "t", index: i, title: `T${i}`, description: "d", glyph: "generic",
  status, edited_from: null, revision: 0,
});
const ev = (seq: number, kind: OversightEvent["kind"], run_id: string | null = null, payload = {}): OversightEvent => ({
  kind, task_id: "t", run_id, seq, ts: "2026-10-02T00:00:00Z", payload,
});
const review = (): SessionState =>
  sessionReducer(sessionReducer(initialSession, { type: "start_task", taskId: "t", prompt: "p", attachments: [] }),
    { type: "plan_loaded", steps: [step(2), step(1)], scores: [] });

test("start_task then plan_loaded: review with steps sorted by index", () => {
  const s = review();
  assert.equal(s.phase, "review");
  assert.deepEqual(s.steps.map((x) => x.id), ["s1", "s2"]);
});

test("event dedupe by seq, and final_result of the current run ends the run", () => {
  let s = sessionReducer(review(), { type: "run_started", run: { runId: "r1", approvedIds: ["s1"], removedIds: [] } });
  s = sessionReducer(s, { type: "event", event: ev(1, "step_started", "r1") });
  s = sessionReducer(s, { type: "event", event: ev(1, "step_started", "r1") });
  assert.equal(s.events.length, 1);
  s = sessionReducer(s, { type: "event", event: ev(2, "final_result", "r_other") });
  assert.equal(s.phase, "running");
  s = sessionReducer(s, { type: "event", event: ev(3, "final_result", "r1") });
  assert.equal(s.phase, "done");
});

test("remove clears checked; restore brings back pending; check_all skips removed", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "remove", stepId: "s1" });
  assert.ok(!s.checked.has("s1") && s.removed.has("s1"));
  s = sessionReducer(s, { type: "check_all" });
  assert.deepEqual([...s.checked], ["s2"]);
  s = sessionReducer(s, { type: "restore", stepId: "s1" });
  assert.ok(!s.removed.has("s1"));
});

test("plan_revised filters vanished ids and keeps polygons", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "remove", stepId: "s2" });
  s = sessionReducer(s, { type: "set_polygon", key: "a|b", polygon: [[0, 0], [1, 0], [1, 1]] });
  s = sessionReducer(s, { type: "select", stepId: "s2" });
  s = sessionReducer(s, { type: "plan_revised", steps: [step(1, "approved"), step(3)], scores: [] });
  assert.deepEqual([...s.checked], ["s1"]);
  assert.equal(s.removed.size, 0);
  assert.equal(s.selectedId, null);
  assert.ok(s.polygons["a|b"]);
});

test("plan_revised drops checks on steps the daemon reset; step_edited unchecks", () => {
  let s = sessionReducer(review(), { type: "check", stepId: "s1", on: true });
  s = sessionReducer(s, { type: "check", stepId: "s2", on: true });
  s = sessionReducer(s, { type: "plan_revised", steps: [step(1, "approved"), step(2, "pending")], scores: [] });
  assert.deepEqual([...s.checked], ["s1"]);
  s = sessionReducer(s, { type: "step_edited", step: step(1, "pending"), scores: [] });
  assert.equal(s.checked.size, 0);
});

test("load_task maps a finished task to done with its run and boundaries", () => {
  const detail: TaskDetail = {
    task: { id: "t", prompt: "p", selected_app: null, created_at: "", mode: "live", attachments: [] },
    steps: [step(1, "approved"), step(2, "removed")],
    scores: [],
    boundaries: [{ x_dim: "a", y_dim: "b", polygon: [[0, 0], [1, 0], [1, 1]] }, { x_dim: "c", y_dim: "d", polygon: [] }],
    runs: [{ id: "r1", task_id: "t", status: "completed", exec_mode: "simulated", approved: ["s1"], removed: ["s2"], started_at: "", finished_at: "x", final: null }],
    cost_usd: 0,
  };
  const s = sessionReducer(initialSession, { type: "load_task", detail });
  assert.equal(s.phase, "done");
  assert.equal(s.run?.runId, "r1");
  assert.deepEqual(Object.keys(s.polygons), ["a|b"]);
  assert.ok(s.checked.has("s1") && s.removed.has("s2"));
});

const detailFor = (finished: boolean): TaskDetail => ({
  task: { id: "t", prompt: "p", selected_app: null, created_at: "", mode: "live", attachments: [] },
  steps: [step(1, "approved"), step(2, "approved")],
  scores: [],
  boundaries: [],
  runs: [{ id: "r1", task_id: "t", status: finished ? "stopped" : "running", exec_mode: "live", approved: ["s1", "s2"], removed: [],
    started_at: "", finished_at: finished ? "x" : null, final: null }],
  cost_usd: 0,
});

/** A tiny store around the pure reducer, standing in for useReducer. */
function harness(start: SessionState) {
  let s = start;
  return { get: () => s, dispatch: (a: SessionAction) => { s = sessionReducer(s, a); } };
}

const running = () => {
  let s = sessionReducer(review(), { type: "run_started", run: { runId: "r1", approvedIds: ["s1", "s2"], removedIds: [] } });
  s = sessionReducer(s, { type: "event", event: ev(1, "step_started", "r1") });
  return s;
};

test("stop: a daemon that has no such run (it restarted) makes the UI reload the task instead of spinning", async () => {
  const h = harness(running());
  const calls: string[] = [];
  const api = {
    stop: async (t: string) => { calls.push(`stop ${t}`); return { stopped: false }; },
    getTask: async (t: string) => { calls.push(`getTask ${t}`); return detailFor(true); },
  };
  await stopRun(api, h.get, h.dispatch);
  assert.deepEqual(calls, ["stop t", "getTask t"]);
  assert.equal(h.get().phase, "done");
  assert.equal(h.get().run?.runId, "r1");
  // Same task, same SSE subscription: the events already received stay in the chat.
  assert.equal(h.get().events.length, 1);
});

test("stop: a run the daemon did stop is left to the stream; failures become a notice", async () => {
  const h = harness(running());
  let reloaded = false;
  await stopRun({ stop: async () => ({ stopped: true }), getTask: async () => { reloaded = true; return detailFor(true); } }, h.get, h.dispatch);
  assert.equal(reloaded, false);
  assert.equal(h.get().phase, "running");
  await stopRun({ stop: async () => { throw new Error("offline"); }, getTask: async () => detailFor(true) }, h.get, h.dispatch);
  assert.equal(h.get().notice, "Stopping failed: offline");
  // {stopped:false} after the final event already landed: nothing to reload.
  const done = harness(sessionReducer(running(), { type: "event", event: ev(2, "final_result", "r1") }));
  await stopRun({ stop: async () => ({ stopped: false }), getTask: async () => { reloaded = true; return detailFor(true); } }, done.get, done.dispatch);
  assert.equal(reloaded, false);
});

test("after a reconnect the resubscribe replays old events and the run's final_result ends it", () => {
  let s = running();
  s = sessionReducer(s, { type: "event", event: ev(2, "step_result", "r1") });
  // Connection drops; the SSE stream resumes and replays from an earlier seq.
  for (const e of [ev(1, "step_started", "r1"), ev(2, "step_result", "r1"), ev(3, "step_result", "r1"), ev(4, "final_result", "r1")])
    s = sessionReducer(s, { type: "event", event: e });
  assert.deepEqual(s.events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(s.phase, "done");
});

test("load_task of a different task starts with no events", () => {
  const s = sessionReducer(running(), { type: "load_task", detail: { ...detailFor(true), task: { ...detailFor(true).task, id: "other" } } });
  assert.equal(s.events.length, 0);
  assert.equal(s.taskId, "other");
});
