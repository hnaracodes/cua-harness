// Wave 0 stub. Track U2 replaces this file; keep the exports and data-testids.
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { Counts } from "../state/useSession";
import type { ChatMessage } from "./types";

export interface ChatThreadProps {
  api: DaemonApi;
  messages: ChatMessage[];
  counts: Counts | null;
  meta: string | null;
  events: OversightEvent[];
  steps: Step[];
  onRetryPlan?: () => void;
}

export function ChatThread({ messages, onRetryPlan }: ChatThreadProps) {
  return (
    <div data-testid="chat-thread" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, overflow: "auto" }}>
      {messages.map((m) =>
        m.kind === "user" ? (
          <div key={m.id} data-testid="chat-msg-user">{m.text}</div>
        ) : m.kind === "recap" ? (
          <div key={m.id} data-testid="chat-recap">{m.recap.headline}</div>
        ) : m.kind === "plan_error" ? (
          <div key={m.id} data-testid="chat-plan-error">
            {m.error} {onRetryPlan && <button data-testid="chat-retry" onClick={onRetryPlan}>Try again</button>}
          </div>
        ) : null,
      )}
    </div>
  );
}
