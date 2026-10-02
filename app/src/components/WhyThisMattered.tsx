import { useState } from "react";
import type { Dimension, Step } from "../api/types";
import type { ScoreIndex } from "../lib/approval";
import { Icon } from "./Glyph";

// "Why this mattered": per-dimension categorical verdicts from the STORED
// scores (never re-derived from prose), highest-risk first. For each removed
// step, or the riskiest approved step when nothing was removed.

const SHOW = 4;

export function WhyThisMattered({
  removed,
  approved,
  idx,
  dims,
}: {
  removed: Step[];
  approved: Step[];
  idx: ScoreIndex;
  dims: Dimension[];
}) {
  let subjects = removed;
  let riskiest = false;
  if (!subjects.length && approved.length) {
    const mean = (s: Step) => {
      const m = idx.get(s.id);
      if (!m || !m.size) return 0;
      let t = 0;
      m.forEach((sc) => (t += sc.position));
      return t / m.size;
    };
    subjects = [approved.reduce((a, b) => (mean(b) > mean(a) ? b : a))];
    riskiest = true;
  }
  if (!subjects.length) return null;
  return (
    <div className="block why" data-testid="why-this-mattered">
      <div className="block-label warn">
        {Icon.warn(12)} Why this mattered
      </div>
      {subjects.map((s) => (
        <WhyStep key={s.id} step={s} idx={idx} dims={dims} showTitle={subjects.length > 1 || riskiest} riskiest={riskiest} />
      ))}
    </div>
  );
}

function WhyStep({ step, idx, dims, showTitle, riskiest }: { step: Step; idx: ScoreIndex; dims: Dimension[]; showTitle: boolean; riskiest: boolean }) {
  const [all, setAll] = useState(false);
  const scores = [...(idx.get(step.id)?.values() ?? [])].sort((a, b) => b.position - a.position);
  const name = (k: string) => dims.find((d) => d.key === k)?.name ?? k;
  const shown = all ? scores : scores.slice(0, SHOW);
  return (
    <div className="why-step">
      {showTitle && (
        <div className="why-title">
          {riskiest ? "Riskiest approved step: " : ""}
          {step.index}. {step.title}
        </div>
      )}
      <ul className="why-list">
        {shown.map((s) => (
          <li key={s.dimension} title={s.rationale} data-testid="why-item">
            <i className="dot" style={{ background: "var(--pending)" }} />
            <span>
              {name(s.dimension)}: {s.label}
            </span>
            <span className="why-rationale">{s.rationale}</span>
          </li>
        ))}
      </ul>
      {scores.length > SHOW && (
        <button className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${scores.length} dimensions`}
        </button>
      )}
    </div>
  );
}
