import type { Point } from "../api/types";

/**
 * Even-odd ray cast, written exactly as the contract addendum in
 * docs/01-architecture.md specifies so the UI and the daemon can never
 * disagree: for each edge (i, j = i - 1),
 * if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
 * then inside = !inside.
 */
export function pointInPolygon(x: number, y: number, poly: readonly Point[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampPoint = (p: Point): Point => [clamp01(p[0]), clamp01(p[1])];

function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return Math.hypot(p[0] - px, p[1] - py);
}

/** Ramer-Douglas-Peucker on an open path (iterative, no recursion depth risk). */
export function rdp(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistance(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Turn a freehand stroke into a closed, handled polygon with roughly
 * `minV`..`maxV` vertices. Binary-searches the RDP epsilon so a scribbly
 * stroke and a smooth one both land on a draggable handle count.
 * Points are in pixel space so the tolerance is isotropic on screen.
 */
export function simplifyClosedStroke(stroke: readonly Point[], minV = 6, maxV = 10): Point[] {
  if (stroke.length < 3) return stroke.slice();
  // Close the loop for simplification: split the ring at the point farthest
  // from the start so RDP sees two open halves and keeps the extremes.
  let far = 0;
  let farD = -1;
  for (let i = 0; i < stroke.length; i++) {
    const d = Math.hypot(stroke[i][0] - stroke[0][0], stroke[i][1] - stroke[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const run = (eps: number): Point[] => {
    const a = rdp(stroke.slice(0, far + 1), eps);
    const b = rdp([...stroke.slice(far), stroke[0]], eps);
    // a ends with stroke[far], b starts with it and ends with stroke[0]
    const ring = [...a, ...b.slice(1, -1)];
    return dedupe(ring, Math.max(eps * 0.5, 2));
  };
  let lo = 0.25;
  let hi = Math.max(farD, 1);
  let best = run(lo);
  if (best.length <= maxV && best.length >= minV) return best;
  if (best.length < minV) return best; // stroke has few distinct points already
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    const r = run(mid);
    if (r.length > maxV) lo = mid;
    else if (r.length < minV) hi = mid;
    else {
      best = r;
      // prefer the larger count within range for a closer fit
      if (r.length >= Math.round((minV + maxV) / 2)) return r;
      hi = mid;
      continue;
    }
    if (r.length >= minV && r.length <= maxV) best = r;
  }
  if (best.length > maxV || best.length < 3) best = run(lo);
  return best.length >= 3 ? best : stroke.slice(0, 3);
}

function dedupe(ring: Point[], minDist: number): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push(p);
  }
  if (out.length > 3) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < minDist) out.pop();
  }
  return out;
}

/** Closest point on segment ab to p, plus its distance and parameter. */
export function projectOnSegment(p: Point, a: Point, b: Point): { point: Point; dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]), t };
}

/** FNV-1a 32-bit, used to seed the cosmetic jitter. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const MAX_JITTER = 0.012;

/** Deterministic display-only offset, never used for classification. */
export function jitterFor(stepId: string): Point {
  const h = hash32(stepId);
  const a = ((h & 0xffff) / 0xffff) * 2 - 1;
  const b = (((h >>> 16) & 0xffff) / 0xffff) * 2 - 1;
  return [a * MAX_JITTER, b * MAX_JITTER];
}
