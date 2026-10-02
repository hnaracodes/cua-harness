// Wave 0 stub. Track U2 replaces this file; keep the exports and data-testids.
import type { FinalResultPayload } from "../api/types";
import type { ChatInput, ChatMessage } from "./types";

export function eventsToMessages(input: ChatInput): ChatMessage[] {
  const out: ChatMessage[] = [{ kind: "user", id: "user", text: input.prompt, attachments: input.attachments }];
  if (input.planError) out.push({ kind: "plan_error", id: "plan-error", error: input.planError });
  for (const ev of input.events) {
    if (ev.kind !== "final_result") continue;
    const f = ev.payload as unknown as FinalResultPayload;
    out.push({ kind: "recap", id: `recap-${ev.seq}`, recap: { headline: f.message, done: [], skipped: [], source: "fallback" }, final: f, costUsd: 0, actions: 0, durationMs: null });
  }
  return out;
}
