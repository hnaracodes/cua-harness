# Track U8: Mock daemon, deepened

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8), and Ownership matrix first. Spec section: **Testing** ("The mock daemon implements every new endpoint, so the whole UI runs with no daemon, key, or permissions"). Wave 1, Batch A. E2E port **1438**.

**Goal:** `app/src/api/mock.ts` behaves like the real daemon on every new endpoint, so every UI track can be built and tested with no Python running:
- run narration (`actions` and `duration_ms` on `step_result`, `frame` events, a deterministic `run_recap` before `final_result`)
- a `repropose` that actually changes the plan
- a scriptable setup state machine (`?setup`, `?nonmac`)
- an outage switch (`?down=1`)
- a crowding mode for the canvas (`?many=N`)
- a fast mode for e2e (`?fast`)

**Owns:** `app/src/api/mock.ts`, `app/src/api/fixtures.ts`, `app/e2e/mock.spec.ts`. Nothing else.

**Query flags** (read once, when the mock is created):

| Flag | Effect |
|---|---|
| `?fast` | Simulated action delay drops from 650 ms to 60 ms and the plan/score sleeps shrink tenfold |
| `?setup` | Setup starts incomplete; `health().setup_complete` is false until `completeSetup()` |
| `?nonmac` | `platform: "linux"`, both permissions `"n/a"` |
| `?down=1` | `health()` rejects until `window.__oversightMock.setDown(false)` |
| `?many=N` | The plan has N steps (N clamped to 6..60). Steps after the sixth are synthetic, and pairs share a title so they tie exactly. |

**Test hook:** in mock mode only, `window.__oversightMock = { api, setDown(v: boolean) }`. It exists so e2e can drive the mock directly. Screens never read it.

---

### Task U8-1: Mode flags, test hook, synthetic scores, `?many`

**Files:**
- Modify: `app/src/api/fixtures.ts` (export `syntheticCells`)
- Modify: `app/src/api/mock.ts`
- Test: `app/e2e/mock.spec.ts` (create)

**Interfaces:**
- Consumes: `FIXTURE_DIMENSIONS`, `FIXTURE_STEPS` (fixtures.ts); `hash32` from `app/src/lib/geometry.ts` (frozen, imported read-only).
- Produces: `export function syntheticCells(title: string): [number, number, string][]` in fixtures.ts, the `window.__oversightMock` hook, and the `?fast` / `?many` behaviour.

- [ ] **Step 1: Write the failing e2e**

Create `app/e2e/mock.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

/** Wait until the app has created its mock and exposed it. */
async function mock(page: Page, query: string) {
  await page.goto(`/?mock&${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __oversightMock?: unknown }).__oversightMock);
}

test("?many=30 plans 30 steps with at least one exact tie", async ({ page }) => {
  await mock(page, "fast&many=30");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("crowd");
    const plan = await api.plan(task_id);
    const pts = new Map<string, string[]>();
    for (const s of plan.steps) {
      const x = plan.scores.find((c: any) => c.step_id === s.id && c.dimension === "action_uncertainty").position;
      const y = plan.scores.find((c: any) => c.step_id === s.id && c.dimension === "reversibility").position;
      const k = `${x}|${y}`;
      pts.set(k, [...(pts.get(k) ?? []), s.id]);
    }
    return { n: plan.steps.length, scores: plan.scores.length, maxTie: Math.max(...[...pts.values()].map((v) => v.length)) };
  });
  expect(r.n).toBe(30);
  expect(r.scores).toBe(300);
  expect(r.maxTie).toBeGreaterThanOrEqual(2);
});
```

Run: `cd app && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts`
Expected: FAIL (`waitForFunction` times out: there's no hook yet).

- [ ] **Step 2: Add `syntheticCells` to fixtures**

Append to `app/src/api/fixtures.ts`:

```ts
import { hash32 } from "../lib/geometry";

