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

export interface BoundaryCanvasProps {
  steps: Step[];
  idx: ScoreIndex;
  xDim: Dimension;
  yDim: Dimension;
  polygon: Point[] | null;
  status: Record<string, StepStatus>;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onPolygonChange: (poly: Point[] | null, final: boolean) => void;
  onApprove: (id: string) => void;  // from fan-out
  onRemove: (id: string) => void;   // from fan-out
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
// Space activates a focused button or link; never steal it for space-drag there.
const pressable = (t: EventTarget | null) => t instanceof HTMLElement && (/^(BUTTON|A)$/.test(t.tagName) || t.getAttribute("role") === "button");
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
      if (e.key === " ") { if (!pressable(e.target)) { e.preventDefault(); setSpaceHeld(true); } }
      else if (e.key === "+" || e.key === "=") cam.zoomBy(ZOOM_STEP);
      else if (e.key === "-") cam.zoomBy(1 / ZOOM_STEP);
      else if (e.key === "0") cam.fit([...layoutRef.current.data.values()]);
      else if (e.key === "d") setTool("draw");
      else if (e.key === "h") setTool("pan");
    };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };
    // A space released in another window never sends keyup here; drop it on blur or hide.
    const release = () => setSpaceHeld(false);
    const onVisibility = () => { if (document.hidden) release(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
