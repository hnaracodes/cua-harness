// Run: npm test. The primary button always says exactly what will run (track U4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionHint, primaryAction, showSecondaryApproveAll } from "../src/workspace/ActionBar.logic.ts";

const c = (approved: number, pending: number, removed = 0) => ({ approved, pending, removed });
const ok = { cua_driver: true, exec_mode: "live" };

test("nothing approved: the primary slot is Approve all N", () => {
  assert.deepEqual(primaryAction(c(0, 6), ok, false), { kind: "approve_all", label: "Approve all 6", disabled: false, testId: "approve-all" });
  assert.equal(primaryAction(c(0, 0, 3), ok, false).disabled, true);
  // K = 0 wins over plan-only and permissions: there is nothing to run yet.
  assert.equal(primaryAction(c(0, 2), { cua_driver: false, exec_mode: "live" }, true).kind, "approve_all");
});

test("plan-only, then missing permissions, then starting", () => {
  assert.equal(primaryAction(c(3, 0), ok, true).label, "Set up the agent to run this");
  assert.equal(primaryAction(c(3, 1), { cua_driver: false, exec_mode: "live" }, false).label, "Fix permissions to run");
  assert.equal(primaryAction(c(3, 0), { cua_driver: false, exec_mode: "simulated" }, false).label, "Approve & run");
  assert.deepEqual(primaryAction(c(3, 0), ok, false, true), { kind: "starting", label: "Starting…", disabled: true, testId: "run-primary" });
});

test("run labels say exactly what runs", () => {
  assert.deepEqual(primaryAction(c(3, 0, 1), ok, false), { kind: "run", label: "Approve & run", disabled: false, testId: "run-primary" });
  assert.deepEqual(primaryAction(c(3, 2), null, false), { kind: "skip_and_run", label: "Run 3 approved, skip 2", disabled: false, testId: "run-primary" });
});

test("hint and secondary button", () => {
  assert.equal(decisionHint(c(3, 0)), null);
  assert.equal(decisionHint(c(3, 1)), "1 step still needs a decision");
  assert.equal(decisionHint(c(3, 2)), "2 steps still need a decision");
  assert.equal(showSecondaryApproveAll(c(3, 2)), true);
  assert.equal(showSecondaryApproveAll(c(0, 2)), false);
  assert.equal(showSecondaryApproveAll(c(3, 0)), false);
});
