# Track U3: Boundary canvas v2 (camera, stacks, fan-out, undo)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts C1–C8, and Ownership first. Spec: "Screens §2 Review → Canvas behavior". This track *is* the paper's contribution: the gesture must feel immediate and physical.

**Owns:** `app/src/canvas/**`, `app/src/lib/viewport.ts`, `app/src/lib/stacks.ts`, `app/tests/viewport.test.mts`, `app/tests/stacks.test.mts`, `app/tests/undo.test.mts`, `app/e2e/canvas.spec.ts`. E2E port **1433**.

**Never touches:** `lib/approval.ts`, `lib/geometry.ts` (reuse them read-only), anything outside Owns. The canvas never classifies steps: `status` arrives as a prop (computed by `lib/approval.classify` on TRUE points in `useSession`).

**Coordinate model (used by every task):**
- *Data*: normalized `[0,1]²`, y up. Stored polygons and true points live here.
- *Base px*: the plot at zoom 1: `bx = plot.x + x·plot.w`, `by = plot.y + (1−y)·plot.h`.
- *Screen px*: `screen = base·scale + (tx, ty)`. Camera = `{scale, tx, ty}`, identity `{1,0,0}`.
- The world `<g>` carries the ONLY camera transform: `translate(tx ty) scale(scale)`. Strokes use `vector-effect="non-scaling-stroke"`; circles are counter-scaled (`scale(1/scale)` or `r = R/scale`), so on-screen sizes never change with zoom. **Pan changes only that one attribute**; the badge layer is memoized on camera-independent inputs plus `scale`, so a pan re-renders zero badges.
- Hit testing is in screen px. Gestures write data-space points through `clampPoint(screenToData(...))`.
- The camera never moves while a gesture is active (wheel and pinch are ignored mid-gesture), so nothing jumps under the pointer.

**Interfaces:**
- Consumes: `Point`, `Step`, `StepStatus`, `Dimension` (C1); `ScoreIndex`, `rawPoint` from `lib/approval`; `clampPoint`, `pointInPolygon`, `projectOnSegment`, `simplifyStrokePreserving` from `lib/geometry`.
- Produces: `BoundaryCanvas` with `BoundaryCanvasProps` exactly as C6 (replacing the W0-3 adapter file in place), plus the C8 ids `boundary-canvas`, `badge-{i}`, `stack-badge`, `fan-out`, `fan-approve-{i}`, `fan-remove-{i}`, `boundary-polygon`, `boundary-handle`, `canvas-tool-draw`, `canvas-tool-pan`, `canvas-zoom-in`, `canvas-zoom-out`, `canvas-zoom-label`, `canvas-fit`, `canvas-undo`, `canvas-clear`, `minimap`, `coach-hint`.
- Extra e2e attributes:
  - On the svg: `data-scale`, `data-tx`, `data-ty`, `data-plot="x,y,w,h"`.
  - On `boundary-polygon`: `data-vertices`, `data-points` (JSON of data-space vertices).
  - On badges: `data-status`, `data-step-id`.
  - On `stack-badge`: `data-members="1,4"`, `data-status` (a status or `mixed`).
  - On the badge layer `<g data-testid="badge-layer">`: `data-renders` (render count).

---

### Task U3-1: `lib/viewport.ts` (pure camera math)

**Files:** Create `app/src/lib/viewport.ts`, Test `app/tests/viewport.test.mts`

- [ ] **Step 1: Write the failing tests**

```ts
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPoint } from "../src/lib/geometry.ts";
import {
  IDENTITY, MAX_SCALE, MIN_SCALE, centerOn, clampCamera, dataToScreen, fit, panBy, screenToData, visibleData, zoomAt,
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
```

- [ ] **Step 2: Run, expect FAIL** — `cd app && npm test` → `Cannot find module '../src/lib/viewport.ts'`.

- [ ] **Step 3: Implement**

```ts
// Camera math for the boundary canvas. Pure and self-contained (node --test runs it
// directly: no relative value imports). Data space is [0,1]² with y up; "base" px is the
// plot at zoom 1; screen = base * scale + (tx, ty).
export type Pt = [number, number];
export interface Camera { scale: number; tx: number; ty: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 8;
export const ZOOM_STEP = Math.SQRT2;
export const MIN_VISIBLE_PX = 64;
export const IDENTITY: Camera = { scale: 1, tx: 0, ty: 0 };

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
export const dataToBase = (p: Pt, plot: Rect): Pt => [plot.x + p[0] * plot.w, plot.y + (1 - p[1]) * plot.h];
export const baseToData = (b: Pt, plot: Rect): Pt => [(b[0] - plot.x) / plot.w, 1 - (b[1] - plot.y) / plot.h];
export const baseToScreen = (b: Pt, c: Camera): Pt => [b[0] * c.scale + c.tx, b[1] * c.scale + c.ty];
export const screenToBase = (s: Pt, c: Camera): Pt => [(s[0] - c.tx) / c.scale, (s[1] - c.ty) / c.scale];
export const dataToScreen = (p: Pt, plot: Rect, c: Camera): Pt => baseToScreen(dataToBase(p, plot), c);
export const screenToData = (s: Pt, plot: Rect, c: Camera): Pt => baseToData(screenToBase(s, c), plot);

/** Zoom by `factor` keeping the screen point `anchor` over the same data point. */
export function zoomAt(c: Camera, factor: number, anchor: Pt): Camera {
  const scale = clampScale(c.scale * factor);
  const k = scale / c.scale;
  return { scale, tx: anchor[0] - (anchor[0] - c.tx) * k, ty: anchor[1] - (anchor[1] - c.ty) * k };
}

export const panBy = (c: Camera, dx: number, dy: number): Camera => ({ ...c, tx: c.tx + dx, ty: c.ty + dy });

/** Clamp scale and keep at least `minVisible` px of the plot on screen on each axis. */
export function clampCamera(c: Camera, plot: Rect, view: Size, minVisible = MIN_VISIBLE_PX): Camera {
  const scale = clampScale(c.scale);
  let { tx, ty } = c;
  const mx = Math.min(minVisible, view.w / 2);
  const my = Math.min(minVisible, view.h / 2);
  const x0 = plot.x * scale + tx, x1 = (plot.x + plot.w) * scale + tx;
  const y0 = plot.y * scale + ty, y1 = (plot.y + plot.h) * scale + ty;
  if (x1 < mx) tx += mx - x1;
  if (x0 > view.w - mx) tx -= x0 - (view.w - mx);
  if (y1 < my) ty += my - y1;
  if (y0 > view.h - my) ty -= y0 - (view.h - my);
  return { scale, tx, ty };
}

/** Frame `points` (data) with `paddingPx`; never zooms out past identity. */
export function fit(points: readonly Pt[], plot: Rect, view: Size, paddingPx = 48): Camera {
  if (!points.length) return IDENTITY;
  const b = points.map((p) => dataToBase(p, plot));
  const minX = Math.min(...b.map((q) => q[0])) - paddingPx, maxX = Math.max(...b.map((q) => q[0])) + paddingPx;
  const minY = Math.min(...b.map((q) => q[1])) - paddingPx, maxY = Math.max(...b.map((q) => q[1])) + paddingPx;
  const scale = Math.min(MAX_SCALE, plot.w / Math.max(1, maxX - minX), plot.h / Math.max(1, maxY - minY));
  if (scale <= 1) return IDENTITY;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return clampCamera({ scale, tx: plot.x + plot.w / 2 - cx * scale, ty: plot.y + plot.h / 2 - cy * scale }, plot, view);
}

export function centerOn(c: Camera, p: Pt, plot: Rect, view: Size): Camera {
  const b = dataToBase(p, plot);
  return clampCamera({ scale: c.scale, tx: plot.x + plot.w / 2 - b[0] * c.scale, ty: plot.y + plot.h / 2 - b[1] * c.scale }, plot, view);
}

/** Data-space rectangle visible inside the plot window (minimap). */
export function visibleData(plot: Rect, c: Camera) {
  const a = screenToData([plot.x, plot.y + plot.h], plot, c);
  const b = screenToData([plot.x + plot.w, plot.y], plot, c);
  return { x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
}
```

