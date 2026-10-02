# Track U2: Chat (event stream → chat messages, ChatThread UI)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8) and Ownership matrix first. **Batch A.** Runs after Wave 0 is merged. E2E port **1432**.
>
> Spec: Screens §2 (chat column) and §3 (Running: chat column). Mockups: `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/3-review-workspace.html` (chat column) and `4-home-run-setup.html` (section 2, "Running").

**Owns:** `app/src/chat/**` except `chat/types.ts`, which is frozen (W0-3 wrote it verbatim from C6). Also `app/tests/chat.test.mts`, `app/tests/format-event.test.mts`, `app/e2e/chat.spec.ts`.

**Goal:** A pure, deterministic `eventsToMessages()` that turns a task's stored event stream into chat messages. A replayed task therefore renders exactly what the live run rendered. On top of it, a `ChatThread` that reads like an AI chat: a user bubble, a plan message with live counts, ✓/✗ step rows, a spinner line, and a recap card with a collapsible Details log.

**Mapping rules (normative for this track):**

| Event (in seq order) | Message |
|---|---|
| (always first) | `user` `{id:"user"}`, the prompt and attachments |
| `plan_progress` stage `planning` / `scoring`, `run_id` null | **one** `planning` message per planning session (id from the first seq of the session), updated in place. **Removed** once a `done` or `error` arrives. |
| `plan_progress` stage `done` | `plan_ready` `{id:"plan-<seq>", stepCount: payload.total, revision: 0}`, **only for the first** `done` of the task. Revisions are shown by `revised` messages instead. |
| `plan_progress` stage `error` | `plan_error` `{id:"plan-error-<seq>"}` |
| `plan_revised` | if `instruction` is set: `user` `{id:"user-<seq>"}` with the instruction. Then `revised` `{id:"revised-<seq>"}`, with ids mapped to step indexes through `input.steps`. Unknown ids are ignored for `changed`/`added`; `dropped` is a count. |
| first event of a run (`run_id` set) | `run_started` `{id:"run-<seq>"}`. `skippedIndexes` comes from that run's `step_removed`. `approvedIndexes` is every other step in `input.steps`. Both are sorted. |
| `step_started` | `step_running` `{id:"running-<seq>"}`, removed when that step's `step_result` (or the run's `final_result`) arrives |
| `step_result` | `step_done` `{id:"step-<seq>"}`. `actions` and `durationMs` are `null` when the payload lacks them (legacy). |
| `step_result` with status `failed` | additionally a `notice` `{id:"notice-<seq>", tone:"warn"}` |
| `action` / `cost` (run) | counted into the run's recap (`actions` count, `costUsd` sum of `usd_delta`) |
| `run_recap` | stored. Used by the run's `final_result`. |
| `final_result` | `recap` `{id:"recap-<seq>"}`. Uses the stored `run_recap`, or a **fallback recap** built from that run's `step_result` / `step_removed` when none exists (legacy streams). `durationMs` = final ts − first run event ts. |
| `input.planError` non-null and the last `plan_progress` stage is not `error` | `plan_error` `{id:"plan-error"}` at the end |

---

## Task U2-1: `eventsToMessages` and the Details formatter (pure)

**Files:**
- Modify: `app/src/chat/eventsToMessages.ts` (replace the Wave 0 stub)
- Create: `app/src/chat/formatEvent.ts`
- Test: `app/tests/chat.test.mts`, `app/tests/format-event.test.mts`

**Interfaces:**
- Consumes: `ChatInput`, `ChatMessage` (`chat/types.ts`, C6, frozen), and the payload types from C1 / `api/types.ts` (`PlanProgressPayload`, `PlanRevisedPayload`, `StepRefPayload`, `StepResultPayload`, `CostPayload`, `RunRecapPayload`, `FinalResultPayload`, `ActionPayload`, `FramePayload`).
- Produces: `export function eventsToMessages(input: ChatInput): ChatMessage[]` (C6), `export function fallbackRecap(final: FinalResultPayload, results: StepResultPayload[], removed: StepRefPayload[]): RunRecapPayload`, and `export function formatEvent(ev: OversightEvent): string`. U4 and U5 import `eventsToMessages`. Fallback headlines (exact): `completed` → `Done. Here's what happened`, `stopped` → `Stopped. Here's what got done`, `failed` → `The run hit a problem`, `capped` → `Stopped at the action limit`. A fallback skip reason for a step left out before the run is `You left this step out.`

- [ ] **Step 1: Write the failing tests**

Create `app/tests/chat.test.mts`:

