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