- [ ] **Step 4: Run** — `cd app && npm test` → all pass.
- [ ] **Step 5: Commit** — `git add app/src/lib/viewport.ts app/tests/viewport.test.mts && git commit -m "canvas: pure camera math (zoomAt, clamp, fit)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-2: `lib/stacks.ts` and `canvas/undo.ts` (pure)

**Files:** Create `app/src/lib/stacks.ts`, `app/src/canvas/undo.ts`; Test `app/tests/stacks.test.mts`, `app/tests/undo.test.mts`

- [ ] **Step 1: Write the failing tests**

`app/tests/stacks.test.mts`:

```ts
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
```

`app/tests/undo.test.mts`:

```ts
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
```

- [ ] **Step 2: Run, expect FAIL** (`Cannot find module`).

- [ ] **Step 3: Implement**

`app/src/lib/stacks.ts`:

```ts
// Which badges cover each other at the current zoom. Pure and self-contained.
export type Pt = [number, number];
export interface StackItem { id: string; px: Pt } // base px × scale (translation is irrelevant)
export interface Stack { key: string; ids: string[]; center: Pt }

/** Two disks of radius r overlap visibly when their centers are closer than this. */
export const minSeparation = (badgeR: number) => 2 * badgeR - 2;

/** Union-find over pairs closer than `minSepPx`. Deterministic: ids sorted, stacks ordered by first id. */
export function groupStacks(items: readonly StackItem[], minSepPx: number): Stack[] {
  const s = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parent = s.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let a = 0; a < s.length; a++)
    for (let b = a + 1; b < s.length; b++)
      if (Math.hypot(s[a].px[0] - s[b].px[0], s[a].px[1] - s[b].px[1]) < minSepPx) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
  const groups = new Map<number, StackItem[]>();
  s.forEach((it, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), it]);
  });
  return [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => ({
    key: g.map((m) => m.id).join("+"),
    ids: g.map((m) => m.id),
    center: [g.reduce((t, m) => t + m.px[0], 0) / g.length, g.reduce((t, m) => t + m.px[1], 0) / g.length],
  }));
}

/** Zoom above which two base-px points stop overlapping (Infinity for exact ties). */
export function splitScale(a: Pt, b: Pt, minSepPx: number): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  return d === 0 ? Infinity : minSepPx / d;
}

export function stackStatus<S extends string>(ids: readonly string[], status: Readonly<Record<string, S>>, fallback: S): S | "mixed" {
  const first = status[ids[0]] ?? fallback;
  return ids.every((id) => (status[id] ?? fallback) === first) ? first : "mixed";
}

/** Ring positions (screen px) around `center`; radius grows with n so badges never touch. */
export function fanOutPositions(center: Pt, n: number, badgeR: number, gapPx = 6): Pt[] {
  if (n <= 0) return [];
  const minR = 2 * badgeR + gapPx;
  const ring = n === 1 ? minR : Math.max(minR, (badgeR + gapPx / 2) / Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return [center[0] + ring * Math.cos(a), center[1] + ring * Math.sin(a)] as Pt;
  });
}
```

`app/src/canvas/undo.ts`:

```ts
// Polygon undo history, one stack per axis pair. Pure; no relative value imports.
export type Poly = [number, number][] | null;
export const UNDO_LIMIT = 50;

export class UndoHistory {
  #stacks = new Map<string, Poly[]>();
  push(key: string, prev: Poly): void {
    const s = this.#stacks.get(key) ?? [];
    s.push(prev ? prev.map((p) => [p[0], p[1]] as [number, number]) : null);
    if (s.length > UNDO_LIMIT) s.shift();
    this.#stacks.set(key, s);
  }
  pop(key: string): { ok: true; poly: Poly } | { ok: false } {
    const s = this.#stacks.get(key);
    return s && s.length ? { ok: true, poly: s.pop()! } : { ok: false };
  }
  size(key: string): number {
    return this.#stacks.get(key)?.length ?? 0;
  }
}
```

- [ ] **Step 4: Run** — `cd app && npm test` → all pass.
- [ ] **Step 5: Commit** — `git add app/src/lib/stacks.ts app/src/canvas/undo.ts app/tests/stacks.test.mts app/tests/undo.test.mts && git commit -m "canvas: stacks (union-find, fan-out ring) and undo history" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-3: `canvas/useCamera.ts` and `canvas/useBadgeLayout.ts`

**Files:** Create `app/src/canvas/useCamera.ts`, `app/src/canvas/useBadgeLayout.ts`, `app/src/canvas/constants.ts`. These are covered by the e2e in U3-7 (no DOM test runner); typecheck gates this task.

- [ ] **Step 1: Constants**

```ts
// app/src/canvas/constants.ts
export const BADGE_R = 13;      // ~26pt badge, constant on screen
export const HANDLE_R = 4.5;    // visual handle radius
export const HANDLE_HIT = 14;   // generous grab radius (screen px)
export const EDGE_HIT = 9;
export const BADGE_HIT = BADGE_R + 2;
export const DRAG_THRESHOLD = 3;
export const MIN_AREA_PX = 180; // reject scribbles smaller than this (screen px²)
export const MARGIN = { left: 44, right: 16, top: 16, bottom: 40 };
export type Tool = "draw" | "pan";
```

- [ ] **Step 2: `useCamera`**

```ts
// app/src/canvas/useCamera.ts
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { IDENTITY, centerOn, clampCamera, fit as fitCam, panBy, zoomAt, type Camera, type Pt, type Rect, type Size } from "../lib/viewport";

export interface CameraApi {
  camera: Camera;
  cameraRef: RefObject<Camera>;
  set(c: Camera): void;
  zoomBy(factor: number, anchor?: Pt): void;
  fit(points: readonly Pt[]): void;
  center(p: Pt): void;
  reset(): void;
}

export function useCamera(svgRef: RefObject<SVGSVGElement | null>, plot: Rect, view: Size, gestureActive: () => boolean): CameraApi {
  const [camera, setState] = useState<Camera>(IDENTITY);
  const cameraRef = useRef<Camera>(IDENTITY);
  const geo = useRef({ plot, view, gestureActive });
  geo.current = { plot, view, gestureActive };

  const set = useCallback((c: Camera) => {
    const next = clampCamera(c, geo.current.plot, geo.current.view);
    cameraRef.current = next;
    setState(next);
  }, []);
  const mid = (): Pt => [geo.current.plot.x + geo.current.plot.w / 2, geo.current.plot.y + geo.current.plot.h / 2];
  const zoomBy = useCallback((f: number, anchor?: Pt) => set(zoomAt(cameraRef.current, f, anchor ?? mid())), [set]);
  const fit = useCallback((pts: readonly Pt[]) => set(fitCam(pts, geo.current.plot, geo.current.view)), [set]);
  const center = useCallback((p: Pt) => set(centerOn(cameraRef.current, p, geo.current.plot, geo.current.view)), [set]);
  const reset = useCallback(() => set(IDENTITY), [set]);

  // Re-clamp when the canvas resizes.
  useEffect(() => set(cameraRef.current), [plot.w, plot.h, view.w, view.h, set]);

  // Wheel = pan (two-finger trackpad); ⌘/Ctrl-wheel or Chrome pinch (ctrlKey) = zoom at cursor;
  // WebKit (Tauri on macOS) pinch arrives as gesture* events. Native, non-passive listeners
  // so the page never scrolls under the canvas. Ignored while a gesture is active.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const local = (cx: number, cy: number): Pt => {
      const r = el.getBoundingClientRect();
      return [cx - r.left, cy - r.top];
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (geo.current.gestureActive()) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * unit * 0.01)));
        set(zoomAt(cameraRef.current, f, local(e.clientX, e.clientY)));
      } else set(panBy(cameraRef.current, -e.deltaX * unit, -e.deltaY * unit));
    };
    let base = 1;
    type GE = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => { e.preventDefault(); base = cameraRef.current.scale; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (geo.current.gestureActive()) return;
      const g = e as GE;
      set(zoomAt(cameraRef.current, (base * g.scale) / cameraRef.current.scale, local(g.clientX, g.clientY)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [svgRef, set]);

  return { camera, cameraRef, set, zoomBy, fit, center, reset };
}
```

- [ ] **Step 3: `useBadgeLayout`** (true points only; no jitter, no spread: overlap is handled by stacks)

