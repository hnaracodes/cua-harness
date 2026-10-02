// Run: npm test. One-line Details log entries for the recap card (track U2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEvent } from "../src/chat/formatEvent.ts";
import type { OversightEvent } from "../src/api/types.ts";

const e = (kind: OversightEvent["kind"], payload: object): OversightEvent => ({
  kind, task_id: "t", run_id: "r", seq: 1, ts: "2026-10-02T10:11:12.345Z", payload: payload as Record<string, unknown>,
});

test("formats the event kinds the log shows", () => {
  assert.equal(formatEvent(e("step_started", { step_id: "s1", index: 1, title: "Search" })), "10:11:12  ▸ step 1 started: Search");
  assert.equal(formatEvent(e("action", { step_id: "s1", n: 1, mode: "ax", verb: "click", target: "Go", detail: "", ok: false, error: "gone" })), "10:11:12      ✗ ax click Go (gone)");
  assert.equal(formatEvent(e("step_result", { step_id: "s1", index: 1, status: "done", summary: "Found 4." })), "10:11:12  ■ step 1 done: Found 4.");
  assert.equal(formatEvent(e("cost", { scope: "run", model: "claude-opus-5-5", usd_delta: 0.0123, usd_total: 1, latency_ms: 820, input_tokens: 1, output_tokens: 1 })), "10:11:12      $0.0123 claude-opus-5-5 820 ms");
  assert.equal(formatEvent(e("frame", { step_id: "s1", seq: 7 })), "10:11:12      frame 7");
  assert.equal(formatEvent(e("final_result", {})), "10:11:12  final_result");
});
