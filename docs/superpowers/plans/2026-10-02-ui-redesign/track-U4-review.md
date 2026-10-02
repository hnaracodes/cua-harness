# Track U4: Review workspace (chat-left / workspace-right)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8), and Ownership matrix first. **Batch B.** Start after U2 and U3 are merged: this track's e2e asserts U2's `chat-revised` and `chat-run-started`, and U3's canvas ids. E2E port **1434**.
>
> Spec: Screens §2 (Review), Error handling (`/run` 409). Mockup: `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/3-review-workspace.html`.

**Owns:**
- `app/src/workspace/ReviewScreen.tsx`
- `workspace/StepList.*`, `workspace/ActionBar.*` (including `ActionBar.logic.ts`), `workspace/AxisPicker.*`
- `workspace/Review*.module.css`
- `app/tests/actionbar.test.mts`, `app/e2e/review.spec.ts`

**Uses (does not modify):** `ChatThread`, `eventsToMessages` (U2), `Composer` (U1; the Wave 0 stub has the same props), `BoundaryCanvas` (U3), `useSession` actions (C5).

**Layout:**
- **Chat column:** `ChatThread`, plus a dock `Composer` whose send calls `actions.revise(text)`.
- **Workspace:**
  - Header: `Plan review`, the X/Y `AxisPicker`, and a Grid / Paper view toggle.
  - Canvas, or a "Preparing oversight view…" panel while planning.
  - `StepList`, then `ActionBar`.
- **Hover sync:** `hoveredId` lives in `ReviewScreen` and goes to both the canvas and the list.

---

## Task U4-1: Action-bar logic (pure)

**Files:**
- Create: `app/src/workspace/ActionBar.logic.ts`
- Test: `app/tests/actionbar.test.mts`

**Interfaces:**
- Consumes: `Counts` (C5), `Health` (C1). Both are type-only imports.
- Produces:
  - `type PrimaryKind = "approve_all" | "run" | "skip_and_run" | "fix_permissions" | "setup" | "starting"`
  - `interface PrimaryAction { kind; label; disabled; testId: "approve-all" | "run-primary" }`
  - `primaryAction(counts, health, planOnly, starting = false): PrimaryAction`
  - `decisionHint(counts): string | null`
  - `showSecondaryApproveAll(counts): boolean`
- Rules, in order:
  1. K = 0 → `Approve all {N}` in the primary slot, with test id `approve-all`. It is disabled when N = 0.
  2. `planOnly` → `Set up the agent to run this`.
  3. Live executor with `cua_driver` false → `Fix permissions to run`.
  4. `starting` → `Starting…` (disabled).
  5. No pending steps → `Approve & run`.
  6. Otherwise → `Run {K} approved, skip {M}`.
- Here N = approved + pending, K = approved, M = pending. Every non-`approve_all` kind uses test id `run-primary`. The secondary `Approve all {N}` (test id `approve-all`) shows only when K > 0 and M > 0, so the test ids are never duplicated.

- [ ] **Step 1: Write the failing test**

Create `app/tests/actionbar.test.mts`:

```ts
// Run: npm test. The primary button always says exactly what will run (track U4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionHint, primaryAction, showSecondaryApproveAll } from "../src/workspace/ActionBar.logic.ts";

const c = (approved: number, pending: number, removed = 0) => ({ approved, pending, removed });
const ok = { cua_driver: true, exec_mode: "live" };

test("nothing approved: the primary slot is Approve all N", () => {
  assert.deepEqual(primaryAction(c(0, 6), ok, false), { kind: "approve_all", label: "Approve all 6", disabled: false, testId: "approve-all" });
  assert.equal(primaryAction(c(0, 0, 3), ok, false).disabled, true);
  // K = 0 wins over plan-only and permissions: there is nothing to run yet.
  assert.equal(primaryAction(c(0, 2), { cua_driver: false, exec_mode: "live" }, true).kind, "approve_all");
});

test("plan-only, then missing permissions, then starting", () => {
  assert.equal(primaryAction(c(3, 0), ok, true).label, "Set up the agent to run this");
  assert.equal(primaryAction(c(3, 1), { cua_driver: false, exec_mode: "live" }, false).label, "Fix permissions to run");
  assert.equal(primaryAction(c(3, 0), { cua_driver: false, exec_mode: "simulated" }, false).label, "Approve & run");
  assert.deepEqual(primaryAction(c(3, 0), ok, false, true), { kind: "starting", label: "Starting…", disabled: true, testId: "run-primary" });
});

test("run labels say exactly what runs", () => {
  assert.deepEqual(primaryAction(c(3, 0, 1), ok, false), { kind: "run", label: "Approve & run", disabled: false, testId: "run-primary" });
  assert.deepEqual(primaryAction(c(3, 2), null, false), { kind: "skip_and_run", label: "Run 3 approved, skip 2", disabled: false, testId: "run-primary" });
});

test("hint and secondary button", () => {
  assert.equal(decisionHint(c(3, 0)), null);
  assert.equal(decisionHint(c(3, 1)), "1 step still needs a decision");
  assert.equal(decisionHint(c(3, 2)), "2 steps still need a decision");
  assert.equal(showSecondaryApproveAll(c(3, 2)), true);
  assert.equal(showSecondaryApproveAll(c(0, 2)), false);
  assert.equal(showSecondaryApproveAll(c(3, 0)), false);
});
```