```ts
// Run: npm test. Pure mapping from the event stream to chat messages (track U2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsToMessages } from "../src/chat/eventsToMessages.ts";
import type { OversightEvent, Step } from "../src/api/types.ts";
import type { ChatMessage } from "../src/chat/types.ts";

const steps: Step[] = [1, 2, 3].map((i) => ({
  id: `s${i}`, task_id: "t", index: i, title: `Step ${i}`, description: "d", glyph: "generic",
  status: "pending", edited_from: null, revision: 0,
}));
const T0 = Date.parse("2026-10-02T10:00:00Z");

function stream() {
  let seq = 0;
  return (kind: OversightEvent["kind"], payload: object, run_id: string | null = null): OversightEvent => {
    seq += 1;
    return { kind, task_id: "t", run_id, seq, ts: new Date(T0 + seq * 1000).toISOString(), payload: payload as Record<string, unknown> };
  };
}

function planEvents(ev: ReturnType<typeof stream>): OversightEvent[] {
  return [
    ev("plan_progress", { stage: "planning", message: "Generating plan.", done: 0, total: 0 }),
    ev("cost", { scope: "plan", model: "m", usd_delta: 0.01, usd_total: 0.01, latency_ms: 1, input_tokens: 1, output_tokens: 1 }),
    ev("plan_progress", { stage: "scoring", message: "Scoring.", done: 0, total: 3 }),
    ev("plan_progress", { stage: "scoring", message: "Scored step 3.", done: 3, total: 3 }),
    ev("plan_progress", { stage: "done", message: "3 steps scored.", done: 3, total: 3 }),
  ];
}

function runEvents(ev: ReturnType<typeof stream>, withRecap: boolean, legacy = false): OversightEvent[] {
  const r = "r1";
  const res = (id: string, index: number, status: string, summary: string, actions: number, ms: number) =>
    ev("step_result", legacy ? { step_id: id, index, status, summary } : { step_id: id, index, status, summary, actions, duration_ms: ms }, r);
  const out = [
    ev("consideration_scored", { step_count: 3, dimension_count: 10, approved_count: 2 }, r),
    ev("step_removed", { step_id: "s3", index: 3, title: "Step 3" }, r),
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }, r),
    ev("action", { step_id: "s1", n: 1, mode: "sim", verb: "type", target: "search", detail: "", ok: true, error: null }, r),
    ev("action", { step_id: "s1", n: 2, mode: "sim", verb: "click", target: "go", detail: "", ok: true, error: null }, r),
    ev("cost", { scope: "run", model: "m", usd_delta: 0.02, usd_total: 0.03, latency_ms: 1, input_tokens: 1, output_tokens: 1 }, r),
    res("s1", 1, "done", "Found 4 rackets under $100.", 2, 1500),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }, r),
    ev("action", { step_id: "s2", n: 3, mode: "sim", verb: "click", target: "racket", detail: "", ok: true, error: null }, r),
  ];
  if (legacy) {
    out.push(ev("step_result", { step_id: "s2", index: 2, status: "stopped", summary: "Stopped by the user." }, r));
    out.push(ev("final_result", { status: "stopped", message: "Stopped by the user.", attempted: ["s1", "s2"], completed: ["s1"] }, r));
    return out;
  }
  out.push(res("s2", 2, "done", "Picked the Head Ti.S6 ($64).", 1, 800));
  if (withRecap)
    out.push(ev("run_recap", { headline: "Done. Here's what happened", done: [{ step_id: "s1", text: "Found it." }], skipped: [{ step_id: "s3", reason: "You left it out." }], source: "llm" }, r));
  out.push(ev("final_result", { status: "completed", message: "All approved steps were attempted.", attempted: ["s1", "s2"], completed: ["s1", "s2"] }, r));
  return out;
}

const kinds = (m: ChatMessage[]) => m.map((x) => x.kind);
const input = (events: OversightEvent[], planError: string | null = null) => ({ prompt: "Find a racket", attachments: [], steps, events, planError });

test("planning line shows only while planning is in progress", () => {
  const ev = stream();
  const plan = planEvents(ev);
  assert.deepEqual(kinds(eventsToMessages(input(plan.slice(0, 3)))), ["user", "planning"]);
  const mid = eventsToMessages(input(plan.slice(0, 4)));
  const line = mid[1] as Extract<ChatMessage, { kind: "planning" }>;
  assert.equal(line.id, "planning-1");
  assert.equal(line.done, 3);
  const full = eventsToMessages(input(plan));
  assert.deepEqual(kinds(full), ["user", "plan_ready"]);
  assert.deepEqual(full[1], { kind: "plan_ready", id: "plan-5", stepCount: 3, revision: 0 });
});

test("live run maps in order with a stored recap", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m), ["user", "plan_ready", "run_started", "step_done", "step_done", "recap"]);
  const started = m[2] as Extract<ChatMessage, { kind: "run_started" }>;
  assert.deepEqual([started.approvedIndexes, started.skippedIndexes], [[1, 2], [3]]);
  const s1 = m[3] as Extract<ChatMessage, { kind: "step_done" }>;
  assert.deepEqual([s1.index, s1.status, s1.actions, s1.durationMs], [1, "done", 2, 1500]);
  const recap = m[5] as Extract<ChatMessage, { kind: "recap" }>;
  assert.equal(recap.recap.source, "llm");
  assert.equal(recap.actions, 3);
  assert.equal(recap.costUsd, 0.02);
  assert.equal(recap.final?.status, "completed");
  assert.equal(recap.durationMs, (all[all.length - 1].seq - all[5].seq) * 1000);
});

test("a step in progress shows a running line until its result", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const upToS1Action = all.slice(0, all.findIndex((e) => e.kind === "action") + 1);
  const m = eventsToMessages(input(upToS1Action));
  const last = m[m.length - 1] as Extract<ChatMessage, { kind: "step_running" }>;
  assert.equal(last.kind, "step_running");
  assert.equal(last.index, 1);
  assert.ok(!eventsToMessages(input(all)).some((x) => x.kind === "step_running"));
});

test("replay is identical and ids are stable while the stream grows", () => {
  const ev = stream();
  const all = [...planEvents(ev), ...runEvents(ev, true)];
  const full = eventsToMessages(input(all));
  assert.deepEqual(eventsToMessages(input(all)), full);
  const fullIds = new Set(full.map((x) => x.id));
  for (let k = 1; k <= all.length; k++) {
    for (const msg of eventsToMessages(input(all.slice(0, k)))) {
      if (msg.kind === "planning" || msg.kind === "step_running") continue;
      assert.ok(fullIds.has(msg.id), `prefix ${k} produced ${msg.id} which the full stream does not have`);
    }
  }
});

test("revise: the instruction becomes a user message and no second plan_ready appears", () => {
  const ev = stream();
  const all = [
    ...planEvents(ev),
    ev("plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: 3 }),
    ev("plan_revised", { revision: 1, instruction: "Only message the party group", changed_step_ids: ["s2"], added_step_ids: ["s9"], dropped_step_ids: ["s0"] }),
    ev("plan_progress", { stage: "done", message: "Plan revised.", done: 3, total: 3 }),
  ];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m), ["user", "plan_ready", "user", "revised"]);
  assert.equal((m[2] as Extract<ChatMessage, { kind: "user" }>).text, "Only message the party group");
  assert.deepEqual(m[3], { kind: "revised", id: "revised-7", instruction: "Only message the party group", changed: [2], added: [], dropped: 1 });
});

test("eventsToMessages: legacy stream (no run_recap, no actions/duration_ms) synthesizes a fallback recap", () => {
  const ev = stream();
  const m = eventsToMessages(input([...planEvents(ev), ...runEvents(ev, false, true)]));
  const done = m.filter((x) => x.kind === "step_done") as Extract<ChatMessage, { kind: "step_done" }>[];
  assert.deepEqual(done.map((d) => [d.index, d.status, d.actions, d.durationMs]), [[1, "done", null, null], [2, "stopped", null, null]]);
  const recap = m[m.length - 1] as Extract<ChatMessage, { kind: "recap" }>;
  assert.equal(recap.kind, "recap");
  assert.equal(recap.recap.source, "fallback");
  assert.equal(recap.recap.headline, "Stopped. Here's what got done");
  assert.deepEqual(recap.recap.done, [{ step_id: "s1", text: "Found 4 rackets under $100." }]);
  assert.deepEqual(recap.recap.skipped, [
    { step_id: "s3", reason: "You left this step out." },
    { step_id: "s2", reason: "Stopped by the user." },
  ]);
});

test("a failed step adds a warning notice", () => {
  const ev = stream();
  const all = [
    ...planEvents(ev),
    ev("consideration_scored", { step_count: 3, dimension_count: 10, approved_count: 3 }, "r1"),
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }, "r1"),
    ev("step_result", { step_id: "s1", index: 1, status: "failed", summary: "Login wall." }, "r1"),
    ev("final_result", { status: "failed", message: "A step failed.", attempted: ["s1"], completed: [] }, "r1"),
  ];
  const m = eventsToMessages(input(all));
  assert.deepEqual(kinds(m).slice(-3), ["step_done", "notice", "recap"]);
  assert.equal((m[m.length - 2] as Extract<ChatMessage, { kind: "notice" }>).tone, "warn");
});

test("planError from the session shows once, and not on top of a streamed error", () => {
  const ev = stream();
  const started = [ev("plan_progress", { stage: "planning", message: "Generating plan.", done: 0, total: 0 })];
  assert.deepEqual(kinds(eventsToMessages(input(started, "Planning failed: 502"))), ["user", "planning", "plan_error"]);
  const streamed = [...started, ev("plan_progress", { stage: "error", message: "model refused", done: 0, total: 0 })];
  const m = eventsToMessages(input(streamed, "Planning failed: 502"));
  assert.deepEqual(kinds(m), ["user", "plan_error"]);
  assert.equal((m[1] as Extract<ChatMessage, { kind: "plan_error" }>).error, "model refused");
});
```

