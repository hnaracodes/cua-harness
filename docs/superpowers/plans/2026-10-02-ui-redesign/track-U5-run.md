# Track U5: Run screen (narrated chat + agent's desk)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8), and Ownership matrix first. **Batch B.** Start after U2 is merged: the e2e asserts U2's `chat-msg-step`, `chat-recap-details`, and `chat-recap-log`. U8 and D4 add real `frame` events. This track renders them when present and a placeholder when not, so it does not wait on them. E2E port **1435**.
>
> Spec: Screens §3 (Running). Mockup: `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/4-home-run-setup.html` (section 2).

**Owns:**
- `app/src/workspace/RunScreen.tsx`
- `workspace/DeskView.*` (including `DeskView.logic.ts`)
- `workspace/Run*.module.css`
- `app/tests/desk.test.mts`, `app/e2e/run.spec.ts`

**Uses (does not modify):** `ChatThread` and `eventsToMessages` (U2), `Composer` (U1; the stub has the same props), session actions `stop` and `submit` (C5), and `DaemonApi.frameUrl` (C2).

**Behavior:**
- **Chat column:** run messages from `eventsToMessages`, then a dock `Composer`.
  - While `phase === "running"` the composer is in its running state (Stop → `actions.stop()`), and its placeholder reads `The agent is working. Stop it any time.`
  - When `phase === "done"` the composer starts a new task (`actions.submit(text, atts)`), with placeholder `Start a new task…`.
- **Right panel (`DeskView`):**
  - A header `Agent's desk` with the pill `only this window is visible to the model`, and a position label: `step N of M` while running, or `K of M done` when finished.
  - A segmented progress bar, one segment per approved step.
  - The latest frame image, or a placeholder.

---

## Task U5-1: Desk state (pure)

**Files:**
- Create: `app/src/workspace/DeskView.logic.ts`
- Test: `app/tests/desk.test.mts`

**Interfaces:**
- Consumes: `OversightEvent`, `Step`, `StepRefPayload`, `StepResultPayload`, `FramePayload` (C1), and `RunInfo` (C5). All are type-only imports.
- Produces:
  - `type BarState = "todo" | "active" | "done" | "failed" | "stopped"`
  - `interface DeskState { total; position; current: { index: number; title: string } | null; frameSeq: number | null; bars: BarState[]; finished: boolean; doneCount: number }`
  - `deskState(events, steps, run): DeskState`
  - `deskLabel(d: DeskState): string`
- Only events whose `run_id === run.runId` count. Bars follow approved steps in index order.

- [ ] **Step 1: Write the failing test**

Create `app/tests/desk.test.mts`:

```ts
// Run: npm test. What the agent's-desk panel shows (track U5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deskLabel, deskState } from "../src/workspace/DeskView.logic.ts";
import type { OversightEvent, Step } from "../src/api/types.ts";

const steps: Step[] = [1, 2, 3, 4].map((i) => ({
  id: `s${i}`, task_id: "t", index: i, title: `Step ${i}`, description: "d", glyph: "generic",
  status: "pending", edited_from: null, revision: 0,
}));
const run = { runId: "r1", approvedIds: ["s1", "s2", "s4"], removedIds: ["s3"] };
let seq = 0;
const ev = (kind: OversightEvent["kind"], payload: object, run_id: string | null = "r1"): OversightEvent => ({
  kind, task_id: "t", run_id, seq: ++seq, ts: "2026-10-02T10:00:00Z", payload: payload as Record<string, unknown>,
});

test("before anything runs: all todo, no frame", () => {
  const d = deskState([], steps, run);
  assert.deepEqual([d.total, d.position, d.current, d.frameSeq, d.bars, d.finished], [3, 0, null, null, ["todo", "todo", "todo"], false]);
  assert.equal(deskLabel(d), "Starting…");
});

test("mid-run: active bar, position, latest frame of this run only", () => {
  const events = [
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }),
    ev("frame", { step_id: "s1", seq: 1 }),
    ev("step_result", { step_id: "s1", index: 1, status: "done", summary: "ok" }),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }),
    ev("frame", { step_id: "s2", seq: 2 }),
    ev("frame", { step_id: "x", seq: 99 }, "r_other"),
  ];
  const d = deskState(events, steps, run);
  assert.deepEqual(d.bars, ["done", "active", "todo"]);
  assert.deepEqual(d.current, { index: 2, title: "Step 2" });
  assert.equal(d.position, 2);
  assert.equal(d.frameSeq, 2);
  assert.equal(deskLabel(d), "step 2 of 3");
});

test("finished: failed and stopped bars, done count label", () => {
  const events = [
    ev("step_started", { step_id: "s1", index: 1, title: "Step 1" }),
    ev("step_result", { step_id: "s1", index: 1, status: "done", summary: "ok" }),
    ev("step_started", { step_id: "s2", index: 2, title: "Step 2" }),
    ev("step_result", { step_id: "s2", index: 2, status: "stopped", summary: "Stopped by the user." }),
    ev("final_result", { status: "stopped", message: "m", attempted: ["s1", "s2"], completed: ["s1"] }),
  ];
  const d = deskState(events, steps, run);
  assert.deepEqual(d.bars, ["done", "stopped", "todo"]);
  assert.equal(d.finished, true);
  assert.equal(d.current, null);
  assert.equal(d.doneCount, 1);
  assert.equal(deskLabel(d), "1 of 3 done");
});
```