```ts
// app/src/canvas/useBadgeLayout.ts
import { useMemo } from "react";
import type { Point, Step } from "../api/types";
import { rawPoint, type ScoreIndex } from "../lib/approval";
import { clampPoint } from "../lib/geometry";
import { groupStacks, minSeparation } from "../lib/stacks";
import { dataToBase, type Rect } from "../lib/viewport";
import { BADGE_R } from "./constants";

export interface LaidStack { key: string; ids: string[]; centerBase: Point }
export interface BadgeLayout {
  byId: Map<string, Step>;
  data: Map<string, Point>;   // TRUE point (classification uses this, via lib/approval)
  base: Map<string, Point>;   // TRUE point in base px; badges render exactly here
  stacks: LaidStack[];        // singletons are stacks of one
}

export function useBadgeLayout(steps: Step[], idx: ScoreIndex, xKey: string, yKey: string, plot: Rect, scale: number): BadgeLayout {
  const pts = useMemo(() => {
    const byId = new Map<string, Step>(), data = new Map<string, Point>(), base = new Map<string, Point>();
    for (const s of steps) {
      const raw = rawPoint(idx, s.id, xKey, yKey);
      if (!raw) continue;
      byId.set(s.id, s);
      data.set(s.id, raw);
      base.set(s.id, dataToBase(clampPoint(raw), plot));
    }
    return { byId, data, base };
  }, [steps, idx, xKey, yKey, plot]);
  const stacks = useMemo(
    () =>
      groupStacks([...pts.base].map(([id, b]) => ({ id, px: [b[0] * scale, b[1] * scale] as Point })), minSeparation(BADGE_R)).map((s) => ({
        key: s.key,
        ids: s.ids,
        centerBase: [s.center[0] / scale, s.center[1] / scale] as Point,
      })),
    [pts, scale],
  );
  return useMemo(() => ({ ...pts, stacks }), [pts, stacks]);
}
```

- [ ] **Step 4: Typecheck** — `cd app && npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git add app/src/canvas && git commit -m "canvas: camera hook (wheel/pinch/gesture) and true-point badge layout" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-4: `canvas/useBoundaryGesture.ts` (the state machine)

**Files:** Create `app/src/canvas/useBoundaryGesture.ts`. Semantics are ported 1:1 from `paper/BoundaryCanvas.tsx` (`hitTest`, `onPointerDown/Move`, `finish`, `onDoubleClick`, Esc), moved into data space through the camera:

| Gesture | Behavior |
|---|---|
| Hit order | handle → edge → badge/stack → inside polygon → empty (screen px radii from `constants.ts`) |
| Draw tool, press on empty/badge/stack + drag ≥3px | draws a NEW loop (replaces the polygon; `prev` kept for cancel). Press + release without drag on a badge selects it; on a stack opens its fan; on empty clears selection and collapses the fan. |
| Press on handle | drags that vertex (grab offset in data space), clamped to [0,1] |
| Press on edge or inside | moves the whole polygon, clamped so every vertex stays in [0,1] |
| Pan tool, space held, or middle button | pans the camera |
| Every pointermove during draw/handle/move | `flushSync(() => onPolygonChange(poly, false))`, so badge colors and counts commit in the same frame |
| Release after draw | `simplifyStrokePreserving(stroke, strokePx, probes, probesPx, 6, 10)` with probes = every step's TRUE point; reject if <3 vertices or screen area < `MIN_AREA_PX` (restore `prev`); else `pushUndo(prev)`, `onPolygonChange(poly, true)`, `onLoopDone()` |
| Release after handle/move | if changed: `pushUndo(prev)` then final emit |
| Double-click handle | delete it (keep ≥3), undoable |
| Double-click edge | insert a vertex at the projection, undoable |
| Esc / pointercancel | restore `prev` (final emit) and end the gesture |

- [ ] **Step 1: Implement**

```ts
// app/src/canvas/useBoundaryGesture.ts
import { useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Point } from "../api/types";
import { clampPoint, pointInPolygon, projectOnSegment, simplifyStrokePreserving } from "../lib/geometry";
import { dataToScreen, screenToData, type Camera, type Rect } from "../lib/viewport";
import { BADGE_HIT, DRAG_THRESHOLD, EDGE_HIT, HANDLE_HIT, MIN_AREA_PX, type Tool } from "./constants";

export type HitTarget = { kind: "badge"; id: string; at: Point } | { kind: "stack"; key: string; at: Point };
export type Hover = { kind: "badge"; id: string } | { kind: "stack"; key: string } | { kind: "handle" | "edge" | "inside" } | null;
type Hit = { kind: "handle"; idx: number } | { kind: "edge"; idx: number; at: Point } | { kind: "target"; t: HitTarget } | { kind: "inside" } | { kind: "empty" };
type Mode =
  | { kind: "idle" }
  | { kind: "maybe"; start: Point; target: HitTarget | null; prev: Point[] | null }
  | { kind: "draw"; stroke: Point[]; prev: Point[] | null }
  | { kind: "handle"; idx: number; grab: Point; poly: Point[]; prev: Point[] }
  | { kind: "move"; start: Point; poly: Point[]; prev: Point[]; moved: boolean }
  | { kind: "pan"; start: Point; cam: Camera };

export interface GestureDeps {
  svgRef: RefObject<SVGSVGElement | null>;
  plot: Rect;
  cameraRef: RefObject<Camera>;
  polygon: Point[] | null;
  tool: Tool;
  spaceHeld: boolean;
  targets: () => HitTarget[];
  probes: () => Point[];
  onPolygonChange: (poly: Point[] | null, final: boolean) => void;
  onSelect: (id: string | null) => void;
  onStackClick: (key: string) => void;
  onBackgroundClick: () => void;
  onHover: (h: Hover) => void;
  pushUndo: (prev: Point[] | null) => void;
  onLoopDone: () => void;
  setCamera: (c: Camera) => void;
}

export interface GestureApi {
  stroke: Point[] | null;
  activeHandle: number | null;
  modeKind: Mode["kind"];
  hover: Hover;
  active: () => boolean;
  cancel: () => boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: () => void;
    onDoubleClick: (e: React.MouseEvent<SVGSVGElement>) => void;
  };
}

const copy = (p: Point[] | null) => (p ? p.map((q) => [q[0], q[1]] as Point) : null);
const area = (pts: Point[]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
};
const sameHover = (a: Hover, b: Hover) =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind === "badge" ? (b as { id: string }).id === a.id : a.kind === "stack" ? (b as { key: string }).key === a.key : true));