Create `app/tests/format-event.test.mts`:

```ts
// Run: npm test. One-line Details log entries for the recap card (track U2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEvent } from "../src/chat/formatEvent.ts";
import type { OversightEvent } from "../src/api/types.ts";

const e = (kind: OversightEvent["kind"], payload: object): OversightEvent => ({
  kind, task_id: "t", run_id: "r", seq: 1, ts: "2026-10-02T10:11:12.345Z", payload: payload as Record<string, unknown>,
});

test("formats the event kinds the log shows", () => {
  assert.equal(formatEvent(e("step_started", { step_id: "s1", index: 1, title: "Search" })), "10:11:12  ▸ step 1 started: Search");
  assert.equal(formatEvent(e("action", { step_id: "s1", n: 1, mode: "ax", verb: "click", target: "Go", detail: "", ok: false, error: "gone" })), "10:11:12      ✗ ax click Go (gone)");
  assert.equal(formatEvent(e("step_result", { step_id: "s1", index: 1, status: "done", summary: "Found 4." })), "10:11:12  ■ step 1 done: Found 4.");
  assert.equal(formatEvent(e("cost", { scope: "run", model: "claude-opus-5-5", usd_delta: 0.0123, usd_total: 1, latency_ms: 820, input_tokens: 1, output_tokens: 1 })), "10:11:12      $0.0123 claude-opus-5-5 820 ms");
  assert.equal(formatEvent(e("frame", { step_id: "s1", seq: 7 })), "10:11:12      frame 7");
  assert.equal(formatEvent(e("final_result", {})), "10:11:12  final_result");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && npm test`
