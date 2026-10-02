// Run: npm test. What the agent's-desk panel shows (track U5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deskLabel, deskState } from "../src/workspace/DeskView.logic.ts";
import type { OversightEvent, Step } from "../src/api/types.ts";

const steps: Step[] = [1, 2, 3, 4].map((i) => ({
  id: `s${i}`, task_id: "t", index: i, title: `Step ${i}`, description: "d", glyph: "generic",
  status: "pending", edited_from: null, revision: 0,
}));
const run = { runId: "r1", approvedIds: ["s1", "s2", "s4"], removedIds: ["s3"] };
let seq = 0;
const ev = (kind: OversightEvent["kind"], payload: object, run_id: string | null = "r1"): OversightEvent => ({
  kind, task_id: "t", run_id, seq: ++seq, ts: "2026-10-02T10:00:00Z", payload: payload as Record<string, unknown>,
});

test("before anything runs: all todo, no frame", () => {
  const d = deskState([], steps, run);
  assert.deepEqual([d.total, d.position, d.current, d.frameSeq, d.bars, d.finished], [3, 0, null, null, ["todo", "todo", "todo"], false]);
  assert.equal(deskLabel(d), "Starting…");
});

test("mid-run: active bar, position, latest frame of this run only", () => {
  const events = [
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }),
    ev("frame", { step_id: "s1", seq: 1 }),
    ev("step_result", { step_id: "s1", index: 1, status: "done", summary: "ok" }),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }),
    ev("frame", { step_id: "s2", seq: 2 }),
    ev("frame", { step_id: "x", seq: 99 }, "r_other"),
  ];
  const d = deskState(events, steps, run);
  assert.deepEqual(d.bars, ["done", "active", "todo"]);
  assert.deepEqual(d.current, { index: 2, title: "Step 2" });
  assert.equal(d.position, 2);
  assert.equal(d.frameSeq, 2);
  assert.equal(deskLabel(d), "step 2 of 3");
});

test("finished: failed and stopped bars, done count label", () => {
  const events = [
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }),
    ev("step_result", { step_id: "s1", index: 1, status: "done", summary: "ok" }),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }),
    ev("step_result", { step_id: "s2", index: 2, status: "stopped", summary: "Stopped by the user." }),
    ev("final_result", { status: "stopped", message: "m", attempted: ["s1", "s2"], completed: ["s1"] }),
  ];
  const d = deskState(events, steps, run);
  assert.deepEqual(d.bars, ["done", "stopped", "todo"]);
  assert.equal(d.finished, true);
  assert.equal(d.current, null);
  assert.equal(d.doneCount, 1);
  assert.equal(deskLabel(d), "1 of 3 done");
});