Run: `cd app && npm test`
Expected: FAIL with `Cannot find module '../src/workspace/DeskView.logic.ts'`.

- [ ] **Step 2: Implement**

Create `app/src/workspace/DeskView.logic.ts`:

```ts
// What the agent's-desk panel shows for one run (track U5). Type-only imports.
import type { FramePayload, OversightEvent, Step, StepRefPayload, StepResultPayload } from "../api/types";
import type { RunInfo } from "../state/session";

export type BarState = "todo" | "active" | "done" | "failed" | "stopped";
export interface DeskState {
  total: number;
  position: number;
  current: { index: number; title: string } | null;
  frameSeq: number | null;
  bars: BarState[];
  finished: boolean;
  doneCount: number;
}

export function deskState(events: OversightEvent[], steps: Step[], run: RunInfo): DeskState {
  const approved = steps.filter((s) => run.approvedIds.includes(s.id)).sort((a, b) => a.index - b.index);
  const status = new Map<string, BarState>();
  let current: DeskState["current"] = null;
  let frameSeq: number | null = null;
  let finished = false;
  for (const e of events) {
    if (e.run_id !== run.runId) continue;
    const p = e.payload as unknown;
    if (e.kind === "step_started") {
      const s = p as StepRefPayload;
      status.set(s.step_id, "active");
      current = { index: s.index, title: s.title };
    } else if (e.kind === "step_result") {
      const r = p as StepResultPayload;
      status.set(r.step_id, r.status === "done" ? "done" : r.status === "failed" ? "failed" : r.status === "stopped" ? "stopped" : "todo");
      if (current?.index === r.index) current = null;
    } else if (e.kind === "frame") frameSeq = (p as FramePayload).seq;
    else if (e.kind === "final_result") {
      finished = true;
      current = null;
    }
  }
  const bars = approved.map((s) => status.get(s.id) ?? "todo");
  const doneCount = bars.filter((b) => b === "done").length;
  const position = current ? approved.findIndex((s) => s.index === current!.index) + 1 : bars.filter((b) => b !== "todo" && b !== "active").length;
  return { total: approved.length, position, current, frameSeq, bars, finished, doneCount };
}

export function deskLabel(d: DeskState): string {
  if (d.finished) return `${d.doneCount} of ${d.total} done`;
  if (d.current) return `step ${d.position} of ${d.total}`;
  return d.position === 0 ? "Starting…" : `step ${d.position} of ${d.total}`;
}
```

- [ ] **Step 3: Verify and commit**

Run: `cd app && npm run typecheck && npm test`
Expected: all pass (3 new tests).

