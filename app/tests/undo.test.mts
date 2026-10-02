import assert from "node:assert/strict";
import { test } from "node:test";
import { UNDO_LIMIT, UndoHistory } from "../src/canvas/undo.ts";

test("undo is per axis pair, LIFO, deep-copied, capped", () => {
  const u = new UndoHistory();
  const poly: [number, number][] = [[0, 0], [1, 0], [1, 1]];
  u.push("a|b", null);
  u.push("a|b", poly);
  poly[0][0] = 0.5; // later mutation must not leak into history
  u.push("c|d", [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]);
  assert.deepEqual(u.pop("a|b"), { ok: true, poly: [[0, 0], [1, 0], [1, 1]] });
  assert.deepEqual(u.pop("a|b"), { ok: true, poly: null });
  assert.deepEqual(u.pop("a|b"), { ok: false });
  assert.equal(u.size("c|d"), 1);
  for (let i = 0; i < UNDO_LIMIT + 10; i++) u.push("x", null);
  assert.equal(u.size("x"), UNDO_LIMIT);
});
