// app/src/setup/gating.ts. Which wizard step may continue, decided only from GET /setup/status.
import type { PermState, SetupStatus } from "../api/types";
import type { SetupStepKey } from "../screens";

export const STEPS: { key: SetupStepKey; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "key", label: "Model key" },
  { key: "driver", label: "cua-driver" },
  { key: "permissions", label: "Permissions" },
  { key: "selftest", label: "Self-test" },
];
export const POLL_STEPS: SetupStepKey[] = ["driver", "permissions"];
export const stepIndex = (k: SetupStepKey) => STEPS.findIndex((x) => x.key === k);

const permOk = (p: PermState) => p === "granted" || p === "n/a";
export const permsOk = (s: SetupStatus) => permOk(s.permissions.accessibility) && permOk(s.permissions.screen_recording);

export function canContinue(step: SetupStepKey, s: SetupStatus | null): boolean {
  if (step === "welcome") return true;
  if (!s) return false;
  switch (step) {
    case "key": return s.key.present && s.key.tested;
    case "driver": return s.driver.installed && s.driver.running;
    case "permissions": return permsOk(s);
    case "selftest": return s.self_test.passed_at !== null;
  }
}

export const canSkipPlanOnly = (step: SetupStepKey) => stepIndex(step) >= stepIndex("driver");

export function waitingText(step: SetupStepKey, s: SetupStatus | null): string | null {
  if (!s || canContinue(step, s)) return null;
  if (step === "driver") return s.driver.installed ? "Waiting for cua-driver to start…" : "cua-driver is not installed yet.";
  if (step === "permissions") {
    if (!permOk(s.permissions.accessibility)) return "Waiting for Accessibility…";
    return "Waiting for Screen Recording…";
  }
  return null;
}

/** The settings change a wizard finish makes. Skipping turns plan-only on; a full finish
 *  (self-test passed) is the way back out, so it turns plan-only off if it was on. */
export function planOnlyPatch(skip: boolean, s: SetupStatus | null): { plan_only: boolean } | null {
  if (skip) return { plan_only: true };
  return s?.plan_only ? { plan_only: false } : null;
}
