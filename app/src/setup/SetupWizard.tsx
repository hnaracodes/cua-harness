import { useCallback, useEffect, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { SetupStatus } from "../api/types";
import type { SetupStepKey } from "../screens";
import { canContinue, canSkipPlanOnly, POLL_STEPS, STEPS, stepIndex, waitingText } from "./gating";
import { DriverStep, KeyStep, PermissionsStep, SelfTestStep, Welcome } from "./steps";
import s from "./Wizard.module.css";

export function SetupWizard({ api, initialStep, onClose }: { api: DaemonApi; initialStep?: SetupStepKey; onClose: () => void }) {
  const [step, setStep] = useState<SetupStepKey>(initialStep ?? "welcome");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await api.setupStatus()); setErr(null); }
    catch (e) { setErr(`Can't reach the daemon: ${e instanceof Error ? e.message : String(e)}`); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Status changes outside the app (System Settings, the driver starting), so poll there.
  useEffect(() => {
    if (!POLL_STEPS.includes(step)) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [step, refresh]);

  const i = stepIndex(step);
  const last = step === "selftest";
  const finish = async (planOnly: boolean) => {
    setBusy(true);
    try {
      if (planOnly) await api.putSettings({ plan_only: true });
      await api.completeSetup();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const props = { api, status, refresh };

  return (
    <div className={s.page} data-testid="setup-wizard">
      <div className={s.card}>
        {status?.complete && <button className={s.close} data-testid="setup-close" aria-label="Close setup" onClick={onClose}>×</button>}
        <ol className={s.strip}>
          {STEPS.map((x, k) => {
            const done = k !== i && canContinue(x.key, status) && x.key !== "welcome" ? true : k < i;
            return (
              <li key={x.key} data-testid={`setup-step-${x.key}`} className={k === i ? s.on : done ? s.done : ""} aria-current={k === i ? "step" : undefined}>
                {done && k !== i ? "✓ " : ""}{x.label}
              </li>
            );
          })}
        </ol>
        {step === "welcome" && <Welcome />}
        {step === "key" && <KeyStep {...props} />}
        {step === "driver" && <DriverStep {...props} />}
        {step === "permissions" && <PermissionsStep {...props} />}
        {step === "selftest" && <SelfTestStep {...props} />}
        <div className={s.footer}>
          <span className={err ? s.err : s.muted} aria-live="polite">{err ?? waitingText(step, status) ?? ""}</span>
          <span className={s.sp} />
          {i > 0 && <button className={`${s.btn} ${s.ghost}`} onClick={() => setStep(STEPS[i - 1].key)}>Back</button>}
          {canSkipPlanOnly(step) && (
            <button className={s.btn} data-testid="setup-skip-plan-only" disabled={busy} onClick={() => void finish(true)}>Skip, plan-only mode</button>
          )}
          {last ? (
            <button className={`${s.btn} ${s.primary}`} data-testid="setup-done" disabled={busy || !canContinue("selftest", status)} onClick={() => void finish(false)}>Done</button>
          ) : (
            <button className={`${s.btn} ${s.primary}`} data-testid="setup-next" disabled={!canContinue(step, status)} onClick={() => setStep(STEPS[i + 1].key)}>Continue</button>
          )}
        </div>
      </div>
    </div>
  );
}
