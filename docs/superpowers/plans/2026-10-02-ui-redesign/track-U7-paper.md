# Track U7: Paper view polish and parity

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8), and Ownership matrix first. Spec sections: **Screens §5 Paper view**, **Decisions** (parity vs redesign). Wave 1, Batch B. E2E port **1437**.

**Goal:** Paper view is the source-video replica that the docs/04 parity checklist is evaluated against. This track makes sure its styles never leak into the Graphite UI, wires Re-propose and inline step editing (both were cut in the sprint build), places the Exit control inside the header, and walks the parity checklist item by item.

**Owns:** `app/src/paper/**`, `app/e2e/paper.spec.ts`. Nothing else.

---

### Task U7-1: Prove paper.css is scoped (no leakage either way)

**Files:**
- Test: `app/e2e/paper.spec.ts` (create)
- Modify (only if the test fails): `app/src/paper/paper.css`

**Interfaces:**
- Consumes: C8 ids `paper-exit`, `composer-input`; W0-3's `.paper-root` scoping; tokens from `app/src/theme/tokens.css` (`--bg` dark = `#141414`, `--accent` dark = `#9d8cff`).
- Produces: nothing new. This is a regression guard.

- [ ] **Step 1: Write the failing-or-passing leakage tests**

Create `app/e2e/paper.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

test.use({ colorScheme: "dark" });

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("paper.css scoping", () => {
  test("default view is pure Graphite", async ({ page }) => {
    await page.goto("/?mock");
    await expect(page.getByTestId("composer-input")).toBeVisible();
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
    expect(await page.locator(".paper-root").count()).toBe(0);
  });

  test("paper gradient lives only inside .paper-root, and exiting restores Graphite", async ({ page }) => {
    await page.goto("/?mock&paper");
    const root = page.locator(".paper-root").first();
    await expect(root).toBeVisible();
    const bgImage = await root.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toContain("linear-gradient");
    // body itself stays Graphite even while Paper is mounted
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    // paper's --accent (#2f7cf6) is defined on .paper-root, never on :root
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
    await page.getByTestId("paper-exit").click();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd app && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts -g "scoping"`
Expected: `2 passed`. If either fails, `paper.css` still contains a top-level `:root`, `html`, `body`, `#root` or `*` rule. Find it with:

```bash
cd app && grep -nE '^(:root|html|body|#root|\*)' src/paper/paper.css
```

Expected output after the fix: nothing. Move any such rule's declarations into the `.paper-root { … }` block, or delete it if `theme/base.css` already covers it (`box-sizing`, `height: 100%`, `margin: 0`). Re-run until `2 passed`.

- [ ] **Step 3: Commit**

