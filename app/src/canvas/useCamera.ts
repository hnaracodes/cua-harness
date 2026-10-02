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
