// Wave 0 stub. Track U5 replaces this file; keep the exports and data-testids.
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { RunInfo } from "../state/session";

export function DeskView(_p: { api: DaemonApi; taskId: string; events: OversightEvent[]; steps: Step[]; run: RunInfo }) {
  return <div data-testid="desk-view">Agent's desk</div>;
}
