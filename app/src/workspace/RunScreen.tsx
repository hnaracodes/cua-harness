// Wave 0 stub. Track U5 replaces this file; keep the exports and data-testids.
import { useMemo } from "react";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import type { ScreenProps } from "../screens";

export function RunScreen({ api, session }: ScreenProps) {
  const { state, actions } = session;
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: null }),
    [state.prompt, state.attachments, state.steps, state.events],
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatThread api={api} messages={messages} counts={null} meta={null} events={state.events} steps={state.steps} />
      {state.phase === "running" && <button data-testid="composer-stop" onClick={() => void actions.stop()}>Stop</button>}
    </div>
  );
}
