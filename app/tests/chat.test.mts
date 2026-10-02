// Run: npm test. Pure mapping from the event stream to chat messages (track U2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsToMessages } from "../src/chat/eventsToMessages.ts";
import type { OversightEvent, Step } from "../src/api/types.ts";
import type { ChatMessage } from "../src/chat/types.ts";

const steps: Step[] = [1, 2, 3].map((i) => ({
  id: `s${i}`, task_id: "t", index: i, title: `Step ${i}`, description: "d", glyph: "generic",
  status: "pending", edited_from: null, revision: 0,
}));
const T0 = Date.parse("2026-10-02T10:00:00Z");

function stream() {
  let seq = 0;
  return (kind: OversightEvent["kind"], payload: object, run_id: string | null = null): OversightEvent => {
    seq += 1;
    return { kind, task_id: "t", run_id, seq, ts: new Date(T0 + seq * 1000).toISOString(), payload: payload as Record<string, unknown> };
  };
}

function planEvents(ev: ReturnType<typeof stream>): OversightEvent[] {
  return [
    ev("plan_progress", { stage: "planning", message: "Generating plan.", done: 0, total: 0 }),
    ev("cost", { scope: "plan", model: "m", usd_delta: 0.01, usd_total: 0.01, latency_ms: 1, input_tokens: 1, output_tokens: 1 }),
    ev("plan_progress", { stage: "scoring", message: "Scoring.", done: 0, total: 3 }),
    ev("plan_progress", { stage: "scoring", message: "Scored step 3.", done: 3, total: 3 }),
    ev("plan_progress", { stage: "done", message: "3 steps scored.", done: 3, total: 3 }),
  ];
}

function runEvents(ev: ReturnType<typeof stream>, withRecap: boolean, legacy = false): OversightEvent[] {
  const r = "r1";
  const res = (id: string, index: number, status: string, summary: string, actions: number, ms: number) =>
    ev("step_result", legacy ? { step_id: id, index, status, summary } : { step_id: id, index, status, summary, actions, duration_ms: ms }, r);
  const out = [
    ev("consideration_scored", { step_count: 3, dimension_count: 10, approved_count: 2 }, r),
    ev("step_removed", { step_id: "s3", index: 3, title: "Step 3" }, r),
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }, r),
    ev("action", { step_id: "s1", n: 1, mode: "sim", verb: "type", target: "search", detail: "", ok: true, error: null }, r),
    ev("action", { step_id: "s1", n: 2, mode: "sim", verb: "click", target: "go", detail: "", ok: true, error: null }, r),
    ev("cost", { scope: "run", model: "m", usd_delta: 0.02, usd_total: 0.03, latency_ms: 1, input_tokens: 1, output_tokens: 1 }, r),
    res("s1", 1, "done", "Found 4 rackets under $100.", 2, 1500),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }, r),
    ev("action", { step_id: "s2", n: 3, mode: "sim", verb: "click", target: "racket", detail: "", ok: true, error: null }, r),
  ];
  if (legacy) {
    out.push(ev("step_result", { step_id: "s2", index: 2, status: "stopped", summary: "Stopped by the user." }, r));
    out.push(ev("final_result", { status: "stopped", message: "Stopped by the user.", attempted: ["s1", "s2"], completed: ["s1"] }, r));
    return out;
  }
  out.push(res("s2", 2, "done", "Picked the Head Ti.S6 ($64).", 1, 800));
  if (withRecap)
    out.push(ev("run_recap", { headline: "Done. Here's what happened", done: [{ step_id: "s1", text: "Found it." }], skipped: [{ step_id: "s3", reason: "You left it out." }], source: "llm" }, r));
  out.push(ev("final_result", { status: "completed", message: "All approved steps were attempted.", attempted: ["s1", "s2"], completed: ["s1", "s2"] }, r));
  return out;
}

