// Wave 0 stub. Track U6 replaces this file; keep the exports and data-testids.
import type { DaemonApi } from "../api/client";
import type { SetupStepKey } from "../screens";

export function SetupWizard({ api, onClose }: { api: DaemonApi; initialStep?: SetupStepKey; onClose: () => void }) {
  return (
    <div data-testid="setup-wizard" style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <button data-testid="setup-done" onClick={() => void api.completeSetup().then(onClose)}>Finish setup</button>
    </div>
  );
}
