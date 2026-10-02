import type { Dimension, Point, Step, StepStatus } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import css from "./BoundaryCanvas.module.css";

const WORD: Record<StepStatus, string> = { approved: "Approved", pending: "Needs a decision", removed: "Removed" };

export function HoverCard({ step, st, at, idx, xDim, yDim, size }: {
  step: Step; st: StepStatus; at: Point; idx: ScoreIndex; xDim: Dimension; yDim: Dimension; size: { w: number; h: number };
}) {
  const W = 260;
  const left = at[0] + 20 + W > size.w ? at[0] - 20 - W : at[0] + 20;
  const top = Math.max(6, Math.min(at[1] - 30, size.h - 150));
  return (
    <div className={css.tip} style={{ left, top, width: W }} role="tooltip" data-testid="badge-tooltip">
      <div className={css.tipHead}><b>{step.index} · {step.title}</b><span data-status={st} className={css.tipStatus}>{WORD[st]}</span></div>
      {[xDim, yDim].map((dim) => {
        const sc = idx.get(step.id)?.get(dim.key);
        return (
          <div key={dim.key} className={css.tipDim}>
            {dim.name}: <b>{sc?.label ?? "n/a"}</b>
            {sc?.rationale && <div className={css.tipWhy}>{sc.rationale}</div>}
          </div>
        );
      })}
    </div>
  );
}
