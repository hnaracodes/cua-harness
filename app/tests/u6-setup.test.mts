// app/tests/u6-setup.test.mts. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { canContinue, canSkipPlanOnly, permsOk, planOnlyPatch, POLL_STEPS, STEPS, waitingText } from "../src/setup/gating.ts";
import type { SetupStatus } from "../src/api/types.ts";

const st = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  platform: "macos",
  key: { provider: "anthropic", present: false, source: "none", tested: false, warning: null },
  driver: { installed: true, version: "0.32.0", running: false },
  permissions: { accessibility: "unknown", screen_recording: "unknown" },
  self_test: { passed_at: null },
  plan_only: false, complete: false, ...over,
});

test("order and labels", () => {
  assert.deepEqual(STEPS.map((x) => x.key), ["welcome", "key", "driver", "permissions", "selftest"]);
  assert.deepEqual(STEPS.map((x) => x.label), ["Welcome", "Model key", "cua-driver", "Permissions", "Self-test"]);
});

test("canContinue gates each step on the daemon's status", () => {
  assert.equal(canContinue("welcome", null), true);
  assert.equal(canContinue("key", null), false);
  assert.equal(canContinue("key", st({ key: { provider: "anthropic", present: true, source: "keychain", tested: false, warning: null } })), false);
  assert.equal(canContinue("key", st({ key: { provider: "anthropic", present: true, source: "keychain", tested: true, warning: null } })), true);
  assert.equal(canContinue("driver", st()), false);
  assert.equal(canContinue("driver", st({ driver: { installed: true, version: "x", running: true } })), true);
  assert.equal(canContinue("permissions", st({ permissions: { accessibility: "granted", screen_recording: "denied" } })), false);
  assert.equal(canContinue("permissions", st({ permissions: { accessibility: "granted", screen_recording: "granted" } })), true);
  assert.equal(canContinue("selftest", st({ self_test: { passed_at: "2026-10-02T00:00:00Z" } })), true);
});

test("non-macOS: n/a permissions pass", () => {
  assert.equal(permsOk(st({ platform: "linux", permissions: { accessibility: "n/a", screen_recording: "n/a" } })), true);
});

test("plan-only skip is offered from the cua-driver step on; polling only where status changes outside the app", () => {
  assert.deepEqual(STEPS.map((x) => canSkipPlanOnly(x.key)), [false, false, true, true, true]);
  assert.deepEqual(POLL_STEPS, ["driver", "permissions"]);
});

test("waitingText names what is missing", () => {
  assert.equal(waitingText("permissions", st({ permissions: { accessibility: "granted", screen_recording: "unknown" } })), "Waiting for Screen Recording…");
  assert.equal(waitingText("driver", st()), "Waiting for cua-driver to start…");
  assert.equal(waitingText("permissions", st({ permissions: { accessibility: "granted", screen_recording: "granted" } })), null);
});

test("finishing setup: skip sets plan-only, a full finish clears it, otherwise leave settings alone", () => {
  assert.deepEqual(planOnlyPatch(true, st()), { plan_only: true });
  assert.deepEqual(planOnlyPatch(false, st({ plan_only: true })), { plan_only: false });
  assert.equal(planOnlyPatch(false, st({ plan_only: false })), null);
  assert.equal(planOnlyPatch(false, null), null);
});
