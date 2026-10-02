import assert from "node:assert/strict";
import { test } from "node:test";
import { fanOutPositions, groupStacks, minSeparation, splitScale, stackStatus, type Pt } from "../src/lib/stacks.ts";

const R = 13;
const SEP = minSeparation(R); // 24
const at = (id: string, p: Pt, s = 1) => ({ id, px: [p[0] * s, p[1] * s] as Pt });

test("8 identical points are one stack ×8 at every zoom (exact ties never split)", () => {
  for (const s of [0.5, 1, 8, 1000]) {
    const st = groupStacks(Array.from({ length: 8 }, (_, i) => at(`s${i}`, [100, 100], s)), SEP);
    assert.equal(st.length, 1);
    assert.equal(st[0].ids.length, 8);
  }
});

test("near-ties stack at 1x and split above splitScale", () => {
  const a: Pt = [100, 100], b: Pt = [110, 100];
  assert.equal(splitScale(a, b, SEP), 2.4);
  assert.equal(groupStacks([at("a", a, 2), at("b", b, 2)], SEP).length, 1);
  assert.equal(groupStacks([at("a", a, 2.5), at("b", b, 2.5)], SEP).length, 2);
  assert.equal(splitScale(a, a, SEP), Infinity);
});

test("chains join, output is deterministic regardless of input order", () => {
  const items = [at("c", [140, 100]), at("a", [100, 100]), at("b", [120, 100]), at("z", [400, 400])];
  const one = groupStacks(items, SEP);
  const two = groupStacks([...items].reverse(), SEP);
  assert.deepEqual(one, two);
  assert.deepEqual(one.map((s) => s.ids), [["a", "b", "c"], ["z"]]);
  assert.equal(one[0].key, "a+b+c");
});

test("stackStatus: shared or mixed", () => {
  assert.equal(stackStatus(["a", "b"], { a: "approved", b: "approved" }, "pending"), "approved");
  assert.equal(stackStatus(["a", "b"], { a: "approved", b: "pending" }, "pending"), "mixed");
});

test("fan-out ring: members never touch each other or the center", () => {
  for (let n = 1; n <= 8; n++) {
    const pos = fanOutPositions([0, 0], n, R);
    assert.equal(pos.length, n);
    for (const p of pos) assert.ok(Math.hypot(p[0], p[1]) >= 2 * R - 1e-9);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
      assert.ok(Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) >= 2 * R - 1e-9);
  }
});
