import { useEffect, useState } from "react";
import { setAlwaysOnTop } from "./lib/tauri";
import { HomeScreen } from "./home/HomeScreen";
import { PaperView } from "./paper/PaperView";
import type { ScreenProps, SetupStepKey } from "./screens";
import { SetupWizard } from "./setup/SetupWizard";
import { AppShell } from "./shell/AppShell";
import { Splash } from "./shell/Splash";
import { useDaemon } from "./state/useDaemon";
import { useSession } from "./state/useSession";
import { ReviewScreen } from "./workspace/ReviewScreen";
import { RunScreen } from "./workspace/RunScreen";

export default function App() {
  const conn = useDaemon();
  const session = useSession(conn.api);
  const [paperView, setPaperView] = useState(() => new URLSearchParams(location.search).has("paper"));
  const [setupOpen, setSetupOpen] = useState<{ step?: SetupStepKey } | null>(null);
  const phase = session.state.phase;

  // Float above the agent's desk while it works (Tauri only, guarded).
  useEffect(() => {
    void setAlwaysOnTop(phase === "running");
  }, [phase]);

  if (!conn.api) return <Splash conn={conn} />;
  const needsSetup = conn.health !== null && !conn.health.setup_complete;
  if (setupOpen || needsSetup) {
    return (
      <SetupWizard api={conn.api} initialStep={setupOpen?.step}
        onClose={() => { setSetupOpen(null); void conn.refreshHealth(); }} />
    );
  }
  const props: ScreenProps = {
    api: conn.api, conn, session, paperView, setPaperView,
    openSetup: (step) => setSetupOpen({ step }),
  };
  if (paperView) return <PaperView {...props} />;
  const screen = phase === "home" ? <HomeScreen {...props} /> : phase === "running" || phase === "done" ? <RunScreen {...props} /> : <ReviewScreen {...props} />;
  return <AppShell {...props}>{screen}</AppShell>;
}