/** Deterministic cells for a step that is not in the fixture plan (mock re-propose, ?many).
 *  Same title -> same cells -> same point, so equal titles tie exactly. */
export function syntheticCells(title: string): [number, number, string][] {
  return FIXTURE_DIMENSIONS.map((d) => {
    const h = hash32(`${title}|${d.key}`);
    return [h % d.labels.length, ((h >>> 8) % 100) / 100, "Synthetic mock score."] as [number, number, string];
  });
}
```

Move the new `import` line to the top of the file, next to the existing `import type { Dimension, Glyph } from "./types";`.

- [ ] **Step 3: Flags, hook, and `?many` in the mock**

In `app/src/api/mock.ts`:

1. Add `import { syntheticCells } from "./fixtures";` to the fixtures import.

2. At the top of `createMockDaemon`, before `const tasks = …`, add:

```ts
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const MODE = {
    fast: q.has("fast"),
    setup: q.has("setup"),
    nonmac: q.has("nonmac"),
    down: q.get("down") === "1",
    many: q.has("many") ? Math.min(60, Math.max(6, Number(q.get("many")) || 6)) : 0,
  };
  const ms = (n: number) => (MODE.fast ? Math.max(10, Math.round(n / 10)) : n);
  const ACTION_MS = MODE.fast ? 60 : 650;
```

3. In `plan()`, replace every `await sleep(<n>)` with `await sleep(ms(<n>))`. Then replace the `t.steps = FIXTURE_STEPS.map(...)` assignment and the scoring loop's cell source with code that supports `?many`:

```ts
      const n = MODE.many || FIXTURE_STEPS.length;
      const specs = Array.from({ length: n }, (_, i) =>
        i < FIXTURE_STEPS.length
          ? FIXTURE_STEPS[i]
          : { title: `Extra step ${Math.floor((i - FIXTURE_STEPS.length) / 2) + 1}`, description: "Synthetic step for crowding (?many).", glyph: "generic" as const, cells: syntheticCells(`Extra step ${Math.floor((i - FIXTURE_STEPS.length) / 2) + 1}`) },
      );
      t.steps = specs.map((s, i) => ({
        id: `stp_${taskId.slice(4)}_${i + 1}`,
        task_id: taskId,
        index: i + 1,
        title: s.title,
        description: s.description,
        glyph: s.glyph,
        status: "pending",
        edited_from: null,
        revision: 0,
      }));
```

In the scoring loop, use `total = t.steps.length` and read cells from `specs[i].cells` instead of `FIXTURE_STEPS[i].cells`. Every other line of the loop stays as it is.

4. Change `return { mode: "mock", … }` into a named object with the hook installed:

```ts
  const api: DaemonApi = {
    mode: "mock",
    // …every existing member, unchanged…
  };
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__oversightMock = {
      api,
      setDown: (v: boolean) => {
        MODE.down = v;
      },
    };
  }
  return api;
```

(Keep `simulateRun` and the helpers below `return api;` as function declarations, exactly as today.)

- [ ] **Step 4: Run**

Run: `cd app && npm run typecheck && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts && E2E_PORT=1438 npx playwright test e2e/smoke.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/api/mock.ts app/src/api/fixtures.ts app/e2e/mock.spec.ts
git commit -m "mock: query flags (fast, many), test hook, synthetic scores" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U8-2: Run narration (actions, duration, frames, recap)

**Files:**
- Modify: `app/src/api/mock.ts`
- Test: `app/e2e/mock.spec.ts`

**Interfaces:**
- Consumes: C1 `StepResultPayload` (`actions`, `duration_ms`), `FramePayload`, `RunRecapPayload`; C2 `frameUrl(taskId, seq)`.
- Produces: per action, one `action` event and one `frame` event. Per step, a `step_result` carrying `actions` and `duration_ms`. Per run, exactly one `run_recap` (with `source: "fallback"`) immediately before `final_result`. `frameUrl` returns a `data:image/svg+xml` URL that shows the step title.

