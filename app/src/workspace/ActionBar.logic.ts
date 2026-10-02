// What the review's primary button does and says (track U4). Type-only imports.
import type { Health } from "../api/types";
import type { Counts } from "../state/useSession";

export type PrimaryKind = "approve_all" | "run" | "skip_and_run" | "fix_permissions" | "setup" | "starting";
export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  disabled: boolean;
  testId: "approve-all" | "run-primary";
}

export function primaryAction(
  counts: Counts,
  health: Pick<Health, "cua_driver" | "exec_mode"> | null,
  planOnly: boolean,
  starting = false,
): PrimaryAction {
  const live = counts.approved + counts.pending;
  const run = (kind: PrimaryKind, label: string, disabled = false): PrimaryAction => ({ kind, label, disabled, testId: "run-primary" });
  if (counts.approved === 0) return { kind: "approve_all", label: `Approve all ${live}`, disabled: live === 0, testId: "approve-all" };
  if (planOnly) return run("setup", "Set up the agent to run this");
  if (health && health.exec_mode === "live" && !health.cua_driver) return run("fix_permissions", "Fix permissions to run");
  if (starting) return run("starting", "Starting…", true);
  if (counts.pending === 0) return run("run", "Approve & run");
  return run("skip_and_run", `Run ${counts.approved} approved, skip ${counts.pending}`);
}

export function decisionHint(counts: Counts): string | null {
  if (counts.pending === 0) return null;
  return `${counts.pending} ${counts.pending === 1 ? "step still needs" : "steps still need"} a decision`;
}

export const showSecondaryApproveAll = (counts: Counts): boolean => counts.approved > 0 && counts.pending > 0;