```bash
git add app/src/workspace/DeskView.logic.ts app/tests/desk.test.mts
git commit -m "run: desk state (progress bars, position, latest frame)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task U5-2: DeskView and RunScreen

**Files:**
- Modify: `app/src/workspace/DeskView.tsx`, `app/src/workspace/RunScreen.tsx` (replace the stubs)
- Create: `app/src/workspace/DeskView.module.css`, `app/src/workspace/RunScreen.module.css`
- Test: `app/e2e/run.spec.ts`

**Interfaces:**
- Consumes: `deskState`, `deskLabel`, `ScreenProps` (C5), `ComposerProps` and `ChatThreadProps` (C6), and `api.frameUrl(taskId, seq)` (C2). An empty string means no image available, which the W0 mock returns.
- Produces:
  - `DeskView(props: { api; taskId; events; steps; run })` and `RunScreen(props: ScreenProps)`, both unchanged exports (C6).
  - Test ids `desk-view`, `desk-frame` (always rendered; it holds the `<img>` or the placeholder), and `desk-progress` (one child `<span>` per approved step).
  - Extra test id `desk-label`.

- [ ] **Step 1: Write the failing e2e test**

Create `app/e2e/run.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// Run: E2E_PORT=1435 npx playwright test e2e/run.spec.ts
async function startRun(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("desk-view")).toBeVisible();
}

test("narrates step messages in order and ends in a recap with Details", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("desk-view")).toContainText("only this window is visible to the model");
  await expect(page.getByTestId("desk-progress").locator("span")).toHaveCount(6);
  await expect(page.getByTestId("desk-frame")).toBeVisible();
  await expect(page.getByTestId("desk-label")).toHaveText(/step \d of 6/);
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId("chat-msg-step");
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(rows.nth(i)).toContainText(`step ${i + 1}`);
  await expect(page.getByTestId("desk-label")).toHaveText("6 of 6 done");
  await page.getByTestId("chat-recap-details").click();
  await expect(page.getByTestId("chat-recap-log")).toBeVisible();
});

test("Stop mid-run gives a stopped recap", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("chat-step-running")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer-stop").click();
  const recap = page.getByTestId("chat-recap");
  await expect(recap).toBeVisible({ timeout: 20_000 });
  await expect(recap).toContainText(/stop/i);
  expect(await page.getByTestId("chat-msg-step").count()).toBeLessThan(6);
});

test("a new task from the done composer goes back to planning", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("chat-step-running")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer-stop").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("composer-input").fill("Draft a reply to my latest email");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-msg-user").first()).toHaveText("Draft a reply to my latest email");
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
});
```

Run: `cd app && E2E_PORT=1435 npx playwright test e2e/run.spec.ts`
Expected: FAIL (the stub `DeskView` has no `desk-progress`).

- [ ] **Step 2: DeskView**

Replace `app/src/workspace/DeskView.tsx`:

```tsx
// The agent's own window, exactly what the model saw (window-scoped frames only).
import { useMemo, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { OversightEvent, Step } from "../api/types";
import type { RunInfo } from "../state/session";
import { deskLabel, deskState } from "./DeskView.logic";
import s from "./DeskView.module.css";

export function DeskView({ api, taskId, events, steps, run }: { api: DaemonApi; taskId: string; events: OversightEvent[]; steps: Step[]; run: RunInfo }) {
  const d = useMemo(() => deskState(events, steps, run), [events, steps, run]);
  const url = d.frameSeq !== null ? api.frameUrl(taskId, d.frameSeq) : "";
  const [broken, setBroken] = useState<string | null>(null);
  const placeholder =
    api.mode === "mock" ? "Simulated run: there is no agent window to show." :
    d.finished ? "No view was captured for this run." : "Waiting for the agent's first view…";
  return (
    <div className={s.desk} data-testid="desk-view">
      <div className={s.head}>
        <span className={s.title}>Agent's desk</span>
        <span className={s.pill}>only this window is visible to the model</span>
        <span className={s.spacer} />
        <span className={s.where} data-testid="desk-label">{deskLabel(d)}</span>
      </div>
      <div className={s.progress} data-testid="desk-progress">
        {d.bars.map((b, i) => (
          <span key={i} className={`${s.seg} ${s[b]}`} />
        ))}
      </div>
      <div className={s.frame} data-testid="desk-frame">
        {url && broken !== url ? (
          <img className={s.img} src={url} alt={d.current ? `Agent window during step ${d.current.index}` : "Agent window"} onError={() => setBroken(url)} />
        ) : (
          <div className={s.placeholder}>{placeholder}</div>
        )}
      </div>
    </div>
  );
}
```

`app/src/workspace/DeskView.module.css`:

```css
.desk { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; min-height: 0; }
.head { display: flex; align-items: center; gap: 10px; }
.title { font-weight: 600; }
.pill { border: 1px solid var(--line); border-radius: var(--r-pill); padding: 3px 10px; font-size: var(--fs-xs); color: var(--text-2); }
.spacer { flex: 1; }
.where { color: var(--text-3); font-size: var(--fs-sm); }
.progress { display: flex; gap: 6px; }
.seg { flex: 1; height: 6px; border-radius: 3px; background: var(--raised); transition: background var(--dur) var(--ease); }
.done { background: var(--ok); }
.active { background: var(--accent); }
.failed { background: var(--rm); }
.stopped { background: var(--text-3); }
.todo { background: var(--raised); }
.frame { flex: 1; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); overflow: hidden; display: grid; place-items: center; }
.img { max-width: 100%; max-height: 100%; object-fit: contain; }
.placeholder { color: var(--text-3); font-size: var(--fs-sm); padding: 24px; text-align: center; }
```

- [ ] **Step 3: RunScreen**

Replace `app/src/workspace/RunScreen.tsx`:

```tsx
// Running and done: the chat narrates, the desk shows what the model sees.
import { useMemo, useState } from "react";
import type { Attachment } from "../api/types";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { Composer } from "../home/Composer";
import type { ScreenProps } from "../screens";
import { DeskView } from "./DeskView";
import s from "./RunScreen.module.css";