Run: `cd app && npm test`
Expected: FAIL with `Cannot find module '../src/workspace/ActionBar.logic.ts'`.

- [ ] **Step 2: Implement**

Create `app/src/workspace/ActionBar.logic.ts`:

```ts
// What the review's primary button does and says (track U4). Type-only imports.
import type { Health } from "../api/types";
import type { Counts } from "../state/useSession";

export type PrimaryKind = "approve_all" | "run" | "skip_and_run" | "fix_permissions" | "setup" | "starting";
export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  disabled: boolean;
  testId: "approve-all" | "run-primary";
}

export function primaryAction(
  counts: Counts,
  health: Pick<Health, "cua_driver" | "exec_mode"> | null,
  planOnly: boolean,
  starting = false,
): PrimaryAction {
  const live = counts.approved + counts.pending;
  const run = (kind: PrimaryKind, label: string, disabled = false): PrimaryAction => ({ kind, label, disabled, testId: "run-primary" });
  if (counts.approved === 0) return { kind: "approve_all", label: `Approve all ${live}`, disabled: live === 0, testId: "approve-all" };
  if (planOnly) return run("setup", "Set up the agent to run this");
  if (health && health.exec_mode === "live" && !health.cua_driver) return run("fix_permissions", "Fix permissions to run");
  if (starting) return run("starting", "Starting…", true);
  if (counts.pending === 0) return run("run", "Approve & run");
  return run("skip_and_run", `Run ${counts.approved} approved, skip ${counts.pending}`);
}

export function decisionHint(counts: Counts): string | null {
  if (counts.pending === 0) return null;
  return `${counts.pending} ${counts.pending === 1 ? "step still needs" : "steps still need"} a decision`;
}

export const showSecondaryApproveAll = (counts: Counts): boolean => counts.approved > 0 && counts.pending > 0;
```

- [ ] **Step 3: Verify and commit**

Run: `cd app && npm run typecheck && npm test`
Expected: all pass (4 new tests).

```bash
git add app/src/workspace/ActionBar.logic.ts app/tests/actionbar.test.mts
git commit -m "review: primary action logic (labels say exactly what runs)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task U4-2: ReviewScreen, AxisPicker, StepList, ActionBar

**Files:**
- Modify: `app/src/workspace/ReviewScreen.tsx` (replace the stub)
- Create: `app/src/workspace/ReviewScreen.module.css`, `workspace/AxisPicker.tsx`, `workspace/AxisPicker.module.css`, `workspace/StepList.tsx`, `workspace/StepList.module.css`, `workspace/ActionBar.tsx`, `workspace/ActionBar.module.css`
- Test: `app/e2e/review.spec.ts`

**Interfaces:**
- Consumes: `ScreenProps` (C5), `BoundaryCanvasProps` (C6), `ComposerProps` (C6), `ChatThreadProps` (C6), `eventsToMessages`, `primaryAction`, and the session actions `revise`, `editStep`, `check`, `remove`, `restore`, `approveAll`, `run`, `skipUndecidedAndRun`, `select`, `setAxes`, `onPolygonChange`, `retryPlan`.
- Produces:
  - `ReviewScreen(props: ScreenProps)`, unchanged export (C6).
  - `AxisPicker({ dims, x, y, onChange })`.
  - `StepList({ session, hoveredId, onHover })`.
  - `ActionBar({ session, conn, openSetup })`.
- Test ids:
  - C8: `axis-x`, `axis-y`, `paper-toggle`, `step-row-{i}`, `step-approve-{i}`, `step-remove-{i}`, `step-edit-{i}`, `step-restore-{i}`, `approve-all`, `run-primary`, `decision-hint`.
  - Extras: `axis-x-info`, `axis-x-definition`, `axis-y-info`, `axis-y-definition`, `step-edit-title-{i}`, `step-edit-desc-{i}`, `step-edit-save-{i}`, `step-unapprove-{i}`, `run-error`, `planning-panel`.
  - Rows carry `data-status`.

- [ ] **Step 1: Write the failing e2e test**

Create `app/e2e/review.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_DIMENSIONS } from "../src/api/fixtures";

