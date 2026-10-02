import { memo } from "react";
import type { Health, PlanProgressPayload } from "../api/types";
import { Icon } from "./Glyph";

export const Header = memo(function Header({
  health,
  mode,
  reachable,
  cost,
}: {
  health: Health | null;
  mode: "live" | "mock" | null;
  reachable: boolean;
  cost: number;
}) {
  const daemonTone = !reachable ? "bad" : mode === "mock" ? "warn" : "ok";
  const keyTone = health?.api_key ? "ok" : "bad";
  return (
    <header className="app-header">
      <h1>Reflexive Oversight - CUA Agent (cua-driver)</h1>
      <div className="status-row" data-testid="status-row">
        <span className={`pill tone-${daemonTone}`} data-testid="pill-daemon" title={mode === "mock" ? "In-browser mock daemon (real daemon unreachable or VITE_MOCK=1)" : "Daemon /health"}>
          <i className="dot" /> Daemon{mode === "mock" ? " (mock)" : ""}
        </span>
        <span className={`pill tone-${keyTone}`} data-testid="pill-api-key">
          <i className="dot" /> API key
        </span>
        <span className="mono model" data-testid="model">
          {health?.model ?? "..."}
        </span>
        <span className="mono cost" data-testid="running-cost" title="Running cost of every LLM call this session">
          ${cost.toFixed(4)}
        </span>
      </div>
      <div className="status-line" data-testid="status-line">
        {health?.status_line ?? (reachable ? "Connecting to daemon..." : "Daemon unreachable.")}
      </div>
    </header>
  );
});

export function Tabs() {
  return (
    <div className="tabs" role="tablist">
      <button className="tab active" role="tab" aria-selected>
        Plan Review
      </button>
      <span title="Impact is cut for the sprint (designed in docs/05)">
        <button className="tab" role="tab" disabled aria-selected={false}>
          Impact
        </button>
      </span>
    </div>
  );
}

export function TaskCard({
  prompt,
  setPrompt,
  editable,
  phase,
  progress,
  error,
  onGenerate,
}: {
  prompt: string;
  setPrompt: (s: string) => void;
  editable: boolean;
  phase: "idle" | "planning" | "review";
  progress: PlanProgressPayload | null;
  error: string | null;
  onGenerate: () => void;
}) {
  return (
    <>
      <div className="card task-card">
        <div className="task-label">
          {Icon.target(12)} Task boundary
        </div>
        {editable ? (
          <textarea
            className="task-input"
            data-testid="task-input"
            value={prompt}
            rows={2}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onGenerate();
            }}
          />
        ) : (
          <div className="task-text" data-testid="task-text">
            {prompt}
          </div>
        )}
        {phase === "idle" && (
          <div className="task-actions">
            <button className="btn btn-primary" data-testid="generate-plan" disabled={!prompt.trim()} onClick={onGenerate}>
              Generate plan
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        )}
      </div>
      {phase === "planning" && <PlanningPanel progress={progress} />}
    </>
  );
}

function PlanningPanel({ progress }: { progress: PlanProgressPayload | null }) {
  const scoring = progress && progress.stage !== "planning";
  return (
    <div className="card planning" data-testid="planning-panel">
      <span className="spinner" />
      <div>
        {scoring ? (
          <>
            <div className="planning-title">Preparing oversight view...</div>
            <div className="muted">Scoring actions and placing them on the grid.</div>
            {progress && progress.total > 0 && (
              <div className="progress-bar" aria-label={`${progress.done} of ${progress.total} scored`}>
                <i style={{ width: `${(100 * progress.done) / progress.total}%` }} />
              </div>
            )}
            {progress && <div className="muted small">{progress.message}</div>}
          </>
        ) : (
          <>
            <div className="planning-title">Planning</div>
            <div className="muted">{progress?.message ?? "Generating a high-level plan for the task."}</div>
          </>
        )}
      </div>
    </div>
  );
}
