// Run: npm test  (node's built-in runner; node >= 22.18 strips the TS types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { pointInPolygon, simplifyClosedStroke, simplifyStrokePreserving } from "../src/lib/geometry.ts";

type P = [number, number];

// Circle strokes with a dent of varying width/depth and a probe sitting in the
// dent. Plain RDP cuts the dent and flips the probe on release; the preserving
// simplifier must not. (Shape from the adversarial review, scratchpad/parity/rdp2.js.)
function dentCases() {
  const out: { strokePx: P[]; stroke: P[]; probesPx: P[]; probes: P[] }[] = [];
  const W = 600, H = 320;
  const toNorm = (p: P): P => [p[0] / W, 1 - p[1] / H];
  for (const width of [10, 15, 20, 30, 40]) for (const depth of [0.6, 0.7, 0.8, 0.85]) for (const start of [0, 37, 90, 200]) {
    const cx = 300, cy = 160, R = 120;
    const strokePx: P[] = [];
    for (let k = 0; k < 360; k += 2) {
      const i = (k + start) % 360;
      const a = (i * Math.PI) / 180;
      const dd = Math.min(i, 360 - i);
      const r = dd < width ? R * (depth + ((1 - depth) * dd) / width) : R;
      strokePx.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    const probesPx: P[] = [0.5, 0.9, 0.95].map((f) => [cx + f * R, cy] as P);
    probesPx.push([cx, cy], [cx + 2 * R, cy]);
    out.push({ strokePx, stroke: strokePx.map(toNorm), probesPx, probes: probesPx.map(toNorm) });
  }
  return out;
}

test("plain RDP does flip probes in dents (the bug this guards against)", () => {
  let flips = 0;
  for (const c of dentCases()) {
    const simp = simplifyClosedStroke(c.strokePx, 6, 10);
    c.probesPx.forEach((q) => {
      if (pointInPolygon(q[0], q[1], c.strokePx) !== pointInPolygon(q[0], q[1], simp)) flips++;
    });
  }
  assert.ok(flips > 0);
});

test("preserving simplifier never changes a probe's classification on release", () => {
  for (const c of dentCases()) {
    const poly = simplifyStrokePreserving(c.stroke, c.strokePx, c.probes, c.probesPx, 6, 10);
    assert.ok(poly.length >= 3);
    c.probes.forEach((q) => {
      assert.equal(pointInPolygon(q[0], q[1], poly), pointInPolygon(q[0], q[1], c.stroke));
    });
    // Vertices are exact stroke points, in stroke order.
    const idx = poly.map((v) => c.stroke.indexOf(v));
    assert.ok(idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1])));
  }
});

test("with no disagreement it stays a handful of handles", () => {
  const strokePx: P[] = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    strokePx.push([300 + 100 * Math.cos(a), 160 + 100 * Math.sin(a)]);
  }
  const stroke = strokePx.map((p) => [p[0] / 600, 1 - p[1] / 320] as P);
  const poly = simplifyStrokePreserving(stroke, strokePx, [[0.5, 0.5]], [[300, 160]], 6, 10);
  assert.ok(poly.length >= 6 && poly.length <= 10, String(poly.length));
});