```bash
git add app/e2e/paper.spec.ts app/src/paper/paper.css
git commit -m "paper: e2e guard that paper.css never leaks into the Graphite UI" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U7-2: Exit control in the header

**Files:**
- Modify: `app/src/paper/Header.tsx` (optional `right` slot)
- Modify: `app/src/paper/PaperView.tsx` (pass the exit button through the slot; remove the absolutely-positioned button)
- Modify: `app/src/paper/paper.css` (one rule)
- Test: `app/e2e/paper.spec.ts`

**Interfaces:**
- Consumes: `ScreenProps.setPaperView` (C5); test id `paper-exit` (C8).
- Produces: `Header` gains an optional prop `right?: React.ReactNode`. Existing props are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `app/e2e/paper.spec.ts`:

```ts
test("Exit Paper view sits in the header row, right-aligned, not over content", async ({ page }) => {
  await page.goto("/?mock&paper");
  const exit = page.getByTestId("paper-exit");
  await expect(exit).toBeVisible();
  const inHeader = await exit.evaluate((el) => !!el.closest("header.app-header"));
  expect(inHeader).toBe(true);
  const [eb, hb] = await Promise.all([exit.boundingBox(), page.locator("header.app-header h1").boundingBox()]);
  expect(eb!.x).toBeGreaterThan(hb!.x + hb!.width);
});
```

Run: `cd app && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts -g "Exit Paper"`
Expected: FAIL (`inHeader` is false).

- [ ] **Step 2: Add the slot to `Header`**

In `app/src/paper/Header.tsx`, add `import type { ReactNode } from "react";` and extend the `Header` props:

```tsx
export const Header = memo(function Header({
  health,
  mode,
  reachable,
  cost,
  right,
}: {
  health: Health | null;
  mode: "live" | "mock" | null;
  reachable: boolean;
  cost: number;
  right?: ReactNode;
}) {
```

Replace the `<h1>…</h1>` line with:

```tsx
      <div className="header-title-row">
        <h1>Reflexive Oversight - CUA Agent (cua-driver)</h1>
        {right && <div className="header-right">{right}</div>}
      </div>
```

Append to `app/src/paper/paper.css`:

```css
.header-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-title-row .header-right {
  margin-left: auto;
}
```

- [ ] **Step 3: Use it from `PaperView`**

In `app/src/paper/PaperView.tsx`, delete the `<button className="link-btn" data-testid="paper-exit" style={{ position: "absolute", … }}>…</button>` element. Replace the `<Header … />` line with:

```tsx
        <Header
          health={conn.health}
          mode={api.mode}
          reachable={conn.reachable}
          cost={cost}
          right={
            <button className="btn btn-small" data-testid="paper-exit" onClick={() => setPaperView(false)}>
              Exit Paper view
            </button>
          }
        />
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npm run typecheck && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/paper app/e2e/paper.spec.ts
git commit -m "paper: Exit Paper view moves into the header row" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U7-3: Re-propose in Paper view

docs/02 shows "⟳ Re-propose plan" in the footer. The planner already receives the user's decisions (approved, removed, edited), because the daemon reads them from the store (spec, Daemon API §2). Paper view has no instruction box, so it re-proposes with a fixed instruction string (see Contract notes).

**Files:**
- Modify: `app/src/paper/PaperView.tsx`
- Test: `app/e2e/paper.spec.ts`

**Interfaces:**
- Consumes: `session.actions.revise(instruction: string)` and `session.state.busy` (C5). Mock `repropose` (W0-2, deepened by U8) emits `plan_revised`.
- Produces: the enabled `repropose` button (existing Paper test id).

- [ ] **Step 1: Write the failing test**

Append to `app/e2e/paper.spec.ts`:

```ts
test("Re-propose plan is enabled in review and round-trips through the daemon", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  const btn = page.getByTestId("repropose");
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(btn).toHaveText(/Re-proposing/);
  await expect(btn).toHaveText(/Re-propose plan/, { timeout: 10_000 });
  await expect(page.getByTestId("step-card-1")).toBeVisible();
});
```

Run: `cd app && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts -g "Re-propose"`
Expected: FAIL (the button is disabled).

- [ ] **Step 2: Wire the button**

In `app/src/paper/PaperView.tsx`, add this module-level constant below the imports:

```tsx
// Paper has no instruction box (docs/02). The daemon already sends the planner every
// approve/remove/edit decision; this sentence only asks it to respect them.
const PAPER_REPROPOSE = "Re-propose the plan, keeping my approved steps and leaving out the ones I removed.";
```

Replace the disabled re-propose button with:

```tsx
                      <button
                        className="btn"
                        data-testid="repropose"
                        disabled={state.busy !== null}
                        onClick={() => void actions.revise(PAPER_REPROPOSE)}
                      >
                        {Icon.refresh(13)} {state.busy === "revising" ? "Re-proposing..." : "Re-propose plan"}
                      </button>
```

- [ ] **Step 3: Run the tests**

Run: `cd app && npm run typecheck && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/paper/PaperView.tsx app/e2e/paper.spec.ts
git commit -m "paper: Re-propose plan wired to session.revise" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U7-4: Inline step editing in PlanPanel

Parity checklist item: "Pencil opens inline editing of title and description" (docs/02 Plan panel).

**Files:**
- Modify: `app/src/paper/PlanPanel.tsx`, `app/src/paper/PaperView.tsx`, `app/src/paper/paper.css`
- Test: `app/e2e/paper.spec.ts`

**Interfaces:**
- Consumes: `session.actions.editStep(stepId, { title?, description? })` (C5); mock `editStep` (W0-2).
- Produces: `PlanPanel` gains a required prop `onEdit: (id: string, patch: { title?: string; description?: string }) => void`. New Paper-only test ids: `edit-{i}` (now on the button itself), `edit-title-{i}`, `edit-desc-{i}`, `edit-save-{i}`, `edit-cancel-{i}`.

- [ ] **Step 1: Write the failing test**

Append to `app/e2e/paper.spec.ts`:

```ts
test("pencil edits a step inline; Escape cancels; Save persists", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("step-card-2")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("edit-2").click();
  await page.getByTestId("edit-title-2").fill("Pick the cheapest racket");
  await page.getByTestId("edit-title-2").press("Escape");
  await expect(page.getByTestId("step-card-2")).not.toContainText("Pick the cheapest racket");
  await page.getByTestId("edit-2").click();
  await page.getByTestId("edit-title-2").fill("Pick the cheapest racket");
  await page.getByTestId("edit-desc-2").fill("Choose the lowest-priced option under $100.");
  await page.getByTestId("edit-save-2").click();
  await expect(page.getByTestId("step-card-2")).toContainText("Pick the cheapest racket");
  await expect(page.getByTestId("step-card-2")).toContainText("Choose the lowest-priced option under $100.");
});
```

Run: `cd app && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts -g "pencil"`
Expected: FAIL (the edit button is disabled).

- [ ] **Step 2: Implement inline editing in `PlanPanel.tsx`**

1. Change the React import to `import { memo, useEffect, useRef, useState } from "react";`.
2. Add `onEdit: (id: string, patch: { title?: string; description?: string }) => void;` to `interface Props`.
3. Pass `onEdit={p.onEdit}` to each `<StepCard … />`.
4. Add `onEdit` to `StepCard`'s destructured props and to its prop type, with the same signature.
5. Inside `StepCard`, after `const removed = st === "removed";`, add:

```tsx
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(step.title);
  const [desc, setDesc] = useState(step.description);
  const begin = () => {
    setTitle(step.title);
    setDesc(step.description);
    setEditing(true);
  };
  const save = () => {
    const patch: { title?: string; description?: string } = {};
    if (title.trim() && title.trim() !== step.title) patch.title = title.trim();
    if (desc.trim() && desc.trim() !== step.description) patch.description = desc.trim();
    if (patch.title || patch.description) onEdit(step.id, patch);
    setEditing(false);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setEditing(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  };
```

6. Replace the `<div className="card-title-row">…</div>` and `<div className="card-desc">…</div>` with:

```tsx
        {editing ? (
          <div className="edit-box" onClick={(e) => e.stopPropagation()}>
            <input
              className="edit-title"
              data-testid={`edit-title-${step.index}`}
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={keys}
              aria-label={`Title of step ${step.index}`}
            />
            <textarea
              className="edit-desc"
              data-testid={`edit-desc-${step.index}`}
              value={desc}
              rows={3}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={keys}
              aria-label={`Description of step ${step.index}`}
            />
            <div className="edit-actions">
              <button className="btn btn-small" data-testid={`edit-cancel-${step.index}`} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn btn-small btn-primary" data-testid={`edit-save-${step.index}`} onClick={save}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card-title-row">
              <GlyphIcon glyph={String(step.glyph)} size={13} className="card-glyph" />
              <span className="card-title">
                <span className="card-index">{step.index}.</span> {step.title}
              </span>
              {!removed && inside && !checked && <span className="tag tag-inside">In boundary</span>}
            </div>
            <div className="card-desc">{step.description}</div>
          </>
        )}
```

7. Replace the disabled pencil `<span title="Editing is cut for the sprint" …>…</span>` with:

```tsx
            <button
              className="icon-btn"
              data-testid={`edit-${step.index}`}
              title="Edit this step"
              aria-label={`Edit step ${step.index}`}
              onClick={begin}
              disabled={editing}
            >
              {Icon.pencil(12)}
            </button>
```

Append to `app/src/paper/paper.css`:

```css
.edit-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit-box .edit-title,
.edit-box .edit-desc {
  width: 100%;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 7px;
  color: var(--text);
  font: inherit;
  user-select: text;
  -webkit-user-select: text;
}
.edit-box .edit-title {
  font-weight: 600;
}
.edit-box .edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
```

- [ ] **Step 3: Pass `onEdit` from `PaperView`**

In the `<PlanPanel … />` element in `app/src/paper/PaperView.tsx`, add:

```tsx
                      onEdit={(id, patch) => void actions.editStep(id, patch)}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && npm run typecheck && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/paper app/e2e/paper.spec.ts
git commit -m "paper: inline step editing (pencil) via session.editStep" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U7-5: Paper flow e2e (the gesture, removals, preserved indices)

**Files:**
- Test: `app/e2e/paper.spec.ts`

**Interfaces:**
- Consumes: the existing Paper test ids (`boundary-canvas`, `badge-{i}` with `data-status`, `count-approved`, `select-all`, `remove-{i}`, `undo-{i}`, `step-card-{i}` with `data-status`, `approve-run`, `execution-view`, `progress-{i}`, `removed-action`); the Paper canvas margins `{left: 40, right: 14, top: 14, bottom: 38}` (`app/src/paper/BoundaryCanvas.tsx`).
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

Append to `app/e2e/paper.spec.ts`:

```ts
async function center(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Freehand loop around the given badge centers: a padded triangle traced in small steps. */
async function loopAround(page: Page, pts: { x: number; y: number }[], pad = 34, release = true) {
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const ring = pts
    .map((p) => {
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / d) * pad, y: p.y + (dy / d) * pad };
    })
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i - 1], b = ring[i % ring.length];
    for (let k = 1; k <= 12; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / 12, a.y + ((b.y - a.y) * k) / 12);
  }
  if (release) await page.mouse.up();
}

test.describe("paper flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mock&paper");
    await page.getByTestId("generate-plan").click();
    await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  });

  test("drawing a loop reclassifies live, before release", async ({ page }) => {
    const pts = [await center(page, "badge-1"), await center(page, "badge-2"), await center(page, "badge-4")];
    await loopAround(page, pts, 34, false);
    // still holding the mouse: classification already happened
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`badge-${i}`)).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("count-approved")).toContainText("3");
    await page.mouse.up();
    await expect(page.getByTestId("boundary-handle").first()).toBeVisible();
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`badge-${i}`)).toHaveAttribute("data-status", "approved");
  });

  test("Select All approves every step and enables Approve & Run", async ({ page }) => {
    await expect(page.getByTestId("approve-run")).toBeDisabled();
    await page.getByTestId("select-all").click();
    for (const i of [1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`step-card-${i}`)).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("approve-run")).toBeEnabled();
  });

  test("removed step is struck through with the verbatim label, and Undo restores it", async ({ page }) => {
    await page.getByTestId("remove-3").click();
    const card = page.getByTestId("step-card-3");
    await expect(card).toHaveAttribute("data-status", "removed");
    await expect(card).toContainText("Removed by oversight - excluded");
    const deco = await card.locator(".card-title").evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(deco).toContain("line-through");
    await page.getByTestId("undo-3").click();
    await expect(card).toHaveAttribute("data-status", "pending");
  });

  test("run view keeps original indices 1, 2, 4 and lists removed actions", async ({ page }) => {
    const pts = [await center(page, "badge-1"), await center(page, "badge-2"), await center(page, "badge-4")];
    await loopAround(page, pts);
    for (const i of [3, 5, 6]) await page.getByTestId(`remove-${i}`).click();
    await expect(page.getByTestId("approve-run")).toBeEnabled();
    await page.getByTestId("approve-run").click();
    await expect(page.getByTestId("execution-view")).toBeVisible({ timeout: 10_000 });
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`progress-${i}`)).toBeVisible();
    for (const i of [3, 5, 6]) await expect(page.getByTestId(`progress-${i}`)).toHaveCount(0);
    await expect(page.getByTestId("removed-action")).toBeVisible();
    await expect(page.getByTestId("final-result")).toContainText("All approved steps were attempted.", { timeout: 45_000 });
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd app && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts`
Expected: all pass. If "drawing a loop" fails because badge 3 or 5 also turns approved, the padded triangle swallowed a neighbour. Lower `pad` to `24` in that test only (badge radius is 13, so 24 still encloses each target badge's true point), then re-run.

- [ ] **Step 3: Commit**

```bash
git add app/e2e/paper.spec.ts
git commit -m "paper: e2e for live reclassification, Select All, removal + Undo, preserved indices" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U7-6: Walk the docs/04 parity checklist against Paper view

The checklist results go **in the commit message body only**. Don't create a results file.

**Files:**
- None modified, unless an item fails and its fix lies inside `app/src/paper/**`. A failure outside `paper/` is reported, not fixed.

**Interfaces:**
- Consumes: everything above, run against `/?mock&paper` and (for the live rows) the real daemon.

- [ ] **Step 1: Run the automated part**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1437 npx playwright test e2e/paper.spec.ts e2e/smoke.spec.ts`
Expected: all pass.

- [ ] **Step 2: Walk each item and mark it**

Start the app: `cd app && npx vite --port 1437 --strictPort`, then open `http://localhost:1437/?mock&paper`. For every row below, record PASS, FAIL, or N/A with a few words of evidence:

| # | docs/04 item | How to verify | Expected |
|---|---|---|---|
| 1 | Window, header, status pills, status line | Look at the header; check `pill-daemon`, `pill-api-key`, `model`, `status-line` | PASS; the title reads "Reflexive Oversight - CUA Agent (cua-driver)" |
| 2 | Plan Review / Impact tabs | Tabs row; Impact disabled | PASS (Impact is a stub per docs/04) |
| 3 | Task boundary card + Generate plan | `task-input` editable on idle; `generate-plan` | PASS |
| 4 | Planning, then "Preparing oversight view / Scoring actions…" | Click Generate and watch `planning-panel` | PASS |
| 5 | Planner emits 4–8 steps | Count `step-card-*` | PASS (6 in fixtures) |
| 6 | Ten dimensions scored per step | Hover a badge: `badge-tooltip` shows labels and rationales | PASS |
| 7 | X/Y dropdowns over all ten | Open each select; count 10 options | PASS |
| 8 | Definition under each selector | `x-axis-definition` / `y-axis-definition` match `GET /dimensions` text | PASS |
| 9 | "Viewing through: X × Y" | `viewing-through` | PASS |
| 10 | Badges at scored positions, glyph inside, three colors | Visual + `data-status` | PASS |
| 11 | Freehand → closed polygon with handles | U7-5 test 1 | PASS |
| 12 | Double-click edge inserts a handle | Double-click an edge; `boundary-handle` count +1 | PASS |
| 13 | Clear removes the boundary | `clear-boundary`; all badges back to pending | PASS |
| 14 | Live reclassification during drag | U7-5 test 1 (asserted before `mouse.up`) | PASS |
| 15 | Counts update live | `count-approved` during drag | PASS |
| 16 | Legend | Below the grid | PASS |
| 17 | Select All, checkbox, pencil, circled X | U7-5 test 2, U7-4 | PASS |
| 18 | Inline step editing | U7-4 test | PASS |
| 19 | Removed: struck through, "Removed by oversight - excluded", Undo | U7-5 test 3 | PASS |
| 20 | Checkbox and polygon reconcile into one set | Check step 3 while a loop holds 1, 2, 4 → 4 approved | PASS |
| 21 | Start over / Re-propose / Approve & Run | `start-over`, `repropose` (U7-3), `approve-run` | PASS |
| 22 | Approve & Run disabled until none pending, verbatim hint | Hint text "Select all actions (draw a region or check them) to enable Approve & Run." | PASS |
| 23 | Re-propose sends decisions and revises | U7-3 against the mock; against the real daemon after D3 merges | PASS (mock) / verify live in W2 |
| 24 | Execution drives cua-driver on the real desktop | Real daemon in live mode with grants | N/A until BLOCKERS.md permissions are granted |
| 25 | Plan progress with preserved indices | U7-5 test 4 | PASS |
| 26 | Live log: executing, elapsed, cost, considered, per-step | Open `log-toggle`; check `log-list` entries | PASS |
| 27 | Removed action block + "Task continued with" | `removed-action` | PASS |
| 28 | Final result block | `final-result` | PASS |
| 29 | "Why this mattered" verdicts | `why-this-mattered` with `why-item` rows | PASS |
| 30 | "Boundary candidate" | n/a | N/A: out of scope per the redesign spec |
| 31 | New task | `new-task` in the execution view returns to idle | PASS |

Any FAIL whose fix lies inside `app/src/paper/**`: fix it, add a test to `paper.spec.ts` that pins it, and re-run Step 1. Any FAIL elsewhere: don't fix it. List it as `OUT-OF-TRACK FAIL: <item> <evidence>` in the report.

- [ ] **Step 3: Commit the checklist result**

```bash
git commit --allow-empty -m "paper: parity checklist walked against Paper view" \
  -m "$(cat <<'EOF'
Parity (docs/04) on Paper view, mock daemon:
<paste the 31 rows as "N. item: PASS|FAIL|N/A - evidence", one per line>
EOF
)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

The angle-bracket line is filled in at execution time from Step 2's observations. It's the only content written then.

---

## Contract notes

- `SessionActions.revise(instruction: string)` returns early on an empty string (W0-3), so Paper's prompt-less re-propose sends the fixed `PAPER_REPROPOSE` sentence instead of `null`. No contract change is needed. If the orchestrator prefers a true `null`, that needs `revise(instruction: string | null)` in C5.
- `PlanPanel` gains a required `onEdit` prop. It is Paper-internal, not a C6 export, so it is within U7's ownership.