// Run: E2E_PORT=1434 npx playwright test e2e/review.spec.ts
const def = (key: string) => FIXTURE_DIMENSIONS.find((d) => d.key === key)!.definition;

async function toReview(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
}

test("axis picker shows the exact definition string from /dimensions", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("axis-x-info").hover();
  await expect(page.getByTestId("axis-x-definition")).toHaveText(def("action_uncertainty"));
  await page.getByTestId("axis-x").selectOption("verifiability");
  await page.getByTestId("axis-x-info").hover();
  await expect(page.getByTestId("axis-x-definition")).toHaveText(def("verifiability"));
  // Picking the other axis's dimension swaps the axes instead of plotting X against itself.
  await page.getByTestId("axis-x").selectOption("reversibility");
  await expect(page.getByTestId("axis-y")).toHaveValue("verifiability");
});

test("edit a step inline", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("step-edit-1").click();
  await page.getByTestId("step-edit-title-1").fill("Search for rackets under $80");
  await page.getByTestId("step-edit-save-1").click();
  await expect(page.getByTestId("step-row-1")).toContainText("Search for rackets under $80");
});

test("remove and undo", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("step-remove-6").click();
  await expect(page.getByTestId("step-row-6")).toHaveAttribute("data-status", "removed");
  await page.getByTestId("step-restore-6").click();
  await expect(page.getByTestId("step-row-6")).toHaveAttribute("data-status", "pending");
});

test("primary button walks Approve all → Run K, skip M → runs and records the skip", async ({ page }) => {
  await toReview(page);
  await expect(page.getByTestId("approve-all")).toHaveText("Approve all 6");
  await expect(page.getByTestId("run-primary")).toHaveCount(0);
  await page.getByTestId("step-approve-1").click();
  await page.getByTestId("step-approve-2").click();
  await expect(page.getByTestId("run-primary")).toHaveText("Run 2 approved, skip 4");
  await expect(page.getByTestId("decision-hint")).toHaveText("4 steps still need a decision");
  await expect(page.getByTestId("approve-all")).toHaveText("Approve all 6");
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-run-started")).toContainText("Plan approved: steps 1, 2 · skipped 3, 4, 5, 6", { timeout: 20_000 });
});

test("revise from chat", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("composer-input").fill("Only message the party group");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-revised")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-msg-user").nth(1)).toHaveText("Only message the party group");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
});

test("paper toggle switches to the source layout", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("paper-toggle").click();
  await expect(page.getByTestId("approve-run")).toBeVisible();
  await page.getByTestId("paper-exit").click();
  await expect(page.getByTestId("run-primary").or(page.getByTestId("approve-all"))).toBeVisible();
});
```

Run: `cd app && E2E_PORT=1434 npx playwright test e2e/review.spec.ts`
Expected: FAIL (`axis-x-info` not found).

- [ ] **Step 2: AxisPicker**

Create `app/src/workspace/AxisPicker.tsx`:

```tsx
import { useState } from "react";
import type { Dimension } from "../api/types";
import s from "./AxisPicker.module.css";