- [ ] **Step 1: Write the failing test**

Append to `app/e2e/mock.spec.ts`:

```ts
/** Plan, approve everything, run, and collect events until final_result. */
async function runAll(page: Page, removeIndex: number | null = null) {
  return page.evaluate(async (rm) => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("run me");
    const plan = await api.plan(task_id);
    const removed = rm ? [plan.steps[rm - 1].id] : [];
    const approved = plan.steps.map((s: any) => s.id).filter((id: string) => !removed.includes(id));
    const events: any[] = [];
    const done = new Promise<void>((res) => {
      api.subscribe(task_id, 0, (e: any) => {
        events.push(e);
        if (e.kind === "final_result") res();
      });
    });
    const r = await api.run(task_id, { approved_step_ids: approved, checked_step_ids: approved, removed_step_ids: removed, boundaries: [] });
    await done;
    const frames = events.filter((e) => e.kind === "frame");
    return { ok: r.ok, task_id, events, frameUrl: frames.length ? api.frameUrl(task_id, frames[0].payload.seq) : "" };
  }, removeIndex);
}

test("a run narrates: actions/duration on step_result, frames, recap before final", async ({ page }) => {
  await mock(page, "fast");
  const r = await runAll(page, 3);
  expect(r.ok).toBe(true);
  const kinds = r.events.map((e: any) => e.kind);
  const results = r.events.filter((e: any) => e.kind === "step_result");
  expect(results.length).toBe(5);
  for (const e of results) {
    expect(e.payload.actions).toBeGreaterThan(0);
    expect(e.payload.duration_ms).toBeGreaterThanOrEqual(0);
  }
  const nActions = kinds.filter((k: string) => k === "action").length;
  expect(kinds.filter((k: string) => k === "frame").length).toBe(nActions);
  const seqs = r.events.filter((e: any) => e.kind === "frame").map((e: any) => e.payload.seq);
  expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
  expect(kinds.filter((k: string) => k === "run_recap").length).toBe(1);
  expect(kinds.indexOf("run_recap")).toBe(kinds.indexOf("final_result") - 1);
  const recap = r.events.find((e: any) => e.kind === "run_recap").payload;
  expect(recap.source).toBe("fallback");
  expect(recap.done.length).toBe(5);
  expect(recap.skipped.map((s: any) => s.reason)).toEqual(["You removed this step before the run."]);
  expect(r.frameUrl.startsWith("data:image/svg+xml")).toBe(true);
  expect(decodeURIComponent(r.frameUrl)).toContain("Search for tennis rackets under $100");
});
```

Run: `cd app && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts -g "narrates"`
Expected: FAIL (`e.payload.actions` is undefined).

- [ ] **Step 2: Implement**

In `app/src/api/mock.ts`:

1. Extend `MockTask` with `frameSeq: number; frames: Map<number, string>;`, and initialise them in `createTask` as `frameSeq: 0, frames: new Map()`.

2. Add these module-level helpers below `simSummary`:

```ts
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A small deterministic stand-in for the agent's window capture. */
function frameSvg(title: string, verb: string, target: string, n: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">` +
    `<rect width="640" height="400" fill="#101010"/>` +
    `<rect width="640" height="28" fill="#1d1d1d"/>` +
    `<circle cx="16" cy="14" r="5" fill="#e46a5c"/><circle cx="32" cy="14" r="5" fill="#e8a948"/><circle cx="48" cy="14" r="5" fill="#5fc48a"/>` +
    `<text x="68" y="18" fill="#8f8f8f" font-family="sans-serif" font-size="12">agent desk · simulated</text>` +
    `<text x="24" y="84" fill="#ececec" font-family="sans-serif" font-size="20">${esc(title)}</text>` +
    `<text x="24" y="118" fill="#8f8f8f" font-family="sans-serif" font-size="14">action ${n}: ${esc(verb)} ${esc(target)}</text>` +
    `<rect x="24" y="150" width="592" height="220" rx="10" fill="#1b1b1b" stroke="#262626"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
```

