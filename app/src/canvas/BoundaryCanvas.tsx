// Wave 0 stub. Track U3 replaces this file; keep the exports and data-testids.
import { memo } from "react";
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import { BoundaryCanvas as PaperCanvas } from "../paper/BoundaryCanvas";
import "../paper/paper.css";

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

// Wave 0 adapter: renders the Paper canvas (scoped styles) until track U3 replaces this file.
export const BoundaryCanvas = memo(function BoundaryCanvas(p: BoundaryCanvasProps) {
  return (
    <div className="paper-root" style={{ height: "100%", background: "transparent" }}>
      <PaperCanvas steps={p.steps} idx={p.idx} xDim={p.xDim} yDim={p.yDim} polygon={p.polygon} status={p.status}
        selectedId={p.selectedId} onSelect={p.onSelect} onPolygonChange={p.onPolygonChange} />
    </div>
  );
});