export function useBoundaryGesture(deps: GestureDeps): GestureApi {
  const d = useRef(deps);
  d.current = deps;
  const mode = useRef<Mode>({ kind: "idle" });
  const rect = useRef<DOMRect | null>(null);
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  const [modeKind, setModeKind] = useState<Mode["kind"]>("idle");
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);

  const api = useMemo(() => {
    const cam = () => d.current.cameraRef.current;
    const toScreen = (q: Point) => dataToScreen(q, d.current.plot, cam()) as Point;
    const toData = (p: Point) => screenToData(p, d.current.plot, cam()) as Point;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = (rect.current ??= d.current.svgRef.current!.getBoundingClientRect());
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const emit = (poly: Point[] | null, final: boolean) =>
      final ? d.current.onPolygonChange(poly, true) : flushSync(() => d.current.onPolygonChange(poly, false));
    const setMode = (m: Mode) => {
      mode.current = m;
      setModeKind(m.kind);
    };
    const setHov = (h: Hover) => {
      if (sameHover(hoverRef.current, h)) return;
      hoverRef.current = h;
      setHover(h);
      d.current.onHover(h);
    };

    const hitTest = (p: Point): Hit => {
      const poly = d.current.polygon;
      if (poly && poly.length) {
        const px = poly.map(toScreen);
        let best = -1, bestD = HANDLE_HIT;
        px.forEach((h, i) => {
          const dd = Math.hypot(h[0] - p[0], h[1] - p[1]);
          if (dd <= bestD) { bestD = dd; best = i; }
        });
        if (best >= 0) return { kind: "handle", idx: best };
        let eBest = -1, eD = EDGE_HIT, at: Point = p;
        for (let i = 0; i < px.length && px.length >= 2; i++) {
          const pr = projectOnSegment(p, px[i], px[(i + 1) % px.length]);
          if (pr.dist <= eD) { eD = pr.dist; eBest = i; at = pr.point; }
        }
        if (eBest >= 0) return { kind: "edge", idx: eBest, at };
      }
      const ts = d.current.targets();
      for (let i = ts.length - 1; i >= 0; i--) if (Math.hypot(ts[i].at[0] - p[0], ts[i].at[1] - p[1]) <= BADGE_HIT) return { kind: "target", t: ts[i] };
      if (poly && poly.length >= 3 && pointInPolygon(p[0], p[1], poly.map(toScreen))) return { kind: "inside" };
      return { kind: "empty" };
    };

    const end = (e: { pointerId: number } | null) => {
      if (e) try { d.current.svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      setActiveHandle(null);
      setMode({ kind: "idle" });
    };

    const finish = (e: React.PointerEvent<SVGSVGElement>, cancelled: boolean) => {
      const m = mode.current;
      end(e);
      if (m.kind === "maybe" && !cancelled) {
        if (m.target?.kind === "badge") d.current.onSelect(m.target.id);
        else if (m.target?.kind === "stack") d.current.onStackClick(m.target.key);
        else { d.current.onSelect(null); d.current.onBackgroundClick(); }
      } else if (m.kind === "draw") {
        setStroke(null);
        if (cancelled) return emit(m.prev, true);
        const strokePx = m.stroke.map(toScreen);
        const probes = d.current.probes();
        const poly = simplifyStrokePreserving(m.stroke, strokePx, probes, probes.map(toScreen), 6, 10);
        if (poly.length < 3 || area(poly.map(toScreen)) < MIN_AREA_PX) return emit(m.prev, true);
        d.current.pushUndo(m.prev);
        emit(poly, true);
        d.current.onLoopDone();
      } else if (m.kind === "handle") {
        if (cancelled) emit(m.prev, true);
        else if (m.poly !== m.prev) { d.current.pushUndo(m.prev); emit(m.poly, true); }
      } else if (m.kind === "move" && m.moved) {
        if (cancelled) emit(m.prev, true);
        else { d.current.pushUndo(m.prev); emit(m.poly, true); }
      } else if (m.kind === "pan" && cancelled) d.current.setCamera(m.cam);
    };

    return {
      active: () => mode.current.kind !== "idle" && mode.current.kind !== "maybe",
      cancel: () => {
        const m = mode.current;
        if (m.kind === "draw" || m.kind === "handle" || m.kind === "move") {
          end(null);
          setStroke(null);
          emit(m.prev, true);
          return true;
        }
        if (m.kind === "pan") { end(null); d.current.setCamera(m.cam); return true; }
        return false;
      },
      handlers: {
        onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
          if (e.button !== 0 && e.button !== 1) return;
          const svg = d.current.svgRef.current;
          if (!svg) return;
          rect.current = svg.getBoundingClientRect();
          const p = local(e);
          try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
          e.preventDefault();
          const prev = copy(d.current.polygon);
          if (e.button === 1 || d.current.tool === "pan" || d.current.spaceHeld) return setMode({ kind: "pan", start: p, cam: cam() });
          const hit = hitTest(p);
          if (hit.kind === "handle" && prev) {
            const n = toData(p), h = prev[hit.idx];
            setActiveHandle(hit.idx);
            setMode({ kind: "handle", idx: hit.idx, grab: [h[0] - n[0], h[1] - n[1]], poly: prev, prev });
          } else if ((hit.kind === "edge" || hit.kind === "inside") && prev) {
            setMode({ kind: "move", start: toData(p), poly: prev, prev, moved: false });
          } else setMode({ kind: "maybe", start: p, target: hit.kind === "target" ? hit.t : null, prev });
        },
        onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
          const m = mode.current;
          const p = local(e);
          if (m.kind === "idle") {
            const hit = hitTest(p);
            setHov(hit.kind === "target" ? (hit.t.kind === "badge" ? { kind: "badge", id: hit.t.id } : { kind: "stack", key: hit.t.key }) : hit.kind === "empty" ? null : { kind: hit.kind });
            return;
          }
          if (m.kind === "pan") return d.current.setCamera({ ...m.cam, tx: m.cam.tx + p[0] - m.start[0], ty: m.cam.ty + p[1] - m.start[1] });
          if (m.kind === "maybe") {
            if (Math.hypot(p[0] - m.start[0], p[1] - m.start[1]) < DRAG_THRESHOLD) return;
            const s: Point[] = [clampPoint(toData(m.start)), clampPoint(toData(p))];
            setMode({ kind: "draw", stroke: s, prev: m.prev });
            setHov(null);
            flushSync(() => setStroke(s));
            return emit(s, false);
          }
          if (m.kind === "draw") {
            const last = toScreen(m.stroke[m.stroke.length - 1]);
            if (Math.hypot(last[0] - p[0], last[1] - p[1]) < 1.5) return;
            m.stroke = [...m.stroke, clampPoint(toData(p))];
            flushSync(() => setStroke(m.stroke));
            return emit(m.stroke.length >= 3 ? m.stroke : null, false);
          }
          if (m.kind === "handle") {
            const n = toData(p);
            const next = m.poly.slice();
            next[m.idx] = clampPoint([n[0] + m.grab[0], n[1] + m.grab[1]]);
            m.poly = next;
            return emit(next, false);
          }
          if (m.kind === "move") {
            const n = toData(p);
            let dx = n[0] - m.start[0], dy = n[1] - m.start[1];
            const s = cam().scale;
            if (!m.moved && Math.hypot(dx * d.current.plot.w * s, dy * d.current.plot.h * s) < DRAG_THRESHOLD) return;
            m.moved = true;
            const xs = m.prev.map((q) => q[0]), ys = m.prev.map((q) => q[1]);
            dx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
            dy = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
            m.poly = m.prev.map((q) => [q[0] + dx, q[1] + dy] as Point);
            emit(m.poly, false);
          }
        },
        onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => finish(e, false),
        onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => finish(e, true),
        onPointerLeave: () => mode.current.kind === "idle" && setHov(null),
        onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
          const poly = d.current.polygon;
          if (!poly) return;
          rect.current = d.current.svgRef.current!.getBoundingClientRect();
          const hit = hitTest(local(e));
          if (hit.kind === "handle" && poly.length > 3) {
            d.current.pushUndo(copy(poly));
            emit(poly.filter((_, i) => i !== hit.idx), true);
          } else if (hit.kind === "edge") {
            d.current.pushUndo(copy(poly));
            const next = poly.slice();
            next.splice(hit.idx + 1, 0, clampPoint(toData(hit.at)));
            emit(next, true);
          }
        },
      },
    };
  }, []);

  return { stroke, activeHandle, modeKind, hover, active: api.active, cancel: api.cancel, handlers: api.handlers };
}
```

Note: a `scroll`/`resize` listener must clear `rect.current` (add in BoundaryCanvas: `onScroll`/ResizeObserver set `rectRef = null` is not reachable, so instead re-read the rect on every `pointerdown` (done above), and in idle hover via `local()` lazily). If a window resize happens mid-hover, the next pointerdown refreshes it.

- [ ] **Step 2: Typecheck** — `cd app && npm run typecheck` → clean.
- [ ] **Step 3: Commit** — `git add app/src/canvas/useBoundaryGesture.ts && git commit -m "canvas: gesture state machine in data space via the camera" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-5: Badges, stacks, fan-out, hover card

**Files:** Create `app/src/canvas/BadgeLayer.tsx`, `app/src/canvas/FanOut.tsx`, `app/src/canvas/HoverCard.tsx`, `app/src/canvas/BoundaryCanvas.module.css` (shared module for all canvas parts).

- [ ] **Step 1: `BadgeLayer.tsx`** (inside the world `<g>`, base px, counter-scaled; memoized; never receives tx/ty)

```tsx
import { memo, useRef } from "react";
import type { Point, Step, StepStatus } from "../api/types";
import { stackStatus } from "../lib/stacks";
import css from "./BoundaryCanvas.module.css";
import { BADGE_R } from "./constants";
import type { BadgeLayout } from "./useBadgeLayout";

export function Badge({ step, at, st, scale, selected, hovered }: { step: Step; at: Point; st: StepStatus; scale: number; selected: boolean; hovered: boolean }) {
  return (
    <g className={css.badge} data-testid={`badge-${step.index}`} data-status={st} data-step-id={step.id}
      transform={`translate(${at[0].toFixed(2)} ${at[1].toFixed(2)}) scale(${(1 / scale).toFixed(5)})`}>
      {(selected || hovered) && <circle r={BADGE_R + 4} className={selected ? css.ring : css.hoverRing} />}
      <circle r={BADGE_R} className={css.disk} />
      <text className={css.num} dy="0.35em">{step.index}</text>
    </g>
  );
}

export const BadgeLayer = memo(function BadgeLayer(p: {
  layout: BadgeLayout; status: Record<string, StepStatus>; scale: number;
  selectedId: string | null; hoveredId: string | null; fanKey: string | null;
}) {
  const renders = useRef(0);
  renders.current += 1;
  const { layout, status, scale } = p;
  return (
    <g data-testid="badge-layer" data-renders={renders.current}>
      {layout.stacks.map((s) => {
        if (s.ids.length === 1) {
          const id = s.ids[0];
          return <Badge key={id} step={layout.byId.get(id)!} at={layout.base.get(id)!} st={status[id] ?? "pending"} scale={scale}
            selected={id === p.selectedId} hovered={id === p.hoveredId} />;
        }
        // True points of every member, always visible under a stack or its fan.
        const dots = s.ids.map((id) => {
          const b = layout.base.get(id)!;
          return <circle key={`a-${id}`} cx={b[0]} cy={b[1]} r={2.4 / scale} className={css.anchor} />;
        });
        if (s.key === p.fanKey) return <g key={s.key}>{dots}</g>;
        const shared = stackStatus(s.ids, status, "pending");
        const members = s.ids.map((id) => layout.byId.get(id)!.index).sort((a, b) => a - b);
        const sel = s.ids.includes(p.selectedId ?? "") || s.ids.includes(p.hoveredId ?? "");
        return (
          <g key={s.key}>
            <g className={css.badge} data-testid="stack-badge" data-members={members.join(",")} data-status={shared}
              transform={`translate(${s.centerBase[0].toFixed(2)} ${s.centerBase[1].toFixed(2)}) scale(${(1 / scale).toFixed(5)})`}>
              {sel && <circle r={BADGE_R + 6} className={css.ring} />}
              <circle r={BADGE_R + 2} className={css.disk} />
              <text className={css.num} dy="0.35em">×{s.ids.length}</text>
            </g>
            {dots}
          </g>
        );
      })}
    </g>
  );
});
```

