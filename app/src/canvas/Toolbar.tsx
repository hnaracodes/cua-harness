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
