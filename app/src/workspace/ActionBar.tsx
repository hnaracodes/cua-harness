import type { ScreenProps } from "../screens";
import { decisionHint, primaryAction, showSecondaryApproveAll } from "./ActionBar.logic";
import s from "./ActionBar.module.css";

export function ActionBar({ session, conn, openSetup }: Pick<ScreenProps, "session" | "conn" | "openSetup">) {
  const { state, counts, actions } = session;
  const pa = primaryAction(counts, conn.health, !!conn.health?.plan_only, state.busy === "starting_run");
  const hint = decisionHint(counts);
  const live = counts.approved + counts.pending;
  const err = state.runError;
  const indexes = (ids: string[] = []) => ids.map((id) => state.steps.find((x) => x.id === id)?.index ?? id).join(", ");
  const onPrimary = () => {
    if (pa.kind === "approve_all") actions.approveAll();
    else if (pa.kind === "run") void actions.run();
    else if (pa.kind === "skip_and_run") void actions.skipUndecidedAndRun();
    else if (pa.kind === "fix_permissions") openSetup("permissions");
    else if (pa.kind === "setup") openSetup("driver");
  };
  return (
    <div className={s.bar}>
      {err && (
        <div className={s.error} role="alert" data-testid="run-error">
          <b>{err.status === 409 ? "Nothing ran." : `Run failed (${err.status || "network"}).`}</b> {err.error}
          {err.expected && <span className={s.mono}> expected [{indexes(err.expected)}] got [{indexes(err.got)}]</span>}
        </div>
      )}
      <div className={s.row}>
        {hint && <span className={s.hint} data-testid="decision-hint">{hint}</span>}
        <span className={s.spacer} />
        {showSecondaryApproveAll(counts) && (
          <button className={s.btn} data-testid="approve-all" onClick={actions.approveAll}>Approve all {live}</button>
        )}
        <button className={s.primary} data-testid={pa.testId} disabled={pa.disabled} onClick={onPrimary}>{pa.label}</button>
      </div>
    </div>
  );
}
