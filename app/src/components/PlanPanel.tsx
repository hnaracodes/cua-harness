import { memo, useEffect, useRef } from "react";
import type { Step, StepStatus } from "../api/types";
import { GlyphIcon, Icon } from "./Glyph";

interface Props {
  steps: Step[];
  status: Record<string, StepStatus>;
  checked: ReadonlySet<string>;
  inside: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCheck: (id: string, on: boolean) => void;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
  onSelectAll: () => void;
}

export const PlanPanel = memo(function PlanPanel(p: Props) {
  return (
    <section className="plan" aria-label="Review the plan">
      <div className="plan-head">
        <h2 className="panel-title">Review the plan</h2>
        <button className="btn btn-small" data-testid="select-all" onClick={p.onSelectAll}>
          Select All
        </button>
      </div>
      <div className="sub muted plan-sub">Check steps to accept. Uncheck and re-propose to change them.</div>
      <div className="cards">
        {p.steps.map((s) => (
          <StepCard
            key={s.id}
            step={s}
            st={p.status[s.id] ?? "pending"}
            checked={p.checked.has(s.id)}
            inside={p.inside.has(s.id)}
            selected={p.selectedId === s.id}
            onSelect={p.onSelect}
            onCheck={p.onCheck}
            onRemove={p.onRemove}
            onRestore={p.onRestore}
          />
        ))}
      </div>
    </section>
  );
});

const StepCard = memo(function StepCard({
  step,
  st,
  checked,
  inside,
  selected,
  onSelect,
  onCheck,
  onRemove,
  onRestore,
}: {
  step: Step;
  st: StepStatus;
  checked: boolean;
  inside: boolean;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onCheck: (id: string, on: boolean) => void;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const removed = st === "removed";
  return (
    <div
      ref={ref}
      id={`step-card-${step.id}`}
      data-testid={`step-card-${step.index}`}
      data-status={st}
      className={`card step-card st-${st}${checked ? " is-checked" : ""}${selected ? " is-selected" : ""}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button,input,label")) return;
        onSelect(selected ? null : step.id);
      }}
    >
      <label className="cb" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          data-testid={`check-${step.index}`}
          checked={checked && !removed}
          disabled={removed}
          onChange={(e) => onCheck(step.id, e.target.checked)}
          aria-label={`Approve step ${step.index}`}
        />
      </label>
      <div className="card-body">
        <div className="card-title-row">
          <GlyphIcon glyph={String(step.glyph)} size={13} className="card-glyph" />
          <span className="card-title">
            <span className="card-index">{step.index}.</span> {step.title}
          </span>
          {!removed && inside && !checked && <span className="tag tag-inside">In boundary</span>}
        </div>
        <div className="card-desc">{step.description}</div>
        {removed && (
          <div className="removed-note">
            {Icon.minusCircle(11)} <span>Removed by oversight - excluded from the plan</span>
          </div>
        )}
      </div>
      <div className="card-actions">
        {removed ? (
          <button className="btn btn-small" data-testid={`undo-${step.index}`} onClick={() => onRestore(step.id)}>
            Undo
          </button>
        ) : (
          <>
            <span title="Editing is cut for the sprint" data-testid={`edit-${step.index}`}>
              <button className="icon-btn" disabled aria-label="Edit step (cut for the sprint)">
                {Icon.pencil(12)}
              </button>
            </span>
            <button className="icon-btn" data-testid={`remove-${step.index}`} title="Remove this step" aria-label={`Remove step ${step.index}`} onClick={() => onRemove(step.id)}>
              {Icon.xCircle(14)}
            </button>
          </>
        )}
      </div>
    </div>
  );
});
