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
          // Idle hover re-reads the rect (layout is clean then, so it's cheap) so a
          // scroll or resize never offsets hit testing; gestures use the pointerdown rect.
          if (m.kind === "idle") rect.current = d.current.svgRef.current?.getBoundingClientRect() ?? rect.current;
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
