// Wave 0 stub. Track U2 replaces this file; keep the exports and data-testids.
import type { Attachment, FinalResultPayload, OversightEvent, RunRecapPayload, Step } from "../api/types";

export type ChatMessage =
  | { kind: "user"; id: string; text: string; attachments: Attachment[] }
  | { kind: "planning"; id: string; stage: "planning" | "scoring"; message: string; done: number; total: number }
  | { kind: "plan_ready"; id: string; stepCount: number; revision: number }
  | { kind: "plan_error"; id: string; error: string }
  | { kind: "revised"; id: string; instruction: string | null; changed: number[]; added: number[]; dropped: number }
  | { kind: "run_started"; id: string; approvedIndexes: number[]; skippedIndexes: number[] }
  | { kind: "step_running"; id: string; stepId: string; index: number; title: string }
  | { kind: "step_done"; id: string; stepId: string; index: number; status: "done" | "failed" | "stopped" | "skipped"; summary: string; actions: number | null; durationMs: number | null }
  | { kind: "recap"; id: string; recap: RunRecapPayload; final: FinalResultPayload | null; costUsd: number; actions: number; durationMs: number | null }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string };
export interface ChatInput {
  prompt: string;
  attachments: Attachment[];
  steps: Step[];
  events: OversightEvent[];
  planError: string | null;
}
