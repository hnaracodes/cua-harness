// Wave 0 stub. Track U1 replaces this file; keep the exports and data-testids.
import type { ReactNode } from "react";
import type { ScreenProps } from "../screens";

export function AppShell({ session, children }: ScreenProps & { children: ReactNode }) {
  const { state, actions } = session;
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <nav style={{ width: "var(--rail-w)", borderRight: "1px solid var(--line)" }}>
        <button data-testid="new-task" onClick={actions.newTask}>+</button>
      </nav>
      <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {state.notice && (
          <div data-testid="notice">
            {state.notice} <button data-testid="notice-dismiss" onClick={actions.dismissNotice}>Dismiss</button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
