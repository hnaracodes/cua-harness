import type { DaemonApi } from "./api/client";
import type { DaemonConn } from "./state/useDaemon";
import type { Session } from "./state/useSession";

export type SetupStepKey = "welcome" | "key" | "driver" | "permissions" | "selftest";

export interface ScreenProps {
  api: DaemonApi;
  conn: DaemonConn;
  session: Session;
  openSetup: (step?: SetupStepKey) => void;
  paperView: boolean;
  setPaperView: (on: boolean) => void;
}