3. Replace `frameUrl: () => "",` with:

```ts
    frameUrl: (taskId: string, seq: number) => tasks.get(taskId)?.frames.get(seq) ?? "",
```

4. Replace the whole `simulateRun` function with:

```ts
  async function simulateRun(t: MockTask, runId: string, approved: Set<string>, removed: Set<string>) {
    const steps = t.steps.filter((s) => approved.has(s.id));
    emit(t, "consideration_scored", { step_count: t.steps.length, dimension_count: 10, approved_count: steps.length }, runId);
    for (const s of t.steps) if (removed.has(s.id)) emit(t, "step_removed", { step_id: s.id, index: s.index, title: s.title }, runId);
    const attempted: string[] = [];
    const completed: string[] = [];
    const summaries = new Map<string, string>();
    let n = 0;
    let stopped = false;
    for (const s of steps) {
      if (t.stop) {
        stopped = true;
        break;
      }
      // Executor-side assertion, mirrored: never dispatch an unapproved step.
      if (!approved.has(s.id)) throw new Error(`UnapprovedStepError: ${s.id}`);
      attempted.push(s.id);
      emit(t, "step_started", { step_id: s.id, index: s.index, title: s.title }, runId);
      const t0 = Date.now();
      let stepActions = 0;
      let halted = false;
      for (const a of simActions(s)) {
        await sleep(ACTION_MS);
        if (t.stop) {
          halted = true;
          break;
        }
        n += 1;
        stepActions += 1;
        emit(t, "action", { step_id: s.id, n, mode: "sim", verb: a[0], target: a[1], detail: a[2], ok: true, error: null }, runId);
        cost(t, "run", 2100, 180, ACTION_MS, runId);
        t.frameSeq += 1;
        t.frames.set(t.frameSeq, frameSvg(s.title, a[0], a[1], n));
        emit(t, "frame", { step_id: s.id, seq: t.frameSeq }, runId);
      }
      const duration_ms = Date.now() - t0;
      if (halted) {
        emit(t, "step_result", { step_id: s.id, index: s.index, status: "stopped", summary: "Stopped by the user.", actions: stepActions, duration_ms }, runId);
        stopped = true;
        break;
      }
      completed.push(s.id);
      summaries.set(s.id, simSummary(s));
      emit(t, "step_result", { step_id: s.id, index: s.index, status: "done", summary: summaries.get(s.id)!, actions: stepActions, duration_ms }, runId);
    }
    t.running = false;
    const skipped = [
      ...t.steps.filter((s) => removed.has(s.id)).map((s) => ({ step_id: s.id, reason: "You removed this step before the run." })),
      ...steps.filter((s) => !attempted.includes(s.id)).map((s) => ({ step_id: s.id, reason: "Not run: the run was stopped." })),
    ];
    emit(t, "run_recap", {
      headline: stopped
        ? `Stopped after ${completed.length} of ${steps.length} approved steps.`
        : `Done. Completed ${completed.length} of ${steps.length} approved steps.`,
      done: completed.map((id) => ({ step_id: id, text: summaries.get(id)! })),
      skipped,
      source: "fallback",
    }, runId);
    const final = stopped
      ? { status: "stopped" as const, message: "Run stopped by the user. Remaining approved steps were not attempted.", attempted, completed }
      : { status: "completed" as const, message: "All approved steps were attempted.", attempted, completed };
    const rec = t.runs.find((r) => r.id === runId);
    if (rec) Object.assign(rec, { status: final.status, finished_at: new Date().toISOString(), final });
    emit(t, "final_result", final, runId);
  }
```

- [ ] **Step 3: Run**