Expected: FAIL. `chat.test.mts` fails on the planning-line test (the stub has no `planning` message), and `format-event.test.mts` fails with `Cannot find module '../src/chat/formatEvent.ts'`.

- [ ] **Step 3: Implement `eventsToMessages`**

Replace `app/src/chat/eventsToMessages.ts` entirely:

```ts
// Pure mapping from a task's stored event stream to chat messages (track U2).
// A replay feeds the same events, so a replayed task renders exactly what the live
// run rendered. Ids derive from event seq, so they are stable as the stream grows.
// Type-only imports: node --test runs this file directly.
import type {
  CostPayload,
  FinalResultPayload,
  OversightEvent,
  PlanProgressPayload,
  PlanRevisedPayload,
  RunRecapPayload,
  StepRefPayload,
  StepResultPayload,
} from "../api/types";
import type { ChatInput, ChatMessage } from "./types";

type Msg<K extends ChatMessage["kind"]> = Extract<ChatMessage, { kind: K }>;

interface RunAcc {
  startTs: string;
  started: Msg<"run_started">;
  skipped: Set<string>;
  removed: StepRefPayload[];
  results: StepResultPayload[];
  running: Map<string, Msg<"step_running">>;
  costUsd: number;
  actions: number;
  recap: RunRecapPayload | null;
}

const HEADLINE: Record<string, string> = {
  completed: "Done. Here's what happened",
  stopped: "Stopped. Here's what got done",
  failed: "The run hit a problem",
  capped: "Stopped at the action limit",
};

/** Recap for runs with no `run_recap` event (legacy streams, or a daemon whose recap call failed). */
export function fallbackRecap(final: FinalResultPayload, results: StepResultPayload[], removed: StepRefPayload[]): RunRecapPayload {
  return {
    headline: HEADLINE[final.status] ?? final.message,
    done: results.filter((r) => r.status === "done").map((r) => ({ step_id: r.step_id, text: r.summary })),
    skipped: [
      ...removed.map((r) => ({ step_id: r.step_id, reason: "You left this step out." })),
      ...results.filter((r) => r.status !== "done").map((r) => ({ step_id: r.step_id, reason: r.summary })),
    ],
    source: "fallback",
  };
}

export function eventsToMessages(input: ChatInput): ChatMessage[] {
  const indexOf = new Map(input.steps.map((s) => [s.id, s.index]));
  const toIndexes = (ids: string[]) =>
    ids.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);

  const out: ChatMessage[] = [{ kind: "user", id: "user", text: input.prompt, attachments: input.attachments }];
  const drop = (m: ChatMessage) => {
    const i = out.indexOf(m);
    if (i >= 0) out.splice(i, 1);
  };

  let planning: Msg<"planning"> | null = null;
  let planned = false;
  let lastStage: PlanProgressPayload["stage"] | null = null;
  const runs = new Map<string, RunAcc>();

  const runFor = (ev: OversightEvent): RunAcc => {
    const id = ev.run_id as string;
    let r = runs.get(id);
    if (!r) {
      const started: Msg<"run_started"> = { kind: "run_started", id: `run-${ev.seq}`, approvedIndexes: [], skippedIndexes: [] };
      out.push(started);
      r = { startTs: ev.ts, started, skipped: new Set(), removed: [], results: [], running: new Map(), costUsd: 0, actions: 0, recap: null };
      runs.set(id, r);
    }
    return r;
  };

  for (const ev of input.events) {
    const p = ev.payload as unknown;

    if (ev.run_id === null) {
      if (ev.kind === "plan_progress") {
        const pp = p as PlanProgressPayload;
        lastStage = pp.stage;
        if (pp.stage === "planning" || pp.stage === "scoring") {
          if (planning) Object.assign(planning, { stage: pp.stage, message: pp.message, done: pp.done, total: pp.total });
          else {
            planning = { kind: "planning", id: `planning-${ev.seq}`, stage: pp.stage, message: pp.message, done: pp.done, total: pp.total };
            out.push(planning);
          }
        } else {
          if (planning) drop(planning);
          planning = null;
          if (pp.stage === "done" && !planned) {
            planned = true;
            out.push({ kind: "plan_ready", id: `plan-${ev.seq}`, stepCount: pp.total, revision: 0 });
          }
          if (pp.stage === "error") out.push({ kind: "plan_error", id: `plan-error-${ev.seq}`, error: pp.message });
        }
      } else if (ev.kind === "plan_revised") {
        const rv = p as PlanRevisedPayload;
        if (rv.instruction) out.push({ kind: "user", id: `user-${ev.seq}`, text: rv.instruction, attachments: [] });
        out.push({
          kind: "revised",
          id: `revised-${ev.seq}`,
          instruction: rv.instruction,
          changed: toIndexes(rv.changed_step_ids),
          added: toIndexes(rv.added_step_ids),
          dropped: rv.dropped_step_ids.length,
        });
      }
      continue;
    }

    const r = runFor(ev);
    switch (ev.kind) {
      case "step_removed": {
        const sr = p as StepRefPayload;
        r.skipped.add(sr.step_id);
        r.removed.push(sr);
        break;
      }
      case "step_started": {
        const sr = p as StepRefPayload;
        const m: Msg<"step_running"> = { kind: "step_running", id: `running-${ev.seq}`, stepId: sr.step_id, index: sr.index, title: sr.title };
        r.running.set(sr.step_id, m);
        out.push(m);
        break;
      }
      case "action":
        r.actions += 1;
        break;
      case "cost":
        r.costUsd += (p as CostPayload).usd_delta || 0;
        break;
      case "step_result": {
        const res = p as StepResultPayload;
        const running = r.running.get(res.step_id);
        if (running) drop(running);
        r.running.delete(res.step_id);
        r.results.push(res);
        out.push({
          kind: "step_done",
          id: `step-${ev.seq}`,
          stepId: res.step_id,
          index: res.index,
          status: res.status,
          summary: res.summary,
          actions: res.actions ?? null,
          durationMs: res.duration_ms ?? null,
        });
        if (res.status === "failed")
          out.push({ kind: "notice", id: `notice-${ev.seq}`, tone: "warn", text: `Step ${res.index} failed, so the steps after it did not run.` });
        break;
      }
      case "run_recap":
        r.recap = p as RunRecapPayload;
        break;
      case "final_result": {
        const f = p as FinalResultPayload;
        r.running.forEach(drop);
        r.running.clear();
        const ms = Date.parse(ev.ts) - Date.parse(r.startTs);
        out.push({
          kind: "recap",
          id: `recap-${ev.seq}`,
          recap: r.recap ?? fallbackRecap(f, r.results, r.removed),
          final: f,
          costUsd: Math.round(r.costUsd * 1e6) / 1e6,
          actions: r.actions,
          durationMs: Number.isFinite(ms) ? ms : null,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const r of runs.values()) {
    r.started.skippedIndexes = r.removed.map((x) => x.index).sort((a, b) => a - b);
    r.started.approvedIndexes = input.steps.filter((s) => !r.skipped.has(s.id)).map((s) => s.index).sort((a, b) => a - b);
  }

  if (input.planError && lastStage !== "error") out.push({ kind: "plan_error", id: "plan-error", error: input.planError });
  return out;
}
```