// Definitions render exactly as GET /dimensions returned them: they are the scorer's prompt.
export function AxisPicker({ dims, x, y, onChange }: { dims: Dimension[]; x: string; y: string; onChange: (x: string, y: string) => void }) {
  return (
    <div className={s.pickers}>
      <Axis axis="x" dims={dims} value={x} onPick={(v) => (v === y ? onChange(v, x) : onChange(v, y))} />
      <Axis axis="y" dims={dims} value={y} onPick={(v) => (v === x ? onChange(y, v) : onChange(x, v))} />
    </div>
  );
}

function Axis({ axis, dims, value, onPick }: { axis: "x" | "y"; dims: Dimension[]; value: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const d = dims.find((k) => k.key === value);
  return (
    <div className={s.sel}>
      <span className={s.k}>{axis.toUpperCase()}</span>
      <select className={s.select} data-testid={`axis-${axis}`} value={value} onChange={(e) => onPick(e.target.value)}>
        {dims.map((o) => (
          <option key={o.key} value={o.key}>{o.name}</option>
        ))}
      </select>
      <button type="button" className={s.info} data-testid={`axis-${axis}-info`} aria-label={`What ${d?.name ?? "this axis"} means`}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        i
      </button>
      {open && d && (
        <span role="tooltip" className={s.tip} data-testid={`axis-${axis}-definition`}>{d.definition}</span>
      )}
    </div>
  );
}
```

`app/src/workspace/AxisPicker.module.css`:

```css
.pickers { display: flex; gap: 8px; }
.sel { position: relative; display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); border-radius: var(--r-sm); padding: 3px 6px 3px 9px; }
.k { color: var(--text-3); font-size: var(--fs-xs); }
.select { background: transparent; border: none; outline: none; cursor: pointer; }
.info { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--text-3); background: none; color: var(--text-3); font-size: 9px; display: grid; place-items: center; cursor: help; padding: 0; }
.tip { position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; width: 280px; padding: 8px 10px; border-radius: var(--r-sm); background: var(--raised); border: 1px solid var(--line); box-shadow: var(--shadow); color: var(--text-2); font-size: var(--fs-sm); line-height: 1.4; }
```

- [ ] **Step 3: StepList**

Create `app/src/workspace/StepList.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Step, StepStatus } from "../api/types";
import type { Session } from "../state/useSession";
import s from "./StepList.module.css";

export function StepList({ session, hoveredId, onHover }: { session: Session; hoveredId: string | null; onHover: (id: string | null) => void }) {
  const { state, cls } = session;
  return (
    <div className={s.list} onMouseLeave={() => onHover(null)}>
      {state.steps.map((st) => (
        <Row key={st.id} step={st} status={cls.status[st.id] ?? "pending"} inside={cls.inside.has(st.id)} checked={state.checked.has(st.id)}
          selected={state.selectedId === st.id} hovered={hoveredId === st.id} session={session} onHover={onHover} />
      ))}
    </div>
  );
}

