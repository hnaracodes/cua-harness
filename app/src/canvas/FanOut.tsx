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
