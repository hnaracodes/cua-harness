// What the health pill says and which wizard step fixes it (spec: Error handling).
import type { Health } from "../api/types";
import type { SupervisorStatus } from "../lib/tauri";
import type { SetupStepKey } from "../screens";

export type Tone = "ok" | "warn" | "bad";
export interface HealthView {
  tone: Tone;
  label: string;
  fix: SetupStepKey | null;
  reason: string | null;
}

export function healthView(h: Health | null, reachable: boolean, sup: SupervisorStatus | null): HealthView {
  if (sup?.state === "starting") return { tone: "warn", label: "Starting…", fix: null, reason: sup.last_error };
  if (sup?.state === "restarting") return { tone: "warn", label: "Restarting daemon…", fix: null, reason: sup.last_error };
  if (sup?.state === "failed") return { tone: "bad", label: "Daemon stopped", fix: null, reason: sup.last_error ?? "The daemon won't start." };
  if (!reachable) return { tone: "bad", label: "Reconnecting…", fix: null, reason: "The daemon is not answering." };
  if (!h) return { tone: "warn", label: "Connecting…", fix: null, reason: null };
  if (!h.api_key) return { tone: "warn", label: "Add a model key", fix: "key", reason: "No API key for the selected provider." };
  if (h.plan_only) {
    return { tone: "warn", label: "Plan-only", fix: "driver", reason: "The agent can plan but not run. Finish setup to run tasks." };
  }
  if (!h.fixtures && h.exec_mode === "live" && !h.cua_driver) {
    const detail = h.cua_driver_detail ?? h.status_line;
    const perm = /permission/i.test(detail);
    return { tone: "warn", label: perm ? "Permissions needed" : "Agent driver offline", fix: perm ? "permissions" : "driver", reason: detail };
  }
  return { tone: "ok", label: "Ready", fix: null, reason: null };
}