- [ ] **Step 4: Implement `formatEvent`**

Create `app/src/chat/formatEvent.ts`:

```ts
// One line per event for the recap's Details log (track U2). Type-only imports.
import type { ActionPayload, CostPayload, FramePayload, OversightEvent, StepRefPayload, StepResultPayload } from "../api/types";

export function formatEvent(ev: OversightEvent): string {
  const t = ev.ts.slice(11, 19);
  const p = ev.payload as unknown;
  switch (ev.kind) {
    case "step_started": {
      const s = p as StepRefPayload;
      return `${t}  ▸ step ${s.index} started: ${s.title}`;
    }
    case "action": {
      const a = p as ActionPayload;
      return `${t}      ${a.ok ? "✓" : "✗"} ${a.mode} ${a.verb} ${a.target}${a.error ? ` (${a.error})` : ""}`;
    }
    case "step_result": {
      const r = p as StepResultPayload;
      return `${t}  ■ step ${r.index} ${r.status}: ${r.summary}`;
    }
    case "cost": {
      const c = p as CostPayload;
      return `${t}      $${c.usd_delta.toFixed(4)} ${c.model} ${c.latency_ms} ms`;
    }
    case "frame":
      return `${t}      frame ${(p as FramePayload).seq}`;
    default:
      return `${t}  ${ev.kind}`;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npm run typecheck && npm test`