- [ ] **Step 2: `FanOut.tsx`** (screen space overlay outside the world transform; its buttons stop propagation so the canvas gesture never sees them)

```tsx
import type { Point, Step, StepStatus } from "../api/types";
import { fanOutPositions } from "../lib/stacks";
import { baseToScreen, type Camera } from "../lib/viewport";
import css from "./BoundaryCanvas.module.css";
import { BADGE_R } from "./constants";
import type { BadgeLayout, LaidStack } from "./useBadgeLayout";

export function FanOut({ stack, layout, camera, status, onApprove, onRemove, onSelect }: {
  stack: LaidStack; layout: BadgeLayout; camera: Camera; status: Record<string, StepStatus>;
  onApprove: (id: string) => void; onRemove: (id: string) => void; onSelect: (id: string) => void;
}) {
  const c = baseToScreen(stack.centerBase, camera) as Point;
  const pos = fanOutPositions(c, stack.ids.length, BADGE_R + 3);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <g data-testid="fan-out" className={css.fan}>
      <circle cx={c[0]} cy={c[1]} r={Math.hypot(pos[0][0] - c[0], pos[0][1] - c[1]) + BADGE_R + 10} className={css.fanHalo} />
      {stack.ids.map((id, k) => {
        const step: Step = layout.byId.get(id)!;
        const a = baseToScreen(layout.base.get(id)!, camera);
        const [x, y] = pos[k];
        const st = status[id] ?? "pending";
        return (
          <g key={id}>
            <line x1={a[0]} y1={a[1]} x2={x} y2={y} className={css.leader} />
            <g className={css.badge} data-testid={`badge-${step.index}`} data-status={st} data-step-id={id}
              transform={`translate(${x} ${y})`} onPointerDown={stop} onClick={() => onSelect(id)}>
              <circle r={BADGE_R} className={css.disk} />
              <text className={css.num} dy="0.35em">{step.index}</text>
            </g>
            <g data-testid={`fan-approve-${step.index}`} className={`${css.fanBtn} ${css.fanOk}`} transform={`translate(${x + 15} ${y + 15})`}
              onPointerDown={stop} onClick={() => onApprove(id)} role="button" aria-label={`Approve step ${step.index}`}>
              <circle r={8} /><path d="M-3.5 0 L-1 2.5 L3.5 -2.5" />
            </g>
            <g data-testid={`fan-remove-${step.index}`} className={`${css.fanBtn} ${css.fanRm}`} transform={`translate(${x - 15} ${y + 15})`}
              onPointerDown={stop} onClick={() => onRemove(id)} role="button" aria-label={`Remove step ${step.index}`}>
              <circle r={8} /><path d="M-3 -3 L3 3 M3 -3 L-3 3" />
            </g>
          </g>
        );
      })}
    </g>
  );
}
```