const kinds = (m: ChatMessage[]) => m.map((x) => x.kind);
const input = (events: OversightEvent[], planError: string | null = null) => ({ prompt: "Find a racket", attachments: [], steps, events, planError });

test("planning line shows only while planning is in progress", () => {
  const ev = stream();
  const plan = planEvents(ev);
  assert.deepEqual(kinds(eventsToMessages(input(plan.slice(0, 3)))), ["user", "planning"]);
  const mid = eventsToMessages(input(plan.slice(0, 4)));
  const line = mid[1] as Extract<ChatMessage, { kind: "planning" }>;
  assert.equal(line.id, "planning-1");
  assert.equal(line.done, 3);
  const full = eventsToMessages(input(plan));
  assert.deepEqual(kinds(full), ["user", "plan_ready"]);
  assert.deepEqual(full[1], { kind: "plan_ready", id: "plan-5", stepCount: 3, revision: 0 });
});

test("live run maps in order with a stored recap", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m), ["user", "plan_ready", "run_started", "step_done", "step_done", "recap"]);
  const started = m[2] as Extract<ChatMessage, { kind: "run_started" }>;
  assert.deepEqual([started.approvedIndexes, started.skippedIndexes], [[1, 2], [3]]);
  const s1 = m[3] as Extract<ChatMessage, { kind: "step_done" }>;
  assert.deepEqual([s1.index, s1.status, s1.actions, s1.durationMs], [1, "done", 2, 1500]);
  const recap = m[5] as Extract<ChatMessage, { kind: "recap" }>;
  assert.equal(recap.recap.source, "llm");
  assert.equal(recap.actions, 3);
  assert.equal(recap.costUsd, 0.02);
  assert.equal(recap.final?.status, "completed");
  assert.equal(recap.durationMs, (all[all.length - 1].seq - all[5].seq) * 1000);
});

test("a step in progress shows a running line until its result", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const upToS1Action = all.slice(0, all.findIndex((e) => e.kind === "action") + 1);
  const m = eventsToMessages(input(upToS1Action));
  const last = m[m.length - 1] as Extract<ChatMessage, { kind: "step_running" }>;
  assert.equal(last.kind, "step_running");
  assert.equal(last.index, 1);
  assert.ok(!eventsToMessages(input(all)).some((x) => x.kind === "step_running"));
});

test("replay is identical and ids are stable while the stream grows", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const full = eventsToMessages(input(all));
  assert.deepEqual(eventsToMessages(input(all)), full);
  const fullIds = new Set(full.map((x) => x.id));
  for (let k = 1; k <= all.length; k++) {
    for (const msg of eventsToMessages(input(all.slice(0, k)))) {
      if (msg.kind === "planning" || msg.kind === "step_running") continue;
      assert.ok(fullIds.has(msg.id), `prefix ${k} produced ${msg.id} which the full stream does not have`);
    }
  }
});

test("revise: the instruction becomes a user message and no second plan_ready appears", () => {
  const ev = stream();
  const all = [
    ...planEvents(ev),
    ev("plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: 3 }),
    ev("plan_revised", { revision: 1, instruction: "Only message the party group", changed_step_ids: ["s2"], added_step_ids: ["s9"], dropped_step_ids: ["s0"] }),
    ev("plan_progress", { stage: "done", message: "Plan revised.", done: 3, total: 3 }),
  ];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m), ["user", "plan_ready", "user", "revised"]);
  assert.equal((m[2] as Extract<ChatMessage, { kind: "user" }>).text, "Only message the party group");
  assert.deepEqual(m[3], { kind: "revised", id: "revised-7", instruction: "Only message the party group", changed: [2], added: [], dropped: 1 });
});