Expected: typecheck clean. All tests pass, including the 8 in `chat.test.mts` and the 1 in `format-event.test.mts`.

- [ ] **Step 6: Commit**

```bash
git add app/src/chat/eventsToMessages.ts app/src/chat/formatEvent.ts app/tests/chat.test.mts app/tests/format-event.test.mts
git commit -m "chat: eventsToMessages full mapping, fallback recap, details formatter" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task U2-2: `ChatThread` UI

**Files:**
- Modify: `app/src/chat/ChatThread.tsx` (replace the Wave 0 stub)
- Create: `app/src/chat/ChatThread.module.css`
- Test: `app/e2e/chat.spec.ts`

**Interfaces:**
- Consumes: `ChatThreadProps` (C6, exact), `ChatMessage`, `Counts` (`state/useSession`), `DaemonApi.attachmentUrl`, `formatEvent`.
- Produces: `export function ChatThread(props: ChatThreadProps)` and `export interface ChatThreadProps`, both unchanged from C6. Test ids (C8): `chat-thread`, `chat-msg-user`, `chat-plan-ready`, `chat-plan-error`, `chat-retry`, `chat-revised`, `chat-msg-step`, `chat-step-running`, `chat-recap`, `chat-recap-details`. Extra ids this track adds (not contract, but U4 and U5 tests use them): `chat-planning`, `chat-run-started`, `chat-recap-log`, `chat-notice`.
- Exact copy that other tracks' tests rely on:
  - The `run_started` line: `Plan approved: steps {a, b} · skipped {c, d}`. The `· skipped …` part is omitted when nothing was skipped.
  - Step row meta: `step {i} · {K} actions · {T}s`. Parts are omitted when null.
  - Chips: `{n} approved`, `{n} need a decision`, `{n} removed`.

- [ ] **Step 1: Write the failing e2e test**

Create `app/e2e/chat.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// Run: E2E_PORT=1432 npx playwright test e2e/chat.spec.ts
async function toReview(page: Page, prompt = "Find a tennis racket under $100") {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
}

test("the user's prompt and the plan message with live counts", async ({ page }) => {
  await toReview(page);
  await expect(page.getByTestId("chat-msg-user").first()).toContainText("Find a tennis racket under $100");
  const plan = page.getByTestId("chat-plan-ready");
  await expect(plan).toContainText("6 steps");
  await expect(plan).toContainText("0 approved");
  await expect(plan).toContainText("6 need a decision");
  await page.getByTestId("approve-all").click();
  await expect(plan).toContainText("6 approved");
  await expect(plan).toContainText("0 need a decision");
});