- [ ] **Step 3: `HoverCard.tsx`** (HTML, screen px; title + both axes' label and rationale)

```tsx
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import css from "./BoundaryCanvas.module.css";

const WORD: Record<StepStatus, string> = { approved: "Approved", pending: "Needs a decision", removed: "Removed" };

export function HoverCard({ step, st, at, idx, xDim, yDim, size }: {
  step: Step; st: StepStatus; at: Point; idx: ScoreIndex; xDim: Dimension; yDim: Dimension; size: { w: number; h: number };
}) {
  const W = 260;
  const left = at[0] + 20 + W > size.w ? at[0] - 20 - W : at[0] + 20;
  const top = Math.max(6, Math.min(at[1] - 30, size.h - 150));
  return (
    <div className={css.tip} style={{ left, top, width: W }} role="tooltip" data-testid="badge-tooltip">
      <div className={css.tipHead}><b>{step.index} · {step.title}</b><span data-status={st} className={css.tipStatus}>{WORD[st]}</span></div>
      {[xDim, yDim].map((dim) => {
        const sc = idx.get(step.id)?.get(dim.key);
        return (
          <div key={dim.key} className={css.tipDim}>
            {dim.name}: <b>{sc?.label ?? "n/a"}</b>
            {sc?.rationale && <div className={css.tipWhy}>{sc.rationale}</div>}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: `BoundaryCanvas.module.css`** (Graphite tokens only)

```css
.wrap { position: relative; height: 100%; min-height: 240px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); overflow: hidden; }
.svg { display: block; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
.plotBg { fill: var(--surface); }
.grid { stroke: var(--grid); stroke-width: 1; }
.gridFine { stroke: var(--grid); stroke-width: 1; opacity: 0.55; }
.poly { fill: var(--ok); fill-opacity: 0.12; stroke: var(--ok); stroke-width: 2; stroke-linejoin: round; }
.polyDrawing { fill: var(--ok); fill-opacity: 0.08; stroke: var(--ok); stroke-width: 2; stroke-dasharray: 5 4; }
.polyHover { fill: none; stroke: var(--ok); stroke-width: 4; stroke-opacity: 0.35; }
.handle { fill: var(--bg); stroke: var(--text); stroke-width: 1.5; }
.handleActive { fill: var(--ok); stroke: var(--text); stroke-width: 1.5; }
.badge { cursor: pointer; }
.disk { stroke: rgba(255, 255, 255, 0.25); stroke-width: 1; }
.badge[data-status="approved"] .disk { fill: var(--ok); }
.badge[data-status="pending"] .disk { fill: var(--pend); }
.badge[data-status="mixed"] .disk { fill: var(--raised); stroke: var(--text-2); stroke-dasharray: 3 2; }
.badge[data-status="removed"] .disk { fill: transparent; stroke: var(--rm); stroke-dasharray: 3 2.5; stroke-width: 1.2; }
.num { fill: var(--bg); font: 700 11px var(--font); text-anchor: middle; pointer-events: none; }
.badge[data-status="removed"] .num, .badge[data-status="mixed"] .num { fill: var(--text); }
.badge[data-status="removed"] .num { fill: var(--rm); }
.ring { fill: none; stroke: var(--accent); stroke-width: 2; }
.hoverRing { fill: none; stroke: var(--text-2); stroke-width: 1.5; }
.anchor { fill: var(--text); pointer-events: none; }
.leader { stroke: var(--text-3); stroke-width: 1; }
.fanHalo { fill: var(--bg); fill-opacity: 0.55; stroke: var(--line); stroke-dasharray: 3 3; }
.fanBtn { cursor: pointer; }
.fanBtn circle { fill: var(--raised); stroke: var(--line); }
.fanBtn path { fill: none; stroke-width: 1.8; stroke-linecap: round; }
.fanOk path { stroke: var(--ok); }
.fanRm path { stroke: var(--rm); }
.axisText { fill: var(--text-3); font: 10px var(--font); }
.axisName { fill: var(--text-2); font: 600 11px var(--font); }
.tip { position: absolute; z-index: 5; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; box-shadow: var(--shadow); font-size: var(--fs-sm); pointer-events: none; }
.tipHead { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.tipStatus { color: var(--text-3); white-space: nowrap; }
.tipStatus[data-status="approved"] { color: var(--ok); }
.tipStatus[data-status="pending"] { color: var(--pend); }
.tipStatus[data-status="removed"] { color: var(--rm); }
.tipDim { margin-top: 4px; color: var(--text-2); }
.tipDim b { color: var(--text); }
.tipWhy { color: var(--text-3); }
.toolbar { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 3px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
.tool { border: 0; background: transparent; border-radius: 7px; padding: 5px 8px; font-size: var(--fs-sm); cursor: pointer; color: var(--text); }
.tool:hover:not(:disabled) { background: var(--surface); }
.tool:disabled { opacity: 0.4; cursor: default; }
.toolOn { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
.toolOn:hover { background: var(--accent) !important; }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 3px; }
.zoomLabel { min-width: 42px; text-align: center; font: 11px var(--mono); color: var(--text-2); }
.minimap { position: absolute; right: 12px; bottom: 12px; width: 120px; height: 76px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-sm); cursor: pointer; }
.miniView { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1; }
.coach { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); white-space: nowrap; padding: 6px 14px; border-radius: var(--r-pill); background: var(--raised); border: 1px solid var(--line); color: var(--text-2); font-size: var(--fs-sm); pointer-events: none; }
```

- [ ] **Step 5: Typecheck and commit** — `cd app && npm run typecheck` → clean; `git add app/src/canvas && git commit -m "canvas: numbered badges, stacks, fan-out, hover card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-6: Toolbar, minimap, coach hint, and the composed `BoundaryCanvas`

**Files:** Create `app/src/canvas/Toolbar.tsx`, `app/src/canvas/Minimap.tsx`, `app/src/canvas/CoachHint.tsx`; **replace** `app/src/canvas/BoundaryCanvas.tsx` (the W0-3 adapter; drop its `paper` imports).

- [ ] **Step 1: `Toolbar.tsx`**

```tsx
import css from "./BoundaryCanvas.module.css";
import type { Tool } from "./constants";

export function Toolbar(p: { tool: Tool; onTool: (t: Tool) => void; scale: number; onZoomIn: () => void; onZoomOut: () => void;
  onFit: () => void; onUndo: () => void; canUndo: boolean; onClear: () => void; canClear: boolean }) {
  const b = (on: boolean) => `${css.tool}${on ? ` ${css.toolOn}` : ""}`;
  return (
    <div className={css.toolbar} onPointerDown={(e) => e.stopPropagation()}>
      <button className={b(p.tool === "draw")} data-testid="canvas-tool-draw" onClick={() => p.onTool("draw")} title="Draw a loop (D)">✎ Draw</button>
      <button className={b(p.tool === "pan")} data-testid="canvas-tool-pan" onClick={() => p.onTool("pan")} title="Pan (H, or hold space)">✋ Pan</button>
      <span className={css.sep} />
      <button className={css.tool} data-testid="canvas-zoom-out" onClick={p.onZoomOut} title="Zoom out (−)">−</button>
      <span className={css.zoomLabel} data-testid="canvas-zoom-label">{Math.round(p.scale * 100)}%</span>
      <button className={css.tool} data-testid="canvas-zoom-in" onClick={p.onZoomIn} title="Zoom in (+)">+</button>
      <button className={css.tool} data-testid="canvas-fit" onClick={p.onFit} title="Fit all steps (0)">⤢ Fit</button>
      <span className={css.sep} />
      <button className={css.tool} data-testid="canvas-undo" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (⌘Z)">↺ Undo</button>
      <button className={css.tool} data-testid="canvas-clear" onClick={p.onClear} disabled={!p.canClear}>Clear</button>
    </div>
  );
}
```

- [ ] **Step 2: `Minimap.tsx`** (data space → 120×76; click recenters)

```tsx
import type { Point, StepStatus } from "../api/types";
import { visibleData, type Camera, type Rect } from "../lib/viewport";
import css from "./BoundaryCanvas.module.css";

const W = 120, H = 76, PAD = 6;
const mx = (x: number) => PAD + x * (W - 2 * PAD);
const my = (y: number) => H - PAD - y * (H - 2 * PAD);
const COLOR: Record<StepStatus, string> = { approved: "var(--ok)", pending: "var(--pend)", removed: "var(--rm)" };

export function Minimap({ points, status, camera, plot, onCenter }: {
  points: Map<string, Point>; status: Record<string, StepStatus>; camera: Camera; plot: Rect; onCenter: (p: Point) => void;
}) {
  const v = visibleData(plot, camera);
  const clamp = (t: number) => Math.min(1, Math.max(0, t));
  return (
    <svg className={css.minimap} data-testid="minimap" viewBox={`0 0 ${W} ${H}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onCenter([clamp((e.clientX - r.left - PAD) / (W - 2 * PAD)), clamp((H - PAD - (e.clientY - r.top)) / (H - 2 * PAD))]);
      }}>
      {[...points].map(([id, p]) => <circle key={id} cx={mx(clamp(p[0]))} cy={my(clamp(p[1]))} r={2.5} fill={COLOR[status[id] ?? "pending"]} />)}
      <rect className={css.miniView} x={mx(clamp(v.x0))} y={my(clamp(v.y1))}
        width={Math.max(2, mx(clamp(v.x1)) - mx(clamp(v.x0)))} height={Math.max(2, my(clamp(v.y0)) - my(clamp(v.y1)))} />
    </svg>
  );
}
```

- [ ] **Step 3: `CoachHint.tsx`** (exact copy from Global Constraints)

```tsx
import css from "./BoundaryCanvas.module.css";

