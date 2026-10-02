import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import { rawPoint, type ScoreIndex } from "../lib/approval";
import { clampPoint, jitterFor, pointInPolygon, projectOnSegment, simplifyClosedStroke } from "../lib/geometry";
import { glyphPaths } from "./Glyph";

// The boundary gesture. SVG + pointer events + custom hit testing.
//
// Every pointermove during a draw or drag computes the new polygon and hands
// it up with flushSync, so the badge colours and the header counts commit in
// the same frame as the pointer. Nothing waits for pointerup.

const BADGE_R = 13; // ~26pt badge
const HANDLE_R = 4; // ~8pt visual handle
const HANDLE_HIT = 14; // generous grab radius
const EDGE_HIT = 9;
const BADGE_HIT = BADGE_R + 2;
const DRAG_THRESHOLD = 3;

const M = { left: 40, right: 14, top: 14, bottom: 38 };

type Mode =
  | { kind: "idle" }
  | { kind: "maybe"; start: Point; badgeId: string | null; prev: Point[] | null }
  | { kind: "draw"; stroke: Point[]; prev: Point[] | null }
  | { kind: "handle"; idx: number; grab: Point; poly: Point[]; prev: Point[] }
  | { kind: "move"; start: Point; poly: Point[]; prev: Point[]; moved: boolean };

interface Props {
  steps: Step[];
  idx: ScoreIndex;
  xDim: Dimension;
  yDim: Dimension;
  polygon: Point[] | null;
  status: Record<string, StepStatus>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** final=false during a gesture (live), true on release (persist). */
  onPolygonChange: (poly: Point[] | null, final: boolean) => void;
}

const STATUS_FILL: Record<StepStatus, string> = {
  approved: "var(--approved)",
  pending: "var(--pending)",
  removed: "rgba(255,255,255,0.05)",
};
const STATUS_TEXT: Record<StepStatus, string> = {
  approved: "Approved",
  pending: "Pending approval",
  removed: "Removed by oversight",
};