test("a run narrates step rows in order and ends in a recap with a Details log", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-run-started")).toContainText("Plan approved: steps 1, 2, 3, 4, 5, 6");
  const recap = page.getByTestId("chat-recap");
  await expect(recap).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId("chat-msg-step");
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(rows.nth(i)).toContainText(`step ${i + 1}`);
  await expect(page.getByTestId("chat-step-running")).toHaveCount(0);
  await expect(recap).toBeInViewport();
  await expect(page.getByTestId("chat-recap-log")).toHaveCount(0);
  await page.getByTestId("chat-recap-details").click();
  await expect(page.getByTestId("chat-recap-log")).toContainText("step 1 started");
});
```

Run: `cd app && E2E_PORT=1432 npx playwright test e2e/chat.spec.ts`
Expected: FAIL. The stub `ChatThread` has no `chat-plan-ready` or `chat-run-started`.

- [ ] **Step 2: Write the styles**

Create `app/src/chat/ChatThread.module.css`:

```css
.thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  scroll-behavior: smooth;
}
.user {
  align-self: flex-end;
  max-width: 88%;
  background: var(--raised);
  border-radius: 14px 14px 4px 14px;
  padding: 9px 12px;
  line-height: 1.4;
  white-space: pre-wrap;
}
.thumbs {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.thumb {
  width: 56px;
  height: 42px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
}
.assistant {
  line-height: 1.5;
  color: var(--text);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  padding: 3px 9px;
  font-size: var(--fs-xs);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ok {
  background: var(--ok);
}
.pend {
  background: var(--pend);
}
.rm {
  background: var(--rm);
}
.meta {
  color: var(--text-3);
  font-size: var(--fs-xs);
  margin-top: 6px;
}
.muted {
  color: var(--text-3);
  font-size: var(--fs-sm);
}
.progress {
  display: flex;
  gap: 9px;
  align-items: center;
  color: var(--text-2);
}
.spinner {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.step {
  display: flex;
  gap: 9px;
  line-height: 1.45;
}
.mark {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 1px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--accent-ink);
}
.markDone {
  background: var(--ok);
}
.markFailed {
  background: var(--rm);
}
.markOther {
  background: var(--raised);
  color: var(--text-2);
}
.error {
  border: 1px solid var(--rm);
  background: var(--rm-soft);
  border-radius: var(--r-md);
  padding: 10px 12px;
}
.notice {
  border-radius: var(--r-md);
  padding: 8px 12px;
  font-size: var(--fs-sm);
  background: var(--raised);
}
.warn {
  background: var(--pend-soft);
}
.recap {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: var(--r-md);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.recap h4 {
  margin: 0;
  font-size: var(--fs-md);
}
.li {
  display: flex;
  gap: 7px;
}
.liDone {
  color: var(--ok);
}
.liSkip {
  color: var(--text-3);
}
.details {
  border-top: 1px solid var(--line);
  padding-top: 7px;
  color: var(--text-3);
  font-size: var(--fs-sm);
}
.linkBtn {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-2);
  cursor: pointer;
}
.linkBtn:hover {
  color: var(--text);
}
.btn {
  margin-left: 8px;
  border: 1px solid var(--line);
  background: var(--raised);
  border-radius: var(--r-pill);
  padding: 4px 11px;
  cursor: pointer;
}
.log {
  margin: 6px 0 0;
  max-height: 220px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  color: var(--text-2);
}
```

- [ ] **Step 3: Implement `ChatThread`**

Replace `app/src/chat/ChatThread.tsx` entirely:

```tsx
// The chat column (track U2): reads like an AI chat, never like a log. The full log
// lives only behind the recap card's Details.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { Counts } from "../state/useSession";
import s from "./ChatThread.module.css";
import { formatEvent } from "./formatEvent";
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

type Msg<K extends ChatMessage["kind"]> = Extract<ChatMessage, { kind: K }>;

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const list = (xs: number[]) => xs.join(", ");

export function ChatThread({ api, messages, counts, meta, events, steps, onRetryPlan }: ChatThreadProps) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new messages unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  let lastPlan = -1;
  messages.forEach((m, i) => {
    if (m.kind === "plan_ready") lastPlan = i;
  });
  const indexOf = useMemo(() => new Map(steps.map((x) => [x.id, x.index])), [steps]);

  return (
    <div
      ref={box}
      className={s.thread}
      data-testid="chat-thread"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {messages.map((m, i) => {
        switch (m.kind) {
          case "user":
            return <UserBubble key={m.id} m={m} api={api} />;
          case "planning":
            return (
              <div key={m.id} className={s.progress} data-testid="chat-planning">
                <span className={s.spinner} />
                {m.stage === "planning" ? "Planning the steps…" : `Scoring actions and placing them on the grid (${m.done}/${m.total})…`}
              </div>
            );
          case "plan_ready":
            return <PlanReady key={m.id} m={m} counts={i === lastPlan ? counts : null} meta={i === lastPlan ? meta : null} />;
          case "plan_error":
            return (
              <div key={m.id} className={s.error} data-testid="chat-plan-error">
                {m.error}
                {onRetryPlan && (
                  <button className={s.btn} data-testid="chat-retry" onClick={onRetryPlan}>
                    Try again
                  </button>
                )}
              </div>
            );
          case "revised":
            return (
              <div key={m.id} className={s.assistant} data-testid="chat-revised">
                {revisedText(m)}
              </div>
            );
          case "run_started":
            return (
              <div key={m.id} className={s.muted} data-testid="chat-run-started">
                Plan approved: steps {list(m.approvedIndexes)}
                {m.skippedIndexes.length > 0 && ` · skipped ${list(m.skippedIndexes)}`}
              </div>
            );
          case "step_running":
            return (
              <div key={m.id} className={s.progress} data-testid="chat-step-running">
                <span className={s.spinner} />
                {m.title}…
              </div>
            );
          case "step_done":
            return <StepRow key={m.id} m={m} />;
          case "recap":
            return <RecapCard key={m.id} m={m} events={events} indexOf={indexOf} />;
          case "notice":
            return (
              <div key={m.id} className={`${s.notice} ${m.tone !== "info" ? s.warn : ""}`} data-testid="chat-notice">
                {m.text}
              </div>
            );
        }
      })}
    </div>
  );
}

function UserBubble({ m, api }: { m: Msg<"user">; api: DaemonApi }) {
  return (
    <div className={s.user} data-testid="chat-msg-user">
      {m.attachments.length > 0 && (
        <div className={s.thumbs}>
          {m.attachments.map((a) => (
            <img key={a.attachment_id} className={s.thumb} src={api.attachmentUrl(a.attachment_id)} alt="Attached image" />
          ))}
        </div>
      )}
      {m.text}
    </div>
  );
}

function PlanReady({ m, counts, meta }: { m: Msg<"plan_ready">; counts: Counts | null; meta: string | null }) {
  return (
    <div className={s.assistant} data-testid="chat-plan-ready">
      I'd do this in <b>{m.stepCount} steps</b> and placed them on the grid. <b>Drag a loop around the ones you're OK with</b>; anything
      outside the loop still needs your call.
      {counts && (
        <div className={s.chips}>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.ok}`} />
            {counts.approved} approved
          </span>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.pend}`} />
            {counts.pending} need a decision
          </span>
          <span className={s.chip}>
            <i className={`${s.dot} ${s.rm}`} />
            {counts.removed} removed
          </span>
        </div>
      )}
      {meta && <div className={s.meta}>{meta}</div>}
    </div>
  );
}