const KEY = "oversight.coach.loopDone";
export function readCoachDone(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function writeCoachDone(): void {
  try { localStorage.setItem(KEY, "1"); } catch { /* storage blocked: hint just shows again next time */ }
}
export function CoachHint() {
  return <div className={css.coach} data-testid="coach-hint">Drag a loop to approve · pinch or ⌘-scroll to zoom · two-finger drag or space-drag to pan</div>;
}
```

- [ ] **Step 4: Compose `BoundaryCanvas.tsx`** (keep `BoundaryCanvasProps` from C6 verbatim at the top of the file)

```tsx
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import { ZOOM_STEP, baseToScreen, dataToBase } from "../lib/viewport";
import { BadgeLayer } from "./BadgeLayer";
import css from "./BoundaryCanvas.module.css";
import { CoachHint, readCoachDone, writeCoachDone } from "./CoachHint";
import { BADGE_R, HANDLE_R, MARGIN as M, type Tool } from "./constants";
import { FanOut } from "./FanOut";
import { HoverCard } from "./HoverCard";
import { Minimap } from "./Minimap";
import { Toolbar } from "./Toolbar";
import { UndoHistory } from "./undo";
import { useBadgeLayout } from "./useBadgeLayout";
import { useBoundaryGesture, type HitTarget } from "./useBoundaryGesture";
import { useCamera } from "./useCamera";

// export interface BoundaryCanvasProps { ...verbatim from C6... }

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const path = (pts: Point[], close: boolean) => (pts.length ? "M" + pts.map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join("L") + (close ? "Z" : "") : "");

const Grid = memo(function Grid({ plot, scale }: { plot: { x: number; y: number; w: number; h: number }; scale: number }) {
  const div = scale >= 4 ? 16 : scale >= 2 ? 8 : 4;
  const lines = [];
  for (let i = 1; i < div; i++) {
    const major = (i * 4) % div === 0;
    const cls = major ? css.grid : css.gridFine;
    lines.push(<line key={`v${i}`} className={cls} vectorEffect="non-scaling-stroke" x1={plot.x + (plot.w * i) / div} x2={plot.x + (plot.w * i) / div} y1={plot.y} y2={plot.y + plot.h} />);
    lines.push(<line key={`h${i}`} className={cls} vectorEffect="non-scaling-stroke" y1={plot.y + (plot.h * i) / div} y2={plot.y + (plot.h * i) / div} x1={plot.x} x2={plot.x + plot.w} />);
  }
  return <g>{lines}</g>;
});

export const BoundaryCanvas = memo(function BoundaryCanvas(p: BoundaryCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = "cv" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [size, setSize] = useState({ w: 640, h: 320 });
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(240, Math.round(e.contentRect.width)), h: Math.max(200, Math.round(e.contentRect.height)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plot = useMemo(() => ({ x: M.left, y: M.top, w: size.w - M.left - M.right, h: size.h - M.top - M.bottom }), [size]);

  const [tool, setTool] = useState<Tool>("draw");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [fanKey, setFanKey] = useState<string | null>(null);
  const [coachDone, setCoachDone] = useState(readCoachDone);
  const gestureActive = useRef<() => boolean>(() => false);
  const cam = useCamera(svgRef, plot, size, () => gestureActive.current());
  const s = cam.camera.scale;
  const layout = useBadgeLayout(p.steps, p.idx, p.xDim.key, p.yDim.key, plot, s);

  // Fresh camera per axis pair; collapse a fan whose stack no longer exists.
  useEffect(() => { cam.reset(); setFanKey(null); }, [p.xDim.key, p.yDim.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const fanStack = layout.stacks.find((st) => st.key === fanKey && st.ids.length > 1) ?? null;
  useEffect(() => { if (fanKey && !fanStack) setFanKey(null); }, [fanKey, fanStack]);

  const pair = `${p.xDim.key}|${p.yDim.key}`;
  const undo = useRef(new UndoHistory());
  const [, bump] = useState(0);
  const pushUndo = useCallback((prev: Point[] | null) => { undo.current.push(pair, prev); bump((n) => n + 1); }, [pair]);
  const doUndo = useCallback(() => {
    const r = undo.current.pop(pair);
    bump((n) => n + 1);
    if (r.ok) p.onPolygonChange(r.poly, true);
  }, [pair, p.onPolygonChange]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = useCallback(() => { if (!p.polygon) return; pushUndo(p.polygon); p.onPolygonChange(null, true); }, [p.polygon, p.onPolygonChange, pushUndo]); // eslint-disable-line react-hooks/exhaustive-deps

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const fanRef = useRef(fanKey);
  fanRef.current = fanKey;
  const targets = useCallback((): HitTarget[] => {
    const c = cam.cameraRef.current, L = layoutRef.current;
    return L.stacks.flatMap((st): HitTarget[] =>
      st.key === fanRef.current ? [] :
      st.ids.length === 1 ? [{ kind: "badge", id: st.ids[0], at: baseToScreen(L.base.get(st.ids[0])!, c) as Point }] :
      [{ kind: "stack", key: st.key, at: baseToScreen(st.centerBase, c) as Point }]);
  }, [cam.cameraRef]);

  const g = useBoundaryGesture({
    svgRef, plot, cameraRef: cam.cameraRef, polygon: p.polygon, tool, spaceHeld, targets,
    probes: () => [...layoutRef.current.data.values()],
    onPolygonChange: p.onPolygonChange, onSelect: p.onSelect,
    onStackClick: (key) => setFanKey((k) => (k === key ? null : key)),
    onBackgroundClick: () => setFanKey(null),
    onHover: (h) => p.onHover(h?.kind === "badge" ? h.id : null),
    pushUndo,
    onLoopDone: () => { if (!coachDone) { writeCoachDone(); setCoachDone(true); } },
    setCamera: cam.set,
  });
  gestureActive.current = g.active;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.key === "Escape") { if (!g.cancel()) setFanKey(null); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); setSpaceHeld(true); }
      else if (e.key === "+" || e.key === "=") cam.zoomBy(ZOOM_STEP);
      else if (e.key === "-") cam.zoomBy(1 / ZOOM_STEP);
      else if (e.key === "0") cam.fit([...layoutRef.current.data.values()]);
      else if (e.key === "d") setTool("draw");
      else if (e.key === "h") setTool("pan");
    };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [g, cam, doUndo]);

  const polyBase = useMemo(() => (p.polygon ? p.polygon.map((q) => dataToBase(q, plot) as Point) : null), [p.polygon, plot]);
  const strokeBase = g.stroke ? g.stroke.map((q) => dataToBase(q, plot) as Point) : null;
  const panning = g.modeKind === "pan";
  const cursor = panning ? "grabbing" : tool === "pan" || spaceHeld ? "grab" : g.activeHandle !== null || g.modeKind === "move" ? "grabbing"
    : g.modeKind === "draw" ? "crosshair" : g.hover?.kind === "handle" ? "grab" : g.hover?.kind === "edge" ? "copy"
    : g.hover?.kind === "inside" ? "move" : g.hover?.kind === "badge" || g.hover?.kind === "stack" ? "pointer" : "crosshair";
  const atIdentity = Math.abs(s - 1) < 1e-3 && Math.abs(cam.camera.tx) < 0.5 && Math.abs(cam.camera.ty) < 0.5;
  const hoverId = g.hover?.kind === "badge" && g.modeKind === "idle" ? g.hover.id : null;
  const hoverStep = hoverId ? layout.byId.get(hoverId) : undefined;

  return (
    <div className={css.wrap} ref={wrapRef}>
      <svg ref={svgRef} className={css.svg} data-testid="boundary-canvas" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}
        data-scale={s.toFixed(4)} data-tx={cam.camera.tx.toFixed(1)} data-ty={cam.camera.ty.toFixed(1)} data-plot={`${plot.x},${plot.y},${plot.w},${plot.h}`}
        style={{ cursor }} tabIndex={0} {...g.handlers}>
        <defs>
          <clipPath id={clipId}><rect x={plot.x - BADGE_R} y={plot.y - BADGE_R} width={plot.w + 2 * BADGE_R} height={plot.h + 2 * BADGE_R} /></clipPath>
        </defs>
        <rect className={css.plotBg} x={plot.x} y={plot.y} width={plot.w} height={plot.h} />
        <g clipPath={`url(#${clipId})`}>
          <g transform={`translate(${cam.camera.tx.toFixed(2)} ${cam.camera.ty.toFixed(2)}) scale(${s.toFixed(5)})`}>
            <Grid plot={plot} scale={s} />
            {strokeBase ? (
              <path d={path(strokeBase, true)} className={css.polyDrawing} vectorEffect="non-scaling-stroke" />
            ) : polyBase && polyBase.length >= 2 ? (
              <>
                <path d={path(polyBase, true)} className={css.poly} vectorEffect="non-scaling-stroke" data-testid="boundary-polygon"
                  data-vertices={polyBase.length} data-points={JSON.stringify(p.polygon)} />
                {g.hover?.kind === "edge" && g.modeKind === "idle" && <path d={path(polyBase, true)} className={css.polyHover} vectorEffect="non-scaling-stroke" />}
              </>
            ) : null}
            <BadgeLayer layout={layout} status={p.status} scale={s} selectedId={p.selectedId} hoveredId={p.hoveredId ?? hoverId} fanKey={fanStack?.key ?? null} />
            {!strokeBase && polyBase && polyBase.map((h, i) => (
              <circle key={i} cx={h[0]} cy={h[1]} r={(g.activeHandle === i ? HANDLE_R + 2 : HANDLE_R) / s}
                className={g.activeHandle === i ? css.handleActive : css.handle} vectorEffect="non-scaling-stroke" data-testid="boundary-handle" />
            ))}
          </g>
        </g>
        <g pointerEvents="none">
          {atIdentity && (
            <>
              <text className={css.axisText} x={plot.x - 6} y={plot.y + 8} textAnchor="end">High</text>
              <text className={css.axisText} x={plot.x - 6} y={plot.y + plot.h} textAnchor="end">Low</text>
              <text className={css.axisText} x={plot.x} y={plot.y + plot.h + 14}>Low</text>
              <text className={css.axisText} x={plot.x + plot.w} y={plot.y + plot.h + 14} textAnchor="end">High</text>
            </>
          )}
          <text className={css.axisName} x={plot.x + plot.w / 2} y={plot.y + plot.h + 30} textAnchor="middle" data-testid="x-axis-name">{p.xDim.name} →</text>
          <text className={css.axisName} transform={`translate(${plot.x - 26},${plot.y + plot.h / 2}) rotate(-90)`} textAnchor="middle" data-testid="y-axis-name">{p.yDim.name} →</text>
        </g>
        {fanStack && (
          <FanOut stack={fanStack} layout={layout} camera={cam.camera} status={p.status}
            onApprove={p.onApprove} onRemove={p.onRemove} onSelect={(id) => p.onSelect(id)} />
        )}
      </svg>
      <Toolbar tool={tool} onTool={setTool} scale={s} onZoomIn={() => cam.zoomBy(ZOOM_STEP)} onZoomOut={() => cam.zoomBy(1 / ZOOM_STEP)}
        onFit={() => cam.fit([...layout.data.values()])} onUndo={doUndo} canUndo={undo.current.size(pair) > 0} onClear={clear} canClear={!!p.polygon} />
      <Minimap points={layout.data} status={p.status} camera={cam.camera} plot={plot} onCenter={cam.center} />
      {!coachDone && <CoachHint />}
      {hoverStep && <HoverCard step={hoverStep} st={p.status[hoverStep.id] ?? "pending"} at={baseToScreen(layout.base.get(hoverStep.id)!, cam.camera) as Point}
        idx={p.idx} xDim={p.xDim} yDim={p.yDim} size={size} />}
    </div>
  );
});
```

Notes for the implementer:
- `useCallback` deps marked with `eslint-disable-line` exist because `p` is a fresh object per render; there is no ESLint in this repo, so the comments are documentation only. Delete them if the typecheck flags nothing.
- The world transform string is the only thing that changes on pan; `BadgeLayer` is `memo` and receives no `tx/ty`, which U3-7's e2e verifies through `data-renders`.

- [ ] **Step 5: Verify** — `cd app && npm run typecheck && npm test && E2E_PORT=1433 npx playwright test e2e/smoke.spec.ts` → clean, all pass, smoke `2 passed`.
- [ ] **Step 6: Commit** — `git add app/src/canvas && git commit -m "canvas: composed v2 canvas (toolbar, minimap, coach hint, axis labels)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