Run: `cd app && npm run typecheck && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts e2e/smoke.spec.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/api/mock.ts app/e2e/mock.spec.ts
git commit -m "mock: run narration (actions, duration, frames, fallback recap)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U8-3: Re-propose that changes the plan, and history order

**Files:**
- Modify: `app/src/api/mock.ts`
- Test: `app/e2e/mock.spec.ts`

**Interfaces:**
- Consumes: C1 `PlanRevisedPayload`; C2 `repropose`, `listTasks`.
- Produces: `repropose(taskId, instruction)` with these rules:
  - Empty or `null` instruction: same steps, `revision + 1`.
  - Instruction containing the word "add": appends a new pending step titled with the instruction.
  - Any other instruction: changes the **last non-removed** step's title, keeping its id and setting `edited_from`.
  - It re-scores only the changed or added step, then emits `plan_progress` (planning), `plan_revised` (with ids), and `plan_progress` (done).
  - It returns 409 (`HttpError`) while a run is active or before a plan exists.
- `listTasks` returns tasks newest first.

- [ ] **Step 1: Write the failing tests**

Append to `app/e2e/mock.spec.ts`:

```ts
test("repropose edits the last non-removed step, or adds one on 'add'", async ({ page }) => {
  await mock(page, "fast");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("revise me");
    const plan = await api.plan(task_id);
    const last = plan.steps[plan.steps.length - 1];
    const prev = plan.steps[plan.steps.length - 2];
    await api.decision(task_id, { step_id: last.id, action: "remove", source: "step_list" });
    const events: any[] = [];
    api.subscribe(task_id, 0, (e: any) => events.push(e));
    const a = await api.repropose(task_id, "only message the party group");
    const b = await api.repropose(task_id, "add a step to compare reviews");
    const revised = events.filter((e) => e.kind === "plan_revised").map((e) => e.payload);
    let conflict = 0;
    try {
      const { task_id: t2 } = await api.createTask("no plan");
      await api.repropose(t2, "x");
    } catch (e: any) {
      conflict = e.status;
    }
    return {
      prevId: prev.id, prevTitle: prev.title,
      aStep: a.steps.find((s: any) => s.id === prev.id),
      aRev: a.revision, bLen: b.steps.length, bLast: b.steps[b.steps.length - 1],
      revised, before: plan.steps.length, conflict,
      scoresForNew: b.scores.filter((s: any) => s.step_id === b.steps[b.steps.length - 1].id).length,
    };
  });
  expect(r.aStep.title).toContain("only message the party group");
  expect(r.aStep.edited_from).toBe(r.prevTitle);
  expect(r.aRev).toBe(1);
  expect(r.revised[0]).toMatchObject({ revision: 1, instruction: "only message the party group", changed_step_ids: [r.prevId], added_step_ids: [], dropped_step_ids: [] });
  expect(r.bLen).toBe(r.before + 1);
  expect(r.bLast.status).toBe("pending");
  expect(r.revised[1].added_step_ids).toEqual([r.bLast.id]);
  expect(r.scoresForNew).toBe(10);
  expect(r.conflict).toBe(409);
});

test("listTasks is newest first", async ({ page }) => {
  await mock(page, "fast");
  const ids = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const a = (await api.createTask("first")).task_id;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await api.createTask("second")).task_id;
    return { a, b, list: (await api.listTasks()).map((t: any) => t.id) };
  });
  expect(ids.list.slice(0, 2)).toEqual([ids.b, ids.a]);
});
```

Run: `cd app && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts -g "repropose|newest"`
Expected: FAIL (the title is unchanged).

- [ ] **Step 2: Implement**

In `app/src/api/mock.ts`, add these helpers inside `createMockDaemon`, after `getTask`:

```ts
  /** Latest remove/restore decision per step, as the daemon's stored status would be. */
  const removedSet = (t: MockTask) => {
    const out = new Set<string>();
    for (const d of t.decisions) {
      if (d.action === "remove") out.add(d.step_id);
      else if (d.action === "restore") out.delete(d.step_id);
    }
    return out;
  };

  const scoresFor = (s: Step): Score[] =>
    syntheticCells(s.title).map(([li, off, rationale], d) => {
      const dim = FIXTURE_DIMENSIONS[d];
      return { step_id: s.id, dimension: dim.key, label: dim.labels[li], position: (li + off) / dim.labels.length, confidence: 0.5, rationale };
    });

  const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