function revisedText(m: Msg<"revised">): string {
  const parts: string[] = [];
  if (m.changed.length) parts.push(`changed step${m.changed.length > 1 ? "s" : ""} ${list(m.changed)}`);
  if (m.added.length) parts.push(`added step${m.added.length > 1 ? "s" : ""} ${list(m.added)}`);
  if (m.dropped) parts.push(`dropped ${m.dropped} step${m.dropped > 1 ? "s" : ""}`);
  return parts.length ? `Updated the plan: ${parts.join("; ")}.` : "Revised the plan; no steps changed.";
}

function StepRow({ m }: { m: Msg<"step_done"> }) {
  const mark = m.status === "done" ? "✓" : m.status === "failed" ? "✗" : m.status === "stopped" ? "■" : "–";
  const cls = m.status === "done" ? s.markDone : m.status === "failed" ? s.markFailed : s.markOther;
  const meta = [`step ${m.index}`, m.actions !== null ? `${m.actions} actions` : null, m.durationMs !== null ? secs(m.durationMs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={s.step} data-testid="chat-msg-step" data-status={m.status}>
      <span className={`${s.mark} ${cls}`}>{mark}</span>
      <div>
        {m.summary}
        <div className={s.meta}>{meta}</div>
      </div>
    </div>
  );
}

function RecapCard({ m, events, indexOf }: { m: Msg<"recap">; events: OversightEvent[]; indexOf: Map<string, number> }) {
  const [open, setOpen] = useState(false);
  const label = (id: string) => (indexOf.has(id) ? `Step ${indexOf.get(id)}: ` : "");
  const summary = [`${m.actions} actions`, m.durationMs !== null ? secs(m.durationMs) : null, `$${m.costUsd.toFixed(2)}`].filter(Boolean).join(" · ");
  return (
    <div className={s.recap} data-testid="chat-recap" data-status={m.final?.status ?? ""}>
      <h4>{m.recap.headline}</h4>
      {m.recap.done.map((d) => (
        <div key={`d-${d.step_id}`} className={s.li}>
          <span className={s.liDone}>✓</span>
          <span>
            {label(d.step_id)}
            {d.text}
          </span>
        </div>
      ))}
      {m.recap.skipped.map((d) => (
        <div key={`s-${d.step_id}`} className={s.li}>
          <span className={s.liSkip}>–</span>
          <span>
            {label(d.step_id)}
            {d.reason}
          </span>
        </div>
      ))}
      <div className={s.details}>
        <button className={s.linkBtn} data-testid="chat-recap-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Details: {summary}
        </button>
        {open && (
          <pre className={s.log} data-testid="chat-recap-log">
            {events
              .filter((e) => e.run_id !== null)
              .map(formatEvent)
              .join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the checks**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1432 npx playwright test e2e/chat.spec.ts e2e/smoke.spec.ts`
Expected: typecheck clean, unit tests pass, `4 passed` (2 chat + 2 smoke).

- [ ] **Step 5: Commit**

```bash
git add app/src/chat/ChatThread.tsx app/src/chat/ChatThread.module.css app/e2e/chat.spec.ts
git commit -m "chat: ChatThread with plan message, step rows, recap card and Details log" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- `ChatMessage.plan_ready.revision` is always `0`. Revisions surface as `revised` messages, so the field carries no information. It is left as is (frozen).
- `recap` messages carry no `run_id`, so Details shows every event with a non-null `run_id` in the task (one run per task today).
- Extra test ids `chat-planning`, `chat-run-started`, `chat-recap-log`, and `chat-notice` are additions, not changes. U4 and U5 tests use `chat-run-started` and `chat-recap-log`.
