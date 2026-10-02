import { useEffect, useRef, useState } from "react";
import type { Step, StepStatus } from "../api/types";
import type { Session } from "../state/useSession";
import s from "./StepList.module.css";

export function StepList({ session, hoveredId, onHover }: { session: Session; hoveredId: string | null; onHover: (id: string | null) => void }) {
  const { state, cls } = session;
  return (
    <div className={s.list} onMouseLeave={() => onHover(null)}>
      {state.steps.map((st) => (
        <Row key={st.id} step={st} status={cls.status[st.id] ?? "pending"} inside={cls.inside.has(st.id)} checked={state.checked.has(st.id)}
          selected={state.selectedId === st.id} hovered={hoveredId === st.id} session={session} onHover={onHover} />
      ))}
    </div>
  );
}

function Row(p: { step: Step; status: StepStatus; inside: boolean; checked: boolean; selected: boolean; hovered: boolean; session: Session; onHover: (id: string | null) => void }) {
  const { step: st, status, session } = p;
  const a = session.actions;
  const i = st.index;
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(st.title);
  const [desc, setDesc] = useState(st.description);

  useEffect(() => {
    if (p.selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.selected]);

  const save = async () => {
    await a.editStep(st.id, { title: title.trim(), description: desc.trim() });
    setEditing(false);
  };

  return (
    <div ref={ref} className={`${s.row} ${s[status]} ${p.selected ? s.selected : ""} ${p.hovered ? s.hovered : ""}`}
      data-testid={`step-row-${i}`} data-status={status} onMouseEnter={() => p.onHover(st.id)} onClick={() => a.select(st.id)}>
      <span className={s.num}>{i}</span>
      {editing ? (
        <div className={s.edit} onClick={(e) => e.stopPropagation()}>
          <input data-testid={`step-edit-title-${i}`} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea data-testid={`step-edit-desc-${i}`} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className={s.editBtns}>
            <button className={s.btnPri} data-testid={`step-edit-save-${i}`} disabled={!title.trim()} onClick={() => void save()}>Save</button>
            <button className={s.btn} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <span className={s.title} title={st.description}>{st.title}</span>
          {st.app && (
            <span className={s.app} data-testid={`step-app-${i}`} title={`Runs in ${st.app.name} (${st.app.bundle_id})`}>
              <AppGlyph />in {st.app.name}
            </span>
          )}
        </>
      )}
      {!editing && (
        <span className={s.acts} onClick={(e) => e.stopPropagation()}>
          {status === "pending" && (
            <button className={s.approve} data-testid={`step-approve-${i}`} onClick={() => a.check(st.id, true, "step_list")}>✓ Approve</button>
          )}
          {status === "approved" && p.checked && !p.inside && (
            <button className={s.link} data-testid={`step-unapprove-${i}`} onClick={() => a.check(st.id, false, "step_list")}>Unapprove</button>
          )}
          {status === "removed" ? (
            <button className={s.link} data-testid={`step-restore-${i}`} onClick={() => a.restore(st.id)}>Undo</button>
          ) : (
            <>
              <button className={s.icon} data-testid={`step-edit-${i}`} aria-label={`Edit step ${i}`}
                onClick={() => { setTitle(st.title); setDesc(st.description); setEditing(true); }}>✎</button>
              <button className={s.icon} data-testid={`step-remove-${i}`} aria-label={`Remove step ${i}`} onClick={() => a.remove(st.id, "step_list")}>⊘</button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** A small app-window mark: the step drives a native app, not the agent's browser. */
function AppGlyph() {
  return (
    <svg className={s.appGlyph} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M0.75 3.25h8.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