export function RunScreen({ api, conn, session }: ScreenProps) {
  const { state, actions } = session;
  const [draft, setDraft] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const running = state.phase === "running";
  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: null }),
    [state.prompt, state.attachments, state.steps, state.events],
  );
  // Done: the composer starts a fresh task. `submit` dispatches start_task, which resets
  // the session, so the screen switches straight to planning with no flash of Home.
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const a = atts;
    setDraft("");
    setAtts([]);
    void actions.submit(text, a);
  };
  return (
    <div className={s.screen}>
      <section className={s.chat}>
        <ChatThread api={api} messages={messages} counts={null} meta={null} events={state.events} steps={state.steps} />
        <div className={s.dock}>
          <Composer api={api} value={draft} onChange={setDraft} attachments={atts} onAttachmentsChange={setAtts}
            allowAttachments={!running} providerLabel={conn.health?.provider === "openai" ? "OpenAI" : "Anthropic"}
            placeholder={running ? "The agent is working. Stop it any time." : "Start a new task…"} size="dock"
            disabledReason={null} running={running} onSend={send} onStop={() => void actions.stop()} />
        </div>
      </section>
      <section className={s.workspace}>
        {state.taskId && state.run && (
          <DeskView api={api} taskId={state.taskId} events={state.events} steps={state.steps} run={state.run} />
        )}
      </section>
    </div>
  );
}
```

`app/src/workspace/RunScreen.module.css`:

```css
.screen { display: flex; height: 100%; min-height: 0; }
.chat { width: var(--chat-w); flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
.dock { padding: 12px 16px 16px; }
.workspace { flex: 1; min-width: 0; min-height: 0; }
```

- [ ] **Step 4: Run all checks**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1435 npx playwright test e2e/run.spec.ts e2e/smoke.spec.ts`
Expected: clean, `5 passed` (3 run + 2 smoke).

- [ ] **Step 5: Commit**

```bash
git add app/src/workspace/DeskView.tsx app/src/workspace/DeskView.module.css app/src/workspace/RunScreen.tsx app/src/workspace/RunScreen.module.css app/e2e/run.spec.ts
git commit -m "run: narrated run screen with agent's desk panel" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- The done-state composer calls only `actions.submit`, not `newTask()` then `submit`. `submit` dispatches `start_task`, which already resets the session. Calling `newTask()` first would flash the Home screen while `createTask` is in flight.
- The stop e2e expects the recap to match `/stop/i`. The U2 fallback headline `Stopped. Here's what got done` satisfies that. If U8 makes the mock emit `run_recap`, its stopped-run headline must also mention stopping.
- `desk-label` is an extra test id, an addition to C8 rather than a change.
