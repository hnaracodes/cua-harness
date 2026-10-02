// Run: npm test. tauri.ts has no top-level value imports (Tauri APIs load lazily),
// so node can import it directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonLogTail, daemonStatus, pollUntil } from "../src/lib/tauri.ts";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("pollUntil resolves true as soon as the probe succeeds", async () => {
  const c = fakeClock();
  let n = 0;
  const ok = await pollUntil(async () => ++n === 3, { intervalMs: 500, timeoutMs: 30_000, ...c });
  assert.equal(ok, true);
  assert.equal(n, 3);
  assert.equal(c.now(), 1000);
});

test("pollUntil gives up at the timeout", async () => {
  const c = fakeClock();
  let n = 0;
  const ok = await pollUntil(async () => (n++, false), { intervalMs: 500, timeoutMs: 2000, ...c });
  assert.equal(ok, false);
  assert.equal(n, 5); // t = 0, 500, 1000, 1500, 2000
});

test("outside Tauri the bridge is inert", async () => {
  assert.equal(await daemonStatus(), null);
  assert.equal(await daemonLogTail(10), "");
});