export const BoundaryCanvas = memo(function BoundaryCanvas(props: Props) {
  const { steps, idx, xDim, yDim, polygon, status, selectedId, onSelect, onPolygonChange } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const modeRef = useRef<Mode>({ kind: "idle" });
  const [size, setSize] = useState({ w: 640, h: 300 });
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);
  const [hover, setHover] = useState<{ kind: "badge"; id: string } | { kind: "handle" | "edge" | "inside" } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(200, Math.round(r.width)), h: Math.max(160, Math.round(r.height)) });
      rectRef.current = null;
    });
    ro.observe(el);
    const inval = () => (rectRef.current = null);
    window.addEventListener("scroll", inval, true);
    window.addEventListener("resize", inval);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", inval, true);
      window.removeEventListener("resize", inval);
    };
  }, []);

  const pw = size.w - M.left - M.right;
  const ph = size.h - M.top - M.bottom;

  // Normalized <-> pixel (y up in data space, down on screen).
  const toPx = useCallback((p: Point): Point => [M.left + p[0] * pw, M.top + (1 - p[1]) * ph], [pw, ph]);
  const toNorm = useCallback((px: Point): Point => [(px[0] - M.left) / pw, 1 - (px[1] - M.top) / ph], [pw, ph]);

  // Badge layout: RAW position + cosmetic jitter for display only.
  // `anchor` is the true point (what classification uses). When several steps
  // share nearly the same scores their badges would stack into one, so badges
  // that collide are pushed apart deterministically and a leader line ties
  // each displaced badge back to its true point. Display only: the approval
  // test never reads `px`.
  const badges = useMemo(() => {
    const out: { step: Step; raw: Point; anchor: Point; px: Point }[] = [];
    for (const s of steps) {
      const raw = rawPoint(idx, s.id, xDim.key, yDim.key);
      if (!raw) continue;
      const j = jitterFor(s.id);
      const shown = clampPoint([raw[0] + j[0], raw[1] + j[1]]);
      const anchor = toPx(clampPoint(raw));
      out.push({ step: s, raw, anchor, px: toPx(shown) });
    }
    const minD = 2 * BADGE_R + 3;
    const lo: Point = [M.left + BADGE_R, M.top + BADGE_R];
    const hi: Point = [M.left + pw - BADGE_R, M.top + ph - BADGE_R];
    const pos = out.map((b) => [b.px[0], b.px[1]] as Point);
    for (let iter = 0; iter < 60; iter++) {
      let moved = false;
      for (let a = 0; a < pos.length; a++) {
        for (let b = a + 1; b < pos.length; b++) {
          let dx = pos[b][0] - pos[a][0];
          let dy = pos[b][1] - pos[a][1];
          let d = Math.hypot(dx, dy);
          if (d >= minD) continue;
          if (d < 1e-3) {
            const ang = (b * 2.39996) % (2 * Math.PI); // golden angle, deterministic
            dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
          }
          const push = (minD - d) / 2 + 0.25;
          const ux = dx / d, uy = dy / d;
          pos[a] = [pos[a][0] - ux * push, pos[a][1] - uy * push];
          pos[b] = [pos[b][0] + ux * push, pos[b][1] + uy * push];
          moved = true;
        }
      }
      for (const p of pos) {
        p[0] = Math.min(hi[0], Math.max(lo[0], p[0]));
        p[1] = Math.min(hi[1], Math.max(lo[1], p[1]));
      }
      if (!moved) break;
    }
    out.forEach((b, i) => { b.px = pos[i]; });
    return out;
  }, [steps, idx, xDim.key, yDim.key, toPx, pw, ph]);

  const polyPx = useMemo(() => (polygon ? polygon.map(toPx) : null), [polygon, toPx]);

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    let r = rectRef.current;
    if (!r) r = rectRef.current = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  type Hit =
    | { kind: "handle"; idx: number }
    | { kind: "edge"; idx: number; at: Point }
    | { kind: "inside" }
    | { kind: "badge"; id: string }
    | { kind: "empty" };

  const hitTest = (p: Point): Hit => {
    if (polyPx && polyPx.length) {
      let best = -1;
      let bestD = HANDLE_HIT;
      polyPx.forEach((h, i) => {
        const d = Math.hypot(h[0] - p[0], h[1] - p[1]);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) return { kind: "handle", idx: best };
      let eBest = -1;
      let eD = EDGE_HIT;
      let at: Point = p;
      for (let i = 0; i < polyPx.length; i++) {
        const a = polyPx[i];
        const b = polyPx[(i + 1) % polyPx.length];
        const pr = projectOnSegment(p, a, b);
        if (pr.dist <= eD) {
          eD = pr.dist;
          eBest = i;
          at = pr.point;
        }
      }
      if (eBest >= 0) return { kind: "edge", idx: eBest, at };
    }
    for (let i = badges.length - 1; i >= 0; i--) {
      const b = badges[i];
      if (Math.hypot(b.px[0] - p[0], b.px[1] - p[1]) <= BADGE_HIT) return { kind: "badge", id: b.step.id };
    }
    if (polyPx && polyPx.length >= 3 && pointInPolygon(p[0], p[1], polyPx)) return { kind: "inside" };
    return { kind: "empty" };
  };

  const emit = (poly: Point[] | null, final: boolean) => {
    if (final) onPolygonChange(poly, true);
    else flushSync(() => onPolygonChange(poly, false));
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    rectRef.current = svgRef.current!.getBoundingClientRect();
    const p = localPoint(e);
    try {
      svgRef.current!.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers have no capture target; harmless */
    }
    const hit = hitTest(p);
    const prev = polygon ? polygon.map((q) => [q[0], q[1]] as Point) : null;
    if (hit.kind === "handle" && polygon) {
      const n = toNorm(p);
      const h = polygon[hit.idx];
      modeRef.current = { kind: "handle", idx: hit.idx, grab: [h[0] - n[0], h[1] - n[1]], poly: prev!, prev: prev! };
      setActiveHandle(hit.idx);
      setDragging(true);
    } else if ((hit.kind === "edge" || hit.kind === "inside") && polygon) {
      modeRef.current = { kind: "move", start: toNorm(p), poly: prev!, prev: prev!, moved: false };
    } else {
      modeRef.current = { kind: "maybe", start: p, badgeId: hit.kind === "badge" ? hit.id : null, prev };
    }
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const m = modeRef.current;
    const p = localPoint(e);
    if (m.kind === "idle") {
      const hit = hitTest(p);
      const next =
        hit.kind === "badge" ? { kind: "badge" as const, id: hit.id } : hit.kind === "empty" ? null : { kind: hit.kind };
      setHover((cur) => {
        if (!cur && !next) return cur;
        if (cur && next && cur.kind === next.kind && (cur.kind !== "badge" || (next.kind === "badge" && cur.id === next.id))) return cur;
        return next;
      });
      return;
    }
    if (m.kind === "maybe") {
      if (Math.hypot(p[0] - m.start[0], p[1] - m.start[1]) < DRAG_THRESHOLD) return;
      const s0 = clampPoint(toNorm(m.start));
      const s1 = clampPoint(toNorm(p));
      modeRef.current = { kind: "draw", stroke: [s0, s1], prev: m.prev };
      setHover(null);
      setDragging(true);
      flushSync(() => setStroke([s0, s1]));
      emit([s0, s1], false);
      return;
    }
    if (m.kind === "draw") {
      const n = clampPoint(toNorm(p));
      const last = m.stroke[m.stroke.length - 1];
      const lp = toPx(last);
      if (Math.hypot(lp[0] - p[0], lp[1] - p[1]) < 1.5) return;
      m.stroke = [...m.stroke, n];
      flushSync(() => setStroke(m.stroke));
      // Provisional polygon: the stroke closed implicitly, classified live.
      emit(m.stroke.length >= 3 ? m.stroke : null, false);
      return;
    }
    if (m.kind === "handle") {
      const n = toNorm(p);
      const next = m.poly.slice();
      next[m.idx] = clampPoint([n[0] + m.grab[0], n[1] + m.grab[1]]);
      m.poly = next;
      emit(next, false);
      return;
    }
    if (m.kind === "move") {
      const n = toNorm(p);
      let dx = n[0] - m.start[0];
      let dy = n[1] - m.start[1];
      if (!m.moved && Math.hypot(dx * pw, dy * ph) < DRAG_THRESHOLD) return;
      if (!m.moved) {
        m.moved = true;
        setDragging(true);
      }
      // Keep the whole shape inside the unit square.
      const xs = m.prev.map((q) => q[0]);
      const ys = m.prev.map((q) => q[1]);
      dx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
      dy = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
      const next = m.prev.map((q) => [q[0] + dx, q[1] + dy] as Point);
      m.poly = next;
      emit(next, false);
    }
  };

  const finish = (e: React.PointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const m = modeRef.current;
    modeRef.current = { kind: "idle" };
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    setDragging(false);
    setActiveHandle(null);
    if (m.kind === "maybe") {
      if (!cancelled) onSelect(m.badgeId);
      return;
    }
    if (m.kind === "draw") {
      setStroke(null);
      if (cancelled) return emit(m.prev, true);
      const strokePx = m.stroke.map(toPx);
      const poly = simplifyClosedStroke(strokePx, 6, 10).map((q) => clampPoint(toNorm(q)));
      // Reject scribbles too small to be a deliberate region.
      const area = Math.abs(polyArea(poly.map(toPx)));
      if (poly.length < 3 || area < 180) return emit(m.prev, true);
      emit(poly, true);
      return;
    }
    if (m.kind === "handle") {
      if (m.poly !== m.prev) emit(cancelled ? m.prev : m.poly, true);
      return;
    }
    if (m.kind === "move") {
      if (m.moved) emit(cancelled ? m.prev : m.poly, true);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!polygon) return;
    rectRef.current = svgRef.current!.getBoundingClientRect();
    const p = localPoint(e);
    const hit = hitTest(p);
    if (hit.kind === "handle") {
      // Double-click a handle removes it (kept at 3 minimum).
      if (polygon.length > 3) emit(polygon.filter((_, i) => i !== hit.idx), true);
      return;
    }
    if (hit.kind === "edge") {
      const next = polygon.slice();
      next.splice(hit.idx + 1, 0, clampPoint(toNorm(hit.at)));
      emit(next, true);
    }
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const m = modeRef.current;
      if (m.kind === "draw" || m.kind === "handle" || m.kind === "move") {
        modeRef.current = { kind: "idle" };
        setStroke(null);
        setDragging(false);
        setActiveHandle(null);
        onPolygonChange(m.prev, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPolygonChange]);

  const cursor =
    activeHandle !== null || (dragging && modeRef.current.kind === "move")
      ? "grabbing"
      : dragging
        ? "crosshair"
        : hover?.kind === "handle"
          ? "grab"
          : hover?.kind === "edge"
            ? "copy"
            : hover?.kind === "inside"
              ? "move"
              : hover?.kind === "badge"
                ? "pointer"
                : "crosshair";

  const pathOf = (pts: Point[], close: boolean) =>
    pts.length ? "M" + pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join("L") + (close ? "Z" : "") : "";

  const hovered = hover?.kind === "badge" && !dragging ? badges.find((b) => b.step.id === hover.id) : undefined;

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        className="boundary-canvas"
        data-testid="boundary-canvas"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => modeRef.current.kind === "idle" && setHover(null)}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <linearGradient id="plotWash" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#1f4a3a" stopOpacity="0.55" />
            <stop offset="0.5" stopColor="#24323a" stopOpacity="0.35" />
            <stop offset="1" stopColor="#5a2a30" stopOpacity="0.55" />
          </linearGradient>
          <filter id="badgeShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.4" floodColor="#000" floodOpacity="0.45" />
          </filter>
        </defs>

        {/* plot */}
        <rect x={M.left} y={M.top} width={pw} height={ph} fill="url(#plotWash)" stroke="rgba(255,255,255,0.08)" />
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="rgba(255,255,255,0.07)" strokeWidth={1}>
            <line x1={M.left + (pw * i) / 4} x2={M.left + (pw * i) / 4} y1={M.top} y2={M.top + ph} />
            <line y1={M.top + (ph * i) / 4} y2={M.top + (ph * i) / 4} x1={M.left} x2={M.left + pw} />
          </g>
        ))}

        {/* axes */}
        <g className="axis-text">
          <text x={M.left - 6} y={M.top + 8} textAnchor="end">High</text>
          <text x={M.left - 6} y={M.top + ph} textAnchor="end">Low</text>
          <text x={M.left} y={M.top + ph + 14}>Low</text>
          <text x={M.left + pw} y={M.top + ph + 14} textAnchor="end">High</text>
          <text className="axis-name" x={M.left + pw / 2} y={M.top + ph + 30} textAnchor="middle" data-testid="x-axis-name">
            {xDim.name}
          </text>
          <text
            className="axis-name"
            transform={`translate(${M.left - 24},${M.top + ph / 2}) rotate(-90)`}
            textAnchor="middle"
            data-testid="y-axis-name"
          >
            {yDim.name}
          </text>
        </g>

        {/* boundary */}
        {stroke ? (
          <path d={pathOf(stroke.map(toPx), true)} className="poly-fill drawing" />
        ) : polyPx && polyPx.length >= 2 ? (
          <>
            <path d={pathOf(polyPx, true)} className="poly-fill" data-testid="boundary-polygon" data-vertices={polyPx.length} />
            {hover?.kind === "edge" && !dragging && <path d={pathOf(polyPx, true)} className="poly-edge-hover" />}
          </>
        ) : null}

        {/* leader lines: true point -> displaced badge */}
        <g className="badge-leaders" pointerEvents="none">
          {badges.map(({ step, anchor, px }) =>
            Math.hypot(px[0] - anchor[0], px[1] - anchor[1]) > BADGE_R * 0.6 ? (
              <g key={step.id}>
                <line x1={anchor[0]} y1={anchor[1]} x2={px[0]} y2={px[1]} className="badge-leader" />
                <circle cx={anchor[0]} cy={anchor[1]} r={2.6} className={`badge-anchor badge-anchor-${status[step.id] ?? "pending"}`} />
              </g>
            ) : null,
          )}
        </g>

        {/* badges */}
        <g>
          {badges.map(({ step, px }) => {
            const st = status[step.id] ?? "pending";
            const sel = step.id === selectedId;
            return (
              <g
                key={step.id}
                transform={`translate(${px[0].toFixed(1)},${px[1].toFixed(1)})`}
                className={`badge badge-${st}`}
                data-testid={`badge-${step.index}`}
                data-status={st}
              >
                {sel && <circle r={BADGE_R + 4} className="badge-ring" />}
                <circle
                  r={BADGE_R}
                  fill={STATUS_FILL[st]}
                  stroke={st === "removed" ? "rgba(220,220,220,0.55)" : "rgba(255,255,255,0.35)"}
                  strokeWidth={st === "removed" ? 1.2 : 1}
                  strokeDasharray={st === "removed" ? "3 2.5" : undefined}
                  filter={st === "removed" ? undefined : "url(#badgeShadow)"}
                />
                <g
                  transform="translate(-7.2,-7.2) scale(0.6)"
                  fill="none"
                  stroke={st === "removed" ? "rgba(220,220,220,0.6)" : "#fff"}
                  color={st === "removed" ? "rgba(220,220,220,0.6)" : "#fff"}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {glyphPaths(String(step.glyph))}
                </g>
              </g>
            );
          })}
        </g>

        {/* handles on top so they always win the grab */}
        {!stroke && polyPx && (
          <g>
            {polyPx.map((h, i) => (
              <circle
                key={i}
                cx={h[0]}
                cy={h[1]}
                r={activeHandle === i ? HANDLE_R + 2 : HANDLE_R}
                className={`handle${activeHandle === i ? " active" : ""}`}
                data-testid="boundary-handle"
              />
            ))}
          </g>
        )}
      </svg>

      {hovered && <BadgeTooltip b={hovered} st={status[hovered.step.id] ?? "pending"} idx={idx} xDim={xDim} yDim={yDim} size={size} />}
    </div>
  );
});

function polyArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

function BadgeTooltip({
  b,
  st,
  idx,
  xDim,
  yDim,
  size,
}: {
  b: { step: Step; px: Point };
  st: StepStatus;
  idx: ScoreIndex;
  xDim: Dimension;
  yDim: Dimension;
  size: { w: number; h: number };
}) {
  const sx = idx.get(b.step.id)?.get(xDim.key);
  const sy = idx.get(b.step.id)?.get(yDim.key);
  const W = 270;
  const left = b.px[0] + 18 + W > size.w ? b.px[0] - 18 - W : b.px[0] + 18;
  const top = Math.max(4, Math.min(b.px[1] - 40, size.h - 170));
  return (
    <div className="badge-tip" style={{ left, top, width: W }} role="tooltip" data-testid="badge-tooltip">
      <div className="tip-head">
        <span className="tip-index">#{b.step.index}</span>
        <span className={`tip-status st-${st}`}>
          <i className="dot" /> {STATUS_TEXT[st]}
        </span>
      </div>
      <div className="tip-title">{b.step.title}</div>
      <div className="tip-desc">{b.step.description}</div>
      <div className="tip-rule" />
      {[
        [xDim, sx],
        [yDim, sy],
      ].map(([d, s]) => {
        const dim = d as Dimension;
        const sc = s as typeof sx;
        return (
          <div key={dim.key} className="tip-dim">
            <div>
              {dim.name}: <b>{sc?.label ?? "n/a"}</b>
            </div>
            {sc?.rationale && <div className="tip-why">{sc.rationale}</div>}
          </div>
        );
      })}
    </div>
  );
}