function Row(p: { step: Step; status: StepStatus; inside: boolean; checked: boolean; selected: boolean; hovered: boolean; session: Session; onHover: (id: string | null) => void }) {
  const { step: st, status, session } = p;
  const a = session.actions;
  const i = st.index;
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(st.title);
  const [desc, setDesc] = useState(st.description);

  useEffect(() => {
    if (p.selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.selected]);

  const save = async () => {
    await a.editStep(st.id, { title: title.trim(), description: desc.trim() });
    setEditing(false);
  };

  return (
    <div ref={ref} className={`${s.row} ${s[status]} ${p.selected ? s.selected : ""} ${p.hovered ? s.hovered : ""}`}
      data-testid={`step-row-${i}`} data-status={status} onMouseEnter={() => p.onHover(st.id)} onClick={() => a.select(st.id)}>
      <span className={s.num}>{i}</span>
      {editing ? (
        <div className={s.edit} onClick={(e) => e.stopPropagation()}>
          <input data-testid={`step-edit-title-${i}`} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea data-testid={`step-edit-desc-${i}`} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className={s.editBtns}>
            <button className={s.btnPri} data-testid={`step-edit-save-${i}`} disabled={!title.trim()} onClick={() => void save()}>Save</button>
            <button className={s.btn} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <span className={s.title} title={st.description}>{st.title}</span>
      )}
      {!editing && (
        <span className={s.acts} onClick={(e) => e.stopPropagation()}>
          {status === "pending" && (
            <button className={s.approve} data-testid={`step-approve-${i}`} onClick={() => a.check(st.id, true, "step_list")}>✓ Approve</button>
          )}
          {status === "approved" && p.checked && !p.inside && (
            <button className={s.link} data-testid={`step-unapprove-${i}`} onClick={() => a.check(st.id, false, "step_list")}>Unapprove</button>
          )}
          {status === "removed" ? (
            <button className={s.link} data-testid={`step-restore-${i}`} onClick={() => a.restore(st.id)}>Undo</button>
          ) : (
            <>
              <button className={s.icon} data-testid={`step-edit-${i}`} aria-label={`Edit step ${i}`}
                onClick={() => { setTitle(st.title); setDesc(st.description); setEditing(true); }}>✎</button>
              <button className={s.icon} data-testid={`step-remove-${i}`} aria-label={`Remove step ${i}`} onClick={() => a.remove(st.id, "step_list")}>⊘</button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
```

`app/src/workspace/StepList.module.css`:

```css
.list { display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow-y: auto; padding: 0 16px; }
.row { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: var(--r-sm); background: var(--surface); border: 1px solid var(--line); cursor: default; transition: border-color var(--dur) var(--ease); }
.hovered, .selected { border-color: var(--text-3); }
.selected { box-shadow: 0 0 0 1px var(--accent) inset; }
.num { width: 20px; height: 20px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: var(--accent-ink); }
.approved .num { background: var(--ok); }
.pending .num { background: var(--pend); }
.removed .num { background: transparent; border: 1px dashed var(--rm); color: var(--rm); }
.removed .title { text-decoration: line-through; color: var(--text-3); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acts { display: flex; gap: 8px; align-items: center; color: var(--text-3); }
.icon, .link, .approve { background: none; border: none; padding: 2px 4px; cursor: pointer; color: var(--text-3); }
.icon:hover, .link:hover { color: var(--text); }
.approve { color: var(--ok); }
.edit { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.edit input, .edit textarea { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; resize: vertical; }
.editBtns { display: flex; gap: 6px; }
.btn, .btnPri { border-radius: var(--r-pill); padding: 4px 11px; border: 1px solid var(--line); background: var(--raised); cursor: pointer; }
.btnPri { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
```

- [ ] **Step 4: ActionBar**

Create `app/src/workspace/ActionBar.tsx`:

```tsx
import type { ScreenProps } from "../screens";
import { decisionHint, primaryAction, showSecondaryApproveAll } from "./ActionBar.logic";
import s from "./ActionBar.module.css";

export function ActionBar({ session, conn, openSetup }: Pick<ScreenProps, "session" | "conn" | "openSetup">) {
  const { state, counts, actions } = session;
  const pa = primaryAction(counts, conn.health, !!conn.health?.plan_only, state.busy === "starting_run");
  const hint = decisionHint(counts);
  const live = counts.approved + counts.pending;
  const err = state.runError;
  const indexes = (ids: string[] = []) => ids.map((id) => state.steps.find((x) => x.id === id)?.index ?? id).join(", ");
  const onPrimary = () => {
    if (pa.kind === "approve_all") actions.approveAll();
    else if (pa.kind === "run") void actions.run();
    else if (pa.kind === "skip_and_run") void actions.skipUndecidedAndRun();
    else if (pa.kind === "fix_permissions") openSetup("permissions");
    else if (pa.kind === "setup") openSetup("driver");
  };
  return (
    <div className={s.bar}>
      {err && (
        <div className={s.error} role="alert" data-testid="run-error">
          <b>{err.status === 409 ? "Nothing ran." : `Run failed (${err.status || "network"}).`}</b> {err.error}
          {err.expected && <span className={s.mono}> expected [{indexes(err.expected)}] got [{indexes(err.got)}]</span>}
        </div>
      )}
      <div className={s.row}>
        {hint && <span className={s.hint} data-testid="decision-hint">{hint}</span>}
        <span className={s.spacer} />
        {showSecondaryApproveAll(counts) && (
          <button className={s.btn} data-testid="approve-all" onClick={actions.approveAll}>Approve all {live}</button>
        )}
        <button className={s.primary} data-testid={pa.testId} disabled={pa.disabled} onClick={onPrimary}>{pa.label}</button>
      </div>
    </div>
  );
}
```

`app/src/workspace/ActionBar.module.css`:

```css
.bar { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
.hint { color: var(--text-3); font-size: var(--fs-sm); }
.btn, .primary { border-radius: var(--r-pill); padding: 7px 14px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; }
.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
.primary:disabled { opacity: 0.5; cursor: default; }
.error { border: 1px solid var(--rm); background: var(--rm-soft); border-radius: var(--r-sm); padding: 8px 10px; font-size: var(--fs-sm); }
.mono { font-family: var(--mono); font-size: 11px; }
```

- [ ] **Step 5: ReviewScreen**

Replace `app/src/workspace/ReviewScreen.tsx`:

```tsx
// Review: chat left (revise by typing), workspace right (axes, canvas, steps, action bar).
import { useMemo, useState } from "react";
import type { CostPayload, OversightEvent, PlanProgressPayload } from "../api/types";
import { BoundaryCanvas } from "../canvas/BoundaryCanvas";
import { ChatThread } from "../chat/ChatThread";
import { eventsToMessages } from "../chat/eventsToMessages";
import { Composer } from "../home/Composer";
import { pairKey } from "../lib/approval";
import type { ScreenProps } from "../screens";
import { ActionBar } from "./ActionBar";
import { AxisPicker } from "./AxisPicker";
import s from "./ReviewScreen.module.css";
import { StepList } from "./StepList";

/** "model · planned + scored in 9.4s · $0.11", from the first planning session's events. */
function planMeta(events: OversightEvent[], model: string | null): string | null {
  let start: number | null = null;
  let end: number | null = null;
  let cost = 0;
  for (const e of events) {
    if (e.run_id !== null) continue;
    if (e.kind === "plan_progress") {
      const p = e.payload as unknown as PlanProgressPayload;
      if (start === null) start = Date.parse(e.ts);
      if (p.stage === "done" && end === null) end = Date.parse(e.ts);
    } else if (e.kind === "cost") cost = (e.payload as unknown as CostPayload).usd_total;
  }
  if (start === null || end === null) return null;
  return [model, `planned + scored in ${((end - start) / 1000).toFixed(1)}s`, `$${cost.toFixed(2)}`].filter(Boolean).join(" · ");
}

export function ReviewScreen(props: ScreenProps) {
  const { api, conn, session, setPaperView, openSetup } = props;
  const { state, cls, counts, idx, actions } = session;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const messages = useMemo(
    () => eventsToMessages({ prompt: state.prompt, attachments: state.attachments, steps: state.steps, events: state.events, planError: state.planError }),
    [state.prompt, state.attachments, state.steps, state.events, state.planError],
  );
  const meta = useMemo(() => planMeta(state.events, conn.health?.model ?? null), [state.events, conn.health?.model]);
  const progress = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--)
      if (state.events[i].kind === "plan_progress") return state.events[i].payload as unknown as PlanProgressPayload;
    return null;
  }, [state.events]);

  const xDim = conn.dims.find((d) => d.key === state.axes.x);
  const yDim = conn.dims.find((d) => d.key === state.axes.y);
  const reviewing = state.phase === "review";
  const disabledReason =
    state.phase === "planning" ? "Wait for the plan to finish." :
    state.busy === "revising" ? "Revising the plan…" :
    state.busy === "starting_run" ? "Starting the run…" : null;

  return (
    <div className={s.screen}>
      <section className={s.chat}>
        <ChatThread api={api} messages={messages} counts={reviewing ? counts : null} meta={meta} events={state.events}
          steps={state.steps} onRetryPlan={() => void actions.retryPlan()} />
        <div className={s.dock}>
          <Composer api={api} value={draft} onChange={setDraft} attachments={[]} onAttachmentsChange={() => undefined}
            allowAttachments={false} providerLabel={conn.health?.provider === "openai" ? "OpenAI" : "Anthropic"}
            placeholder="Reply, or ask me to change a step…" size="dock" disabledReason={disabledReason} running={false}
            onSend={() => { const t = draft; setDraft(""); void actions.revise(t); }} />
        </div>
      </section>

      <section className={s.workspace}>
        <header className={s.head}>
          <span className={s.title}>Plan review</span>
          {conn.dims.length > 0 && <AxisPicker dims={conn.dims} x={state.axes.x} y={state.axes.y} onChange={actions.setAxes} />}
          <div className={s.seg}>
            <button className={s.segOn} aria-pressed="true">Grid</button>
            <button data-testid="paper-toggle" onClick={() => setPaperView(true)}>Paper view</button>
          </div>
        </header>

        <div className={s.canvas}>
          {reviewing && xDim && yDim ? (
            <BoundaryCanvas steps={state.steps} idx={idx} xDim={xDim} yDim={yDim}
              polygon={state.polygons[pairKey(state.axes.x, state.axes.y)] ?? null} status={cls.status}
              selectedId={state.selectedId} hoveredId={hoveredId} onSelect={actions.select} onHover={setHoveredId}
              onPolygonChange={actions.onPolygonChange} onApprove={(id) => actions.check(id, true, "fan_out")}
              onRemove={(id) => actions.remove(id, "fan_out")} />
          ) : state.phase === "planning" && !state.planError ? (
            <div className={s.preparing} data-testid="planning-panel">
              <span className={s.spinner} />
              <div>
                <div className={s.prepTitle}>{progress?.stage === "scoring" ? "Preparing oversight view…" : "Planning…"}</div>
                <div className={s.prepSub}>Scoring actions and placing them on the grid.</div>
                {progress && progress.total > 0 && (
                  <div className={s.bar}><i style={{ width: `${(100 * progress.done) / progress.total}%` }} /></div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {reviewing && (
          <>
            <StepList session={session} hoveredId={hoveredId} onHover={setHoveredId} />
            <ActionBar session={session} conn={conn} openSetup={openSetup} />
          </>
        )}
      </section>
    </div>
  );
}
```

`app/src/workspace/ReviewScreen.module.css`:

```css
.screen { display: flex; height: 100%; min-height: 0; }
.chat { width: var(--chat-w); flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
.dock { padding: 12px 16px 16px; }
.workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.title { font-weight: 600; }
.seg { margin-left: auto; display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; font-size: var(--fs-xs); }
.seg button { border: none; background: none; padding: 3px 9px; border-radius: 6px; color: var(--text-3); cursor: pointer; }
.seg .segOn { background: var(--raised); color: var(--text); }
.canvas { flex: 1; min-height: 260px; margin: 12px 16px 10px; position: relative; }
.preparing { height: 100%; display: flex; align-items: center; justify-content: center; gap: 14px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); }
.spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.prepTitle { font-weight: 600; }
.prepSub { color: var(--text-3); font-size: var(--fs-sm); }
.bar { margin-top: 8px; width: 240px; height: 4px; border-radius: 2px; background: var(--raised); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--ok); transition: width var(--dur) var(--ease); }
```

- [ ] **Step 6: Run all checks**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1434 npx playwright test e2e/review.spec.ts e2e/smoke.spec.ts`
Expected: clean, `8 passed` (6 review + 2 smoke). Smoke still passes: with K = 0 the primary slot is `approve-all`, and once everything is approved the primary is `run-primary` reading "Approve & run".

- [ ] **Step 7: Commit**

```bash
git add app/src/workspace/ReviewScreen.tsx app/src/workspace/ReviewScreen.module.css app/src/workspace/AxisPicker.tsx app/src/workspace/AxisPicker.module.css app/src/workspace/StepList.tsx app/src/workspace/StepList.module.css app/src/workspace/ActionBar.tsx app/src/workspace/ActionBar.module.css app/e2e/review.spec.ts
git commit -m "review: chat-left workspace with axis picker, step list, and action bar" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- Global Constraints' hint string `{M} step(s) still need a decision` is implemented with pluralization ("1 step still needs…", "2 steps still need…"), as the mockup reads. If reviewers require the literal "(s)" form, change only `decisionHint`.
- `primaryAction` takes an optional 4th parameter, `starting`. This adds to the directive's 3-argument shape and doesn't break it.
- In plan-only mode the primary button opens setup at the `driver` step; for missing permissions it opens at `permissions`.
- The extra test ids listed under U4-2 Interfaces are additions, not changes to C8.
