import { memo, useRef } from "react";
import type { Point, Step, StepStatus } from "../api/types";
import { stackStatus } from "../lib/stacks";
import css from "./BoundaryCanvas.module.css";
import { BADGE_R } from "./constants";
import type { BadgeLayout } from "./useBadgeLayout";

export function Badge({ step, at, st, scale, selected, hovered }: { step: Step; at: Point; st: StepStatus; scale: number; selected: boolean; hovered: boolean }) {
  return (
    <g className={css.badge} data-testid={`badge-${step.index}`} data-status={st} data-step-id={step.id}
      transform={`translate(${at[0].toFixed(2)} ${at[1].toFixed(2)}) scale(${(1 / scale).toFixed(5)})`}>
      {(selected || hovered) && <circle r={BADGE_R + 4} className={selected ? css.ring : css.hoverRing} />}
      <circle r={BADGE_R} className={css.disk} />
      <text className={css.num} dy="0.35em">{step.index}</text>
    </g>
  );
}

export const BadgeLayer = memo(function BadgeLayer(p: {
  layout: BadgeLayout; status: Record<string, StepStatus>; scale: number;
  selectedId: string | null; hoveredId: string | null; fanKey: string | null;
}) {
  const renders = useRef(0);
  renders.current += 1;
  const { layout, status, scale } = p;
  return (
    <g data-testid="badge-layer" data-renders={renders.current}>
      {layout.stacks.map((s) => {
        if (s.ids.length === 1) {
          const id = s.ids[0];
          return <Badge key={id} step={layout.byId.get(id)!} at={layout.base.get(id)!} st={status[id] ?? "pending"} scale={scale}
            selected={id === p.selectedId} hovered={id === p.hoveredId} />;
        }
        // True points of every member, always visible under a stack or its fan.
        const dots = s.ids.map((id) => {
          const b = layout.base.get(id)!;
          return <circle key={`a-${id}`} cx={b[0]} cy={b[1]} r={2.4 / scale} className={css.anchor} />;
        });
        if (s.key === p.fanKey) return <g key={s.key}>{dots}</g>;
        const shared = stackStatus<StepStatus>(s.ids, status, "pending");
        const members = s.ids.map((id) => layout.byId.get(id)!.index).sort((a, b) => a - b);
        const sel = s.ids.includes(p.selectedId ?? "") || s.ids.includes(p.hoveredId ?? "");
        return (
          <g key={s.key}>
            <g className={css.badge} data-testid="stack-badge" data-members={members.join(",")} data-status={shared}
              transform={`translate(${s.centerBase[0].toFixed(2)} ${s.centerBase[1].toFixed(2)}) scale(${(1 / scale).toFixed(5)})`}>
              {sel && <circle r={BADGE_R + 6} className={css.ring} />}
              <circle r={BADGE_R + 2} className={css.disk} />
              <text className={css.num} dy="0.35em">×{s.ids.length}</text>
            </g>
            {dots}
          </g>
        );
      })}
    </g>
  );
});