### Task U3-7: `e2e/canvas.spec.ts` (gesture, zoom, fan-out, undo, feel)

Mock fixture points on the default axes (action uncertainty × reversibility): 1 (0.113, 0.075), 2 (0.455, 0.212), 3 (0.438, 0.050), 4 (0.138, 0.125), 5 (0.525, 0.138), 6 (0.475, 0.625). At 50% zoom, steps 1 and 4 overlap and form the stack `data-members="1,4"`. At 100% they are separate.

**Files:** Create `app/e2e/canvas.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { expect, test, type Page } from "@playwright/test";

async function openReview(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("badge-6")).toBeVisible();
}

async function plotBox(page: Page) {
  const svg = page.getByTestId("boundary-canvas");
  const box = (await svg.boundingBox())!;
  const [x, y, w, h] = (await svg.getAttribute("data-plot"))!.split(",").map(Number);
  return { left: box.x + x, top: box.y + y, w, h };
}

/** Screen point for a data-space point at identity camera. */
const at = (pl: { left: number; top: number; w: number; h: number }, x: number, y: number) => ({ x: pl.left + x * pl.w, y: pl.top + (1 - y) * pl.h });

/** Ellipse loop around data (cx,cy) with radii (rx,ry); calls `beforeUp` before releasing. */
async function loop(page: Page, c: { x: number; y: number }, rx: number, ry: number, beforeUp?: () => Promise<void>) {
  await page.mouse.move(c.x + rx, c.y);
  await page.mouse.down();
  for (let k = 1; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    await page.mouse.move(c.x + rx * Math.cos(a), c.y + ry * Math.sin(a));
  }
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}

async function targets(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>('[data-testid^="badge-"]:not([data-testid="badge-layer"]):not([data-testid="badge-tooltip"]), [data-testid="stack-badge"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-testid")!, status: el.getAttribute("data-status")!, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
}

test("loop reclassifies live, before mouseup", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  const c = at(pl, 0.13, 0.1);
  const rx = 0.09 * pl.w, ry = 0.12 * pl.h;
  await loop(page, c, rx, ry, async () => {
    const ts = await targets(page);
    const inside = ts.filter((t) => ((t.x - c.x) / rx) ** 2 + ((t.y - c.y) / ry) ** 2 < 0.8);
    const outside = ts.filter((t) => ((t.x - c.x) / rx) ** 2 + ((t.y - c.y) / ry) ** 2 > 1.25);
    expect(inside.length).toBeGreaterThan(0);
    for (const t of inside) expect(t.status, t.id).toBe("approved");
    for (const t of outside) expect(t.status, t.id).not.toBe("approved");
  });
  const v = Number(await page.getByTestId("boundary-polygon").getAttribute("data-vertices"));
  expect(v).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-4")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-6")).toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("coach-hint")).toHaveCount(0);
});

test("draw at 400% zoom: every stored vertex stays in [0,1]", async ({ page }) => {
  await openReview(page);
  for (let i = 0; i < 4; i++) await page.getByTestId("canvas-zoom-in").click();
  await expect(page.getByTestId("canvas-zoom-label")).toHaveText("400%");
  const pl = await plotBox(page);
  // A loop much larger than the visible plot: points run off the plot and off the canvas.
  await loop(page, { x: pl.left + pl.w / 2, y: pl.top + pl.h / 2 }, pl.w * 0.7, pl.h * 0.7);
  const pts = JSON.parse((await page.getByTestId("boundary-polygon").getAttribute("data-points"))!) as [number, number][];
  expect(pts.length).toBeGreaterThanOrEqual(3);
  for (const [x, y] of pts) {
    expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1);
  }
});

test("stack at 50%: fan out and approve one member", async ({ page }) => {
  await openReview(page);
  await page.getByTestId("canvas-zoom-out").click();
  await page.getByTestId("canvas-zoom-out").click();
  await expect(page.getByTestId("canvas-zoom-label")).toHaveText("50%");
  const stack = page.locator('[data-testid="stack-badge"][data-members="1,4"]');
  await expect(stack).toBeVisible();
  await stack.click();
  await expect(page.getByTestId("fan-out")).toBeVisible();
  await page.getByTestId("fan-approve-4").click();
  await expect(page.getByTestId("badge-4")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "pending");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fan-out")).toHaveCount(0);
  await expect(stack).toHaveAttribute("data-status", "mixed");
});

test("undo restores the previous polygon; clear then undo brings it back", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  await loop(page, at(pl, 0.13, 0.1), 0.09 * pl.w, 0.12 * pl.h);
  const first = await page.getByTestId("boundary-polygon").getAttribute("data-points");
  await loop(page, at(pl, 0.48, 0.2), 0.12 * pl.w, 0.2 * pl.h);
  expect(await page.getByTestId("boundary-polygon").getAttribute("data-points")).not.toBe(first);
  await page.getByTestId("canvas-undo").click();
  await expect(page.getByTestId("boundary-polygon")).toHaveAttribute("data-points", first!);
  await page.getByTestId("canvas-clear").click();
  await expect(page.getByTestId("boundary-polygon")).toHaveCount(0);
  await page.keyboard.press("Meta+z");
  await expect(page.getByTestId("boundary-polygon")).toHaveAttribute("data-points", first!);
});

test("pan never re-renders badges; Fit returns to a framing camera", async ({ page }) => {
  await openReview(page);
  for (let i = 0; i < 2; i++) await page.getByTestId("canvas-zoom-in").click();
  const svg = page.getByTestId("boundary-canvas");
  const layer = page.getByTestId("badge-layer");
  const before = await layer.getAttribute("data-renders");
  const ty0 = await svg.getAttribute("data-ty");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120); // plain wheel = pan
  await expect(svg).not.toHaveAttribute("data-ty", ty0!);
  expect(await layer.getAttribute("data-renders")).toBe(before);
  await page.getByTestId("canvas-fit").click();
  for (const i of [1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`badge-${i}`)).toBeInViewport();
});

test("feel: pointermove → next frame under 16 ms (median) during a handle drag", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  await loop(page, at(pl, 0.3, 0.15), 0.25 * pl.w, 0.15 * pl.h);
  const h = (await page.getByTestId("boundary-handle").first().boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __feel: number[] };
    w.__feel = [];
    window.addEventListener("pointermove", (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => w.__feel.push(performance.now() - t0));
    }, { capture: true });
  });
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) await page.mouse.move(h.x + h.width / 2 + i * 2, h.y + h.height / 2 - i);
  await page.mouse.up();
  const ms = await page.evaluate(() => (window as unknown as { __feel: number[] }).__feel.slice().sort((a, b) => a - b));
  const median = ms[Math.floor(ms.length / 2)];
  // Budget is one 60 Hz frame. A loaded CI box can override with FEEL_BUDGET_MS; locally it must hold at 16.
  expect(median).toBeLessThan(Number(process.env.FEEL_BUDGET_MS ?? 16));
});
```

- [ ] **Step 2: Run** — `cd app && E2E_PORT=1433 npx playwright test e2e/canvas.spec.ts e2e/smoke.spec.ts` → all pass. Typical fixes if one fails:
  - The live test sees `pending` inside the loop: the move path is not calling `emit(..., false)` inside `flushSync`.
  - The stack test finds no `[data-members="1,4"]`: check `minSeparation(BADGE_R)` is applied to `base × scale`, not to base px.
  - `data-renders` changes on pan: something passed to `BadgeLayer` depends on `tx/ty` (look for an inline object or arrow prop).
- [ ] **Step 3: Full checks** — `cd app && npm run typecheck && npm test` → clean.
- [ ] **Step 4: Commit** — `git add app/e2e/canvas.spec.ts && git commit -m "canvas: e2e for live loop, zoomed draw, fan-out, undo, pan cost, feel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"`

---

**Track exit:** `git diff --name-only ui-redesign...HEAD` lists only Owns paths; `npm run typecheck && npm test` clean; `E2E_PORT=1433 npx playwright test e2e/canvas.spec.ts e2e/smoke.spec.ts` green.
