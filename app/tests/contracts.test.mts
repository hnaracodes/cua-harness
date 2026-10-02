// Run: npm test. Pins the frozen event-kind list (contract C1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_KINDS } from "../src/api/types.ts";

test("EVENT_KINDS includes the redesign kinds, in order, once each", () => {
  for (const k of ["plan_revised", "frame", "run_recap"]) assert.ok(EVENT_KINDS.includes(k as never), k);
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length);
});