```

Replace the `repropose` member with:

```ts
    async repropose(taskId: string, instruction: string | null) {
      const t = getTask(taskId);
      if (t.running) throw new HttpError(409, { error: "a run is in progress for this task" });
      if (!t.steps.length) throw new HttpError(409, { error: "task has no plan yet" });
      emit(t, "plan_progress", { stage: "planning", message: "Revising the plan.", done: 0, total: t.steps.length });
      await sleep(ms(600));
      t.revision += 1;
      const text = (instruction ?? "").trim();
      const changed: string[] = [];
      const added: string[] = [];
      if (text && /\badd\b/i.test(text)) {
        const idx = t.steps.length + 1;
        const s: Step = {
          id: `stp_${taskId.slice(4)}_r${t.revision}_${idx}`, task_id: taskId, index: idx, title: clip(text),
          description: `Added on request: ${text}`, glyph: "generic", status: "pending", edited_from: null, revision: t.revision,
        };
        t.steps.push(s);
        t.scores.push(...scoresFor(s));
        added.push(s.id);
      } else if (text) {
        const removed = removedSet(t);
        const target = [...t.steps].reverse().find((s) => !removed.has(s.id));
        if (target) {
          target.edited_from = target.edited_from ?? target.title;
          target.title = clip(`${target.title} (${text})`);
          target.revision = t.revision;
          t.scores = t.scores.filter((x) => x.step_id !== target.id).concat(scoresFor(target));
          changed.push(target.id);
        }
      }
      emit(t, "plan_revised", { revision: t.revision, instruction: text || null, changed_step_ids: changed, added_step_ids: added, dropped_step_ids: [] });
      emit(t, "plan_progress", { stage: "done", message: "Plan revised.", done: t.steps.length, total: t.steps.length });
      return { task_id: taskId, steps: t.steps.map((s) => ({ ...s })), scores: t.scores.map((s) => ({ ...s })), revision: t.revision };
    },
```

Replace `listTasks` with:

```ts
    async listTasks() {
      return [...tasks.values()]
        .map((t, i) => ({ t, i }))
        .sort((a, b) => b.t.createdAt.localeCompare(a.t.createdAt) || b.i - a.i)
        .map(({ t }) => ({ id: t.id, prompt: t.prompt, created_at: t.createdAt, step_count: t.steps.length }));
    },
```

- [ ] **Step 3: Run**

Run: `cd app && npm run typecheck && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts e2e/smoke.spec.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/api/mock.ts app/e2e/mock.spec.ts
git commit -m "mock: repropose changes or adds a step; history newest first" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U8-4: Setup state machine, `?nonmac`, `?down=1`

**Files:**
- Modify: `app/src/api/mock.ts`
- Test: `app/e2e/mock.spec.ts`

**Interfaces:**
- Consumes: C1 `SetupStatus`, `PermState`, `AppSettings`; C2 setup members.
- Produces, under `?setup`:
  - Setup starts with key missing, driver not installed, permissions `"unknown"`, and self-test null.
  - `setKey` succeeds only when the key starts with `sk-`.
  - `installDriver` installs; `startDriver` needs an installed driver.
  - `openPermission(which)` flips that permission to `"granted"` after 1.5 s (300 ms with `?fast`).
  - `selfTest` passes only when the driver is running and both permissions are granted or `"n/a"`.
  - `completeSetup` sets `complete` and `health().setup_complete`.
  - `putSettings({plan_only})` mirrors into the setup status.
