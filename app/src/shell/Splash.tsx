// Wave 0 stub. Track U1 replaces this file; keep the exports and data-testids.
import type { DaemonConn } from "../state/useDaemon";

export function Splash(_props: { conn: DaemonConn }) {
  return <div data-testid="splash" style={{ display: "grid", placeItems: "center", height: "100%" }}>Starting…</div>;
}
