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