- Without `?setup`, setup stays complete exactly as in W0-2.
- `?down=1` makes `health()` reject until `setDown(false)`.

- [ ] **Step 1: Write the failing tests**

Append to `app/e2e/mock.spec.ts`:

```ts
test("?setup walks key → driver → permissions → self-test → complete", async ({ page }) => {
  await mock(page, "fast&setup");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const s0 = await api.setupStatus();
    const h0 = await api.health();
    const bad = await api.setKey("anthropic", "nope");
    const good = await api.setKey("anthropic", "sk-test");
    const startEarly = await api.startDriver();
    const inst = await api.installDriver();
    const start = await api.startDriver();
    const testEarly = await api.selfTest();
    await api.openPermission("accessibility");
    await api.openPermission("screen_recording");
    const mid = await api.setupStatus();
    await new Promise((r) => setTimeout(r, 450));
    const granted = await api.setupStatus();
    const st = await api.selfTest();
    await api.completeSetup();
    return { s0, h0, bad, good, startEarly, inst, start, testEarly, mid, granted, st, s1: await api.setupStatus(), h1: await api.health() };
  });
  expect(r.s0).toMatchObject({ complete: false, key: { present: false, source: "none" }, driver: { installed: false, running: false }, permissions: { accessibility: "unknown", screen_recording: "unknown" }, self_test: { passed_at: null } });
  expect(r.h0.setup_complete).toBe(false);
  expect(r.bad.ok).toBe(false);
  expect(r.good).toEqual({ ok: true, error: null });
  expect(r.startEarly.ok).toBe(false);
  expect(r.inst.ok).toBe(true);
  expect(r.start.ok).toBe(true);
  expect(r.testEarly.ok).toBe(false);
  expect(r.mid.permissions.accessibility).toBe("unknown");
  expect(r.granted.permissions).toEqual({ accessibility: "granted", screen_recording: "granted" });
  expect(r.st.ok).toBe(true);
  expect(r.s1.complete).toBe(true);
  expect(r.s1.self_test.passed_at).not.toBeNull();
  expect(r.h1.setup_complete).toBe(true);
});

test("?nonmac reports linux with n/a permissions; self-test needs only the driver", async ({ page }) => {
  await mock(page, "fast&setup&nonmac");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    await api.installDriver();
    await api.startDriver();
    return { s: await api.setupStatus(), t: await api.selfTest() };
  });
  expect(r.s.platform).toBe("linux");
  expect(r.s.permissions).toEqual({ accessibility: "n/a", screen_recording: "n/a" });
  expect(r.t.ok).toBe(true);
});

test("?down=1 rejects health until setDown(false)", async ({ page }) => {
  await mock(page, "fast&down=1");
  const r = await page.evaluate(async () => {
    const m = (window as any).__oversightMock;
    let failed = false;
    try {
      await m.api.health();
    } catch {
      failed = true;
    }
    m.setDown(false);
    return { failed, back: (await m.api.health()).daemon };
  });
  expect(r).toEqual({ failed: true, back: "ok" });
});
```

Run: `cd app && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts -g "setup|nonmac|down"`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `app/src/api/mock.ts`, inside `createMockDaemon` after `settings`, add:

```ts
  const na: PermState = "n/a";
  const setup: SetupStatus = MODE.setup
    ? {
        platform: MODE.nonmac ? "linux" : "macos",
        key: { provider: "anthropic", present: false, source: "none", tested: false, warning: null },
        driver: { installed: false, version: null, running: false },
        permissions: MODE.nonmac ? { accessibility: na, screen_recording: na } : { accessibility: "unknown", screen_recording: "unknown" },
        self_test: { passed_at: null },
        plan_only: false,
        complete: false,
      }
    : {
        platform: MODE.nonmac ? "linux" : "macos",
        key: { provider: "anthropic", present: true, source: "env", tested: true, warning: null },
        driver: { installed: true, version: "mock", running: true },
        permissions: MODE.nonmac ? { accessibility: na, screen_recording: na } : { accessibility: "granted", screen_recording: "granted" },
        self_test: { passed_at: new Date().toISOString() },
        plan_only: false,
        complete: true,
      };
  const permsOk = () => (["accessibility", "screen_recording"] as const).every((k) => setup.permissions[k] === "granted" || setup.permissions[k] === "n/a");
```

