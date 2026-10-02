// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPoint } from "../src/lib/geometry.ts";
import {
  IDENTITY, MAX_SCALE, MIN_SCALE, centerOn, clampCamera, dataToScreen, fit, panBy, panStep, screenToData, visibleData, zoomAt,
  type Camera, type Pt,
} from "../src/lib/viewport.ts";

const plot = { x: 44, y: 16, w: 700, h: 400 };
const view = { w: 760, h: 456 };
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("identity maps data corners to plot corners, y up", () => {
  assert.deepEqual(dataToScreen([0, 0], plot, IDENTITY), [44, 416]);
  assert.deepEqual(dataToScreen([1, 1], plot, IDENTITY), [744, 16]);
});

test("screenToData inverts dataToScreen under any camera", () => {
  const cams: Camera[] = [IDENTITY, { scale: 3, tx: -500, ty: -200 }, { scale: 0.5, tx: 120, ty: 80 }];
  for (const c of cams)
    for (const p of [[0.1, 0.9], [0.5, 0.5], [0.97, 0.03]] as Pt[]) {
      const q = screenToData(dataToScreen(p, plot, c), plot, c);
      close(q[0], p[0]);
      close(q[1], p[1]);
    }
});

test("zoomAt keeps the point under the cursor fixed and clamps scale", () => {
  const anchor: Pt = [300, 200];
  const before = screenToData(anchor, plot, IDENTITY);
  let c = IDENTITY;
  for (let i = 0; i < 5; i++) c = zoomAt(c, 1.7, anchor);
  const after = screenToData(anchor, plot, c);
  close(after[0], before[0]);
  close(after[1], before[1]);
  assert.equal(zoomAt(IDENTITY, 1000, anchor).scale, MAX_SCALE);
  assert.equal(zoomAt(IDENTITY, 0.001, anchor).scale, MIN_SCALE);
});

test("four √2 zoom steps read as 400%", () => {
  let c = IDENTITY;
  for (let i = 0; i < 4; i++) c = zoomAt(c, Math.SQRT2, [400, 200]);
  assert.equal(Math.round(c.scale * 100), 400);
});

test("clampCamera keeps part of the plot on screen", () => {
  const c = clampCamera({ scale: 8, tx: 1e6, ty: -1e6 }, plot, view);
  assert.ok(plot.x * 8 + c.tx <= view.w - 64 + 1e-6);
  assert.ok((plot.y + plot.h) * 8 + c.ty >= 64 - 1e-6);
});

test("viewport: screenToData clamps under extreme camera (Review Focus 2)", () => {
  const c = clampCamera(panBy(zoomAt(IDENTITY, 8, [0, 0]), -40_000, 25_000), plot, view);
  for (let x = -50; x <= view.w + 50; x += 37)
    for (let y = -50; y <= view.h + 50; y += 29) {
      const p = clampPoint(screenToData([x, y], plot, c));
      assert.ok(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1, String(p));
    }
});

test("fit: empty or spread points give identity; a tight cluster zooms in, centered", () => {
  assert.deepEqual(fit([], plot, view), IDENTITY);
  assert.deepEqual(fit([[0, 0], [1, 1]], plot, view), IDENTITY);
  const c = fit([[0.1, 0.1], [0.14, 0.12]], plot, view, 48);
  assert.ok(c.scale > 1);
  const mid = dataToScreen([0.12, 0.11], plot, c);
  close(mid[0], plot.x + plot.w / 2);
  close(mid[1], plot.y + plot.h / 2);
});

test("centerOn and visibleData", () => {
  const c = centerOn({ scale: 2, tx: 0, ty: 0 }, [0.5, 0.5], plot, view);
  const m = dataToScreen([0.5, 0.5], plot, c);
  close(m[0], plot.x + plot.w / 2);
  const v = visibleData(plot, IDENTITY);
  close(v.x0, 0); close(v.y0, 0); close(v.x1, 1); close(v.y1, 1);
});

test("panStep moves the current camera by the pointer delta, so a zoom made mid-pan survives", () => {
  let c: Camera = IDENTITY;
  c = panStep(c, [100, 100], [130, 90]);
  assert.deepEqual(c, { scale: 1, tx: 30, ty: -10 });
  c = zoomAt(c, 2, [200, 200]); // keyboard or toolbar zoom while the pointer is still down
  const next = panStep(c, [130, 90], [135, 95]);
  assert.equal(next.scale, 2);
  assert.equal(next.tx, c.tx + 5);
  assert.equal(next.ty, c.ty + 5);
});