test("eventsToMessages: legacy stream (no run_recap, no actions/duration_ms) synthesizes a fallback recap", () => {
  const ev = stream();
  const m = eventsToMessages(input([...planEvents(ev), ...runEvents(ev, false, true)]));
  const done = m.filter((x) => x.kind === "step_done") as Extract<ChatMessage, { kind: "step_done" }>[];
  assert.deepEqual(done.map((d) => [d.index, d.status, d.actions, d.durationMs]), [[1, "done", null, null], [2, "stopped", null, null]]);
  const recap = m[m.length - 1] as Extract<ChatMessage, { kind: "recap" }>;
  assert.equal(recap.kind, "recap");
  assert.equal(recap.recap.source, "fallback");
  assert.equal(recap.recap.headline, "Stopped. Here's what got done");
  assert.deepEqual(recap.recap.done, [{ step_id: "s1", text: "Found 4 rackets under $100." }]);
  assert.deepEqual(recap.recap.skipped, [
    { step_id: "s3", reason: "You left this step out." },
    { step_id: "s2", reason: "Stopped by the user." },
  ]);
});

test("a failed step adds a warning notice", () => {
  const ev = stream();
  const all = [
    ...planEvents(ev),
    ev("consideration_scored", { step_count: 3, dimension_count: 10, approved_count: 3 }, "r1"),
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }, "r1"),
    ev("step_result", { step_id: "s1", index: 1, status: "failed", summary: "Login wall." }, "r1"),
    ev("final_result", { status: "failed", message: "A step failed.", attempted: ["s1"], completed: [] }, "r1"),
  ];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m).slice(-3), ["step_done", "notice", "recap"]);
  assert.equal((m[m.length - 2] as Extract<ChatMessage, { kind: "notice" }>).tone, "warn");
});

test("planError from the session shows once, and not on top of a streamed error", () => {
  const ev = stream();
  const started = [ev("plan_progress", { stage: "planning", message: "Generating plan.", done: 0, total: 0 })];
  assert.deepEqual(kinds(eventsToMessages(input(started, "Planning failed: 502"))), ["user", "planning", "plan_error"]);
  const streamed = [...started, ev("plan_progress", { stage: "error", message: "model refused", done: 0, total: 0 })];
  const m = eventsToMessages(input(streamed, "Planning failed: 502"));
  assert.deepEqual(kinds(m), ["user", "plan_error"]);
  assert.equal((m[1] as Extract<ChatMessage, { kind: "plan_error" }>).error, "model refused");
});

test("a finished run's approved line comes from its own events, so revising afterwards never rewrites it", () => {
  const ev = stream();
  const all = [
    ...planEvents(ev),
    ...runEvents(ev, true),
    ev("plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: 4 }),
    ev("plan_revised", { revision: 1, instruction: "Check the reviews first", changed_step_ids: [], added_step_ids: ["s0"], dropped_step_ids: [] }),
    ev("plan_progress", { stage: "done", message: "Plan revised.", done: 4, total: 4 }),
  ];
  const before = eventsToMessages(input(all.slice(0, planEvents(stream()).length + runEvents(stream(), true).length)));
  const line = (m: ChatMessage[]) => m.find((x) => x.kind === "run_started") as Extract<ChatMessage, { kind: "run_started" }>;
  assert.deepEqual([line(before).approvedIndexes, line(before).skippedIndexes], [[1, 2], [3]]);
  // The revise put a new step first, so every old step moved down one index.
  const revised: Step[] = [
    { ...steps[0], id: "s0", index: 1, title: "Check reviews" },
    ...steps.map((x) => ({ ...x, index: x.index + 1 })),
  ];
  const after = eventsToMessages({ prompt: "Find a racket", attachments: [], steps: revised, events: all, planError: null });
  assert.deepEqual(line(after), line(before));
});

test("a run still in progress lists approved steps that have not started yet", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const upToS1Action = all.slice(0, all.findIndex((e) => e.kind === "action") + 1);
  const started = eventsToMessages(input(upToS1Action)).find((x) => x.kind === "run_started") as Extract<ChatMessage, { kind: "run_started" }>;
  assert.deepEqual([started.approvedIndexes, started.skippedIndexes], [[1, 2], [3]]);
});
