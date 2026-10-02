// Run: npm test. Pure helpers for the shell and home (track U1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ATTACHMENTS, providerLabel, validateImage } from "../src/home/attachmentRules.ts";
import { healthView } from "../src/shell/healthModel.ts";
import { latestCost, relTime, usd } from "../src/shell/format.ts";
import type { Health } from "../src/api/types.ts";

const MB = 1024 * 1024;

test("validateImage mirrors the daemon's rules, count first", () => {
  assert.equal(validateImage({ type: "image/png", size: 10 }, 0), null);
  assert.equal(validateImage({ type: "image/webp", size: 5 * MB }, 3), null);
  assert.match(validateImage({ type: "image/png", size: 10 }, MAX_ATTACHMENTS)!, /At most 4 images/);
  assert.match(validateImage({ type: "image/heic", size: 10 }, 0)!, /Unsupported type image\/heic/);
  assert.match(validateImage({ type: "", size: 10 }, 0)!, /Unsupported type unknown/);
  assert.match(validateImage({ type: "image/jpeg", size: 0 }, 0)!, /empty/);
  assert.match(validateImage({ type: "image/jpeg", size: 5 * MB + 1 }, 0)!, /5 MB or smaller/);
});

test("providerLabel", () => {
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("anthropic"), "Anthropic");
  assert.equal(providerLabel("fixtures"), "Anthropic");
  assert.equal(providerLabel(null), "Anthropic");
});

const base: Health = {
  daemon: "ok", api_key: true, provider: "anthropic", model: "claude-sonnet-5-5", cua_driver: true,
  fixtures: false, exec_mode: "live", cost_usd_total: 0, status_line: "Ready.", setup_complete: true, plan_only: false,
};

test("healthView: ready, missing key, plan-only, permissions, driver", () => {
  assert.deepEqual(healthView(base, true, null), { tone: "ok", label: "Ready", fix: null, reason: null });
  assert.equal(healthView({ ...base, api_key: false }, true, null).fix, "key");
  const po = healthView({ ...base, plan_only: true }, true, null);
  assert.equal(po.label, "Plan-only");
  assert.equal(po.fix, "driver");
  const perm = healthView({ ...base, cua_driver: false, cua_driver_detail: "permissions pending: Accessibility" }, true, null);
  assert.equal(perm.fix, "permissions");
  assert.equal(perm.label, "Permissions needed");
  const drv = healthView({ ...base, cua_driver: false, cua_driver_detail: "cua-driver daemon not running" }, true, null);
  assert.equal(drv.fix, "driver");
  // simulated executor or fixtures never nags about the driver
  assert.equal(healthView({ ...base, cua_driver: false, exec_mode: "simulated" }, true, null).tone, "ok");
  assert.equal(healthView({ ...base, cua_driver: false, fixtures: true }, true, null).tone, "ok");
});

test("healthView: transport and supervisor states win", () => {
  assert.deepEqual(healthView(base, false, null), { tone: "bad", label: "Reconnecting…", fix: null, reason: "The daemon is not answering." });
  assert.equal(healthView(null, true, null).label, "Connecting…");
  assert.equal(healthView(base, false, { state: "restarting", restarts: 1, last_error: "exit 1" }).label, "Restarting daemon…");
  const failed = healthView(base, false, { state: "failed", restarts: 3, last_error: null });
  assert.equal(failed.tone, "bad");
  assert.equal(failed.reason, "The daemon won't start.");
  assert.equal(healthView(base, true, { state: "running", restarts: 0, last_error: null }).label, "Ready");
  assert.equal(healthView(base, true, { state: "external", restarts: 0, last_error: null }).label, "Ready");
});

test("relTime, usd, latestCost", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(relTime("2026-10-02T11:59:30Z", now), "just now");
  assert.equal(relTime("2026-10-02T11:45:00Z", now), "15m ago");
  assert.equal(relTime("2026-10-02T09:00:00Z", now), "3h ago");
  assert.equal(relTime("2026-09-29T12:00:00Z", now), "3d ago");
  assert.equal(relTime("garbage", now), "");
  assert.equal(usd(0.10834), "$0.1083");
  assert.equal(usd(2.5), "$2.50");
  const evs = [
    { kind: "cost", payload: { usd_total: 0.01 } },
    { kind: "step_started", payload: {} },
    { kind: "cost", payload: { usd_total: 0.05 } },
  ];
  assert.equal(latestCost(evs, 9), 0.05);
  assert.equal(latestCost([], 9), 9);
});
