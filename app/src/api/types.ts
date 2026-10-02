// Shapes from the "Sprint contract addendum" in docs/01-architecture.md.
// Keep these byte-for-byte aligned with the daemon.

export type DimensionKey =
  | "authorization_clarity"
  | "delegated_scope"
  | "target_correctness"
  | "reversibility"
  | "financial_commitment"
  | "sensitive_information"
  | "social_reputational_impact"
  | "environment_criticality"
  | "action_uncertainty"
  | "verifiability";

export type Glyph =
  | "search"
  | "compare"
  | "cart"
  | "message"
  | "send"
  | "contacts"
  | "browse"
  | "document"
  | "calendar"
  | "payment"
  | "settings"
  | "generic";

export type StepStatus = "pending" | "approved" | "removed";

export interface Step {
  id: string;
  task_id: string;
  index: number;
  title: string;
  description: string;
  glyph: Glyph | string;
  status: StepStatus;
  edited_from: string | null;
  revision: number;
}

export interface Score {
  step_id: string;
  dimension: DimensionKey | string;
  label: string;
  position: number;
  confidence: number;
  rationale: string;
}

export interface Dimension {
  key: DimensionKey | string;
  name: string;
  definition: string;
  labels: string[];
  anchors: number[];
}

export interface Health {
  daemon: "ok" | string;
  api_key: boolean;
  provider: "anthropic" | "openai" | "fixtures" | string;
  model: string;
  cua_driver: boolean;
  fixtures: boolean;
  exec_mode: "live" | "simulated" | string;
  cost_usd_total: number;
  status_line: string;
  setup_complete: boolean;
  plan_only: boolean;
  cua_driver_detail?: string;
}

export type Point = [number, number];

export interface BoundaryBody {
  x_dim: string;
  y_dim: string;
  polygon: Point[];
}

export interface PlanResponse {
  task_id: string;
  steps: Step[];
  scores: Score[];
  revision?: number;
}

export type DecisionAction = "remove" | "restore" | "check" | "uncheck";

export interface DecisionBody {
  step_id: string;
  action: DecisionAction;
  source: DecisionSource;
}

export interface RunBody {
  approved_step_ids: string[];
  checked_step_ids: string[];
  removed_step_ids: string[];
  boundaries: BoundaryBody[];
}

export type RunResult =
  | { ok: true; run_id: string }
  | { ok: false; status: number; error: string; expected?: string[]; got?: string[] };

export type EventKind =
  | "plan_progress"
  | "cost"
  | "consideration_scored"
  | "step_removed"
  | "step_started"
  | "action"
  | "step_result"
  | "final_result"
  | "boundary_candidate"
  | "plan_revised"
  | "frame"
  | "run_recap";

export const EVENT_KINDS: EventKind[] = [
  "plan_progress",
  "cost",
  "consideration_scored",
  "step_removed",
  "step_started",
  "action",
  "step_result",
  "final_result",
  "boundary_candidate",
  "plan_revised",
  "frame",
  "run_recap",
];

export interface PlanProgressPayload {
  stage: "planning" | "scoring" | "done" | "error";
  message: string;
  done: number;
  total: number;
}
export interface CostPayload {
  scope: "plan" | "score" | "run" | "recap" | "revise" | "setup";
  model: string;
  usd_delta: number;
  usd_total: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
}
export interface ConsiderationScoredPayload {
  step_count: number;
  dimension_count: number;
  approved_count: number;
}
export interface StepRefPayload {
  step_id: string;
  index: number;
  title: string;
}
export interface ActionPayload {
  step_id: string;
  n: number;
  mode: "ax" | "pixel" | "sim";
  verb: string;
  target: string;
  detail: string;
  ok: boolean;
  error: string | null;
}
export interface StepResultPayload {
  step_id: string;
  index: number;
  status: "done" | "failed" | "stopped" | "skipped";
  summary: string;
  actions?: number;
  duration_ms?: number;
}
export interface FinalResultPayload {
  status: "completed" | "stopped" | "failed" | "capped";
  message: string;
  attempted: string[];
  completed: string[];
}

export interface OversightEvent<P = Record<string, unknown>> {
  kind: EventKind;
  task_id: string;
  run_id: string | null;
  seq: number;
  ts: string;
  payload: P;
}

export type Provider = "anthropic" | "openai";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface Attachment {
  attachment_id: string;
  mime: ImageMime;
  bytes: number;
}

export interface TaskSummary {
  id: string;
  prompt: string;
  created_at: string;
  step_count: number;
}

export interface RunRecord {
  id: string;
  task_id: string;
  status: string; // "running" | "completed" | "stopped" | "failed" | "capped"
  exec_mode: string;
  approved: string[];
  removed: string[];
  started_at: string;
  finished_at: string | null;
  final: FinalResultPayload | null;
}

export interface TaskDetail {
  task: {
    id: string;
    prompt: string;
    selected_app: string | null;
    created_at: string;
    mode: string;
    attachments: Attachment[];
  };
  steps: Step[];
  scores: Score[];
  boundaries: { x_dim: string; y_dim: string; polygon: Point[] }[];
  runs: RunRecord[];
  cost_usd: number;
}

export type PermState = "granted" | "denied" | "unknown" | "n/a";

export interface SetupStatus {
  platform: "macos" | "windows" | "linux";
  key: { provider: Provider; present: boolean; source: "keychain" | "env" | "none"; tested: boolean; warning: string | null };
  driver: { installed: boolean; version: string | null; running: boolean };
  permissions: { accessibility: PermState; screen_recording: PermState };
  self_test: { passed_at: string | null };
  plan_only: boolean;
  complete: boolean;
}

export interface AppSettings {
  provider: Provider;
  model: string;
  plan_only: boolean;
  models: Record<Provider, string[]>;
}

export interface PlanRevisedPayload {
  revision: number;
  instruction: string | null;
  changed_step_ids: string[];
  added_step_ids: string[];
  dropped_step_ids: string[];
}

export interface FramePayload {
  step_id: string;
  seq: number; // frame number within the task, 1-based, monotonic
}

export interface RunRecapPayload {
  headline: string;
  done: { step_id: string; text: string }[];
  skipped: { step_id: string; reason: string }[];
  source: "llm" | "fallback";
}

export type DecisionSource = "step_list" | "grid" | "fan_out" | "skip_undecided" | "plan_panel";