Add `PermState` to the type imports.

In `health()`: make the first statement `if (MODE.down) throw new Error("mock: daemon down (?down=1)");`, and set `setup_complete: setup.complete,` (replacing `setup_complete: true`).

Replace the setup and settings members with:

```ts
    async setupStatus(): Promise<SetupStatus> {
      return JSON.parse(JSON.stringify(setup)) as SetupStatus;
    },
    async setKey(provider: Provider, key: string) {
      await sleep(ms(300));
      if (!key.trim().startsWith("sk-")) return { ok: false, error: "That doesn't look like an API key (it should start with sk-)." };
      setup.key = { provider, present: true, source: "keychain", tested: true, warning: null };
      settings.provider = provider;
      return { ok: true, error: null };
    },
    async installDriver() {
      await sleep(ms(800));
      setup.driver = { installed: true, version: "0.32.0 (mock)", running: false };
      return { ok: true, version: setup.driver.version, log_tail: "Installed CuaDriver.app (mock)." };
    },
    async startDriver() {
      if (!setup.driver.installed) return { ok: false, error: "cua-driver is not installed" };
      await sleep(ms(300));
      setup.driver.running = true;
      return { ok: true, error: null };
    },
    async openPermission(which: "accessibility" | "screen_recording") {
      if (setup.permissions[which] !== "n/a") setTimeout(() => { setup.permissions[which] = "granted"; }, MODE.fast ? 300 : 1500);
      return { ok: true };
    },
    async selfTest() {
      await sleep(ms(1000));
      if (!setup.driver.running) return { ok: false, detail: "cua-driver is not running." };
      if (!permsOk()) return { ok: false, detail: "Accessibility and Screen Recording must both be allowed for CuaDriver." };
      setup.self_test = { passed_at: new Date().toISOString() };
      return { ok: true, detail: "Typed \"hello\" into a scratch window and read it back." };
    },
    async completeSetup() {
      setup.complete = true;
      return { ok: true };
    },
    async getSettings() {
      return { ...settings, models: { ...settings.models } };
    },
    async putSettings(patch: Partial<Pick<AppSettings, "provider" | "model" | "plan_only">>) {
      if (patch.provider && !(patch.provider in settings.models)) throw new HttpError(400, { error: `unknown provider ${patch.provider}` });
      const prov = patch.provider ?? settings.provider;
      if (patch.model && !settings.models[prov].includes(patch.model)) throw new HttpError(400, { error: `unknown model ${patch.model}` });
      Object.assign(settings, patch);
      if (patch.plan_only !== undefined) setup.plan_only = patch.plan_only;
      return { ...settings, models: { ...settings.models } };
    },
```

Add `Provider` to the type imports.

- [ ] **Step 3: Run the whole track**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1438 npx playwright test e2e/mock.spec.ts e2e/smoke.spec.ts`
Expected: all pass. Smoke stays green, because without `?setup` the mock is complete.

- [ ] **Step 4: Commit**

```bash
git add app/src/api/mock.ts app/e2e/mock.spec.ts
git commit -m "mock: setup state machine (?setup, ?nonmac) and outage switch (?down=1)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- `window.__oversightMock` is a test-only hook created inside `mock.ts`, and only in mock mode. It isn't part of C2, and no screen may read it. The W2 and U-track e2e specs may use it.
- `?down=1` affects only `health()`. Other calls keep working, so the UI's reconnect state is driven by the health poll, as with a real outage seen through `/health`.
