# Track W2: Integration, docs, final review (W2-1, W2-2, W2-3)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. These run sequentially on `ui-redesign` after every Wave 1 track has merged. E2E port **1439**. Spec sections: **Testing**, **Build order** (all six gates).

W2-1 may edit any file to fix a cross-track integration bug, including the frozen `App.tsx`, `screens.ts`, and `playwright.config.ts`. Each fix gets its own commit whose message names the tracks involved: `integration: <fix> (U4×U3)`.

---

### Task W2-1: Full-flow e2e, feel check, daemon-backed smoke

**Files:**
- Create: `app/e2e/flow.spec.ts`, `app/e2e/feel.spec.ts`, `app/e2e/daemon.spec.ts`
- Modify: `app/playwright.config.ts` (real-daemon mode via `E2E_DAEMON_URL`)
- Modify (only if missing after U8): `app/src/api/mock.ts` (`?many=N`, `?fast`)
- Modify: any file, for documented integration fixes

**Interfaces:**
- Consumes: every C8 test id; the mock flags and `window.__oversightMock` (U8); `POST /setup/complete` (D1); `oversight-daemon --fixtures --port`.
- Produces: the green end-to-end gates 1, 2, 3, and 5.

- [ ] **Step 1: Check that U8's flags exist**

Run: `cd app && grep -c 'q.has("many")\|q.has("fast")' src/api/mock.ts`
Expected: `2`. If the output is lower, add the `MODE`, `ms()`, and `?many` code exactly as written in track-U8, Task U8-1, Step 3, and commit it as `integration: mock ?many/?fast (U8 gap)`.

- [ ] **Step 2: Write the full-flow spec**

Create `app/e2e/flow.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

test.use({ colorScheme: "dark" });

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function center(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function loop(page: Page, pts: { x: number; y: number }[], pad = 30) {
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const ring = pts
    .map((p) => { const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / d) * pad, y: p.y + (dy / d) * pad }; })
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i - 1], b = ring[i % ring.length];
    for (let k = 1; k <= 12; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / 12, a.y + ((b.y - a.y) * k) / 12);
  }
  await page.mouse.up();
}

test("gate 1+3+5: attach → plan → revise → zoom/pan → loop → skip undecided → narrated run → recap → replay", async ({ page }) => {
  await page.goto("/?mock&fast");
  // Home: attach an image
  await page.getByTestId("composer-file").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100 and draft a WhatsApp message");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-plan-ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-msg-user")).toBeVisible();

  // Revise from chat
  await page.getByTestId("composer-input").fill("only message the party group");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-revised")).toBeVisible({ timeout: 10_000 });

  // Zoom in twice, pan, back to draw, fit
  const label = page.getByTestId("canvas-zoom-label");
  const z0 = await label.textContent();
  await page.getByTestId("canvas-zoom-in").click();
  await page.getByTestId("canvas-zoom-in").click();
  await expect(label).not.toHaveText(z0!);
  await page.getByTestId("canvas-tool-pan").click();
  const c = await center(page, "boundary-canvas");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("canvas-tool-draw").click();
  await page.getByTestId("canvas-fit").click();

  // Loop around 1 and 2 → approved; leave others undecided
  await loop(page, [await center(page, "badge-1"), await center(page, "badge-2")]);
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "approved");
  const primary = page.getByTestId("run-primary");
  await expect(primary).toHaveText(/^Run \d+ approved, skip \d+/);
  await primary.click();

  // Narrated run ending in a recap
  await expect(page.getByTestId("chat-msg-step").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("desk-frame")).toBeVisible();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 45_000 });
  const live = await page.getByTestId("chat-thread").innerText();

  // History reopen replays the identical chat
  await page.getByTestId("new-task").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.getByTestId("history-item").first().click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 10_000 });
  expect(await page.getByTestId("chat-thread").innerText()).toBe(live);
});

test("gate 2: tied badges stack; fan-out approves one member", async ({ page }) => {
  await page.goto("/?mock&fast&many=30");
  await page.getByTestId("composer-input").fill("crowd");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  const stack = page.getByTestId("stack-badge").first();
  await expect(stack).toBeVisible();
  await stack.click();
  await expect(page.getByTestId("fan-out")).toBeVisible();
  const approve = page.locator('[data-testid^="fan-approve-"]').first();
  const i = (await approve.getAttribute("data-testid"))!.replace("fan-approve-", "");
  await approve.click();
  await expect(page.getByTestId(`step-row-${i}`)).toContainText(/approved/i);
});
```

If the step row shows status by a `data-status` attribute instead of text, assert `toHaveAttribute("data-status", "approved")`. That's the only permitted adaptation.

- [ ] **Step 3: Write the feel spec**

Create `app/e2e/feel.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// pointermove → next rAF, measured in-page. Gate: p95 < 16 ms with 30 badges.
async function arm(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__lat = [];
    const svg = document.querySelector('[data-testid="boundary-canvas"]')!;
    svg.addEventListener("pointermove", () => {
      const t0 = performance.now();
      requestAnimationFrame(() => w.__lat.push(performance.now() - t0));
    }, { capture: true });
  });
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

test("handle drag and pan stay under one frame with 30 badges", async ({ page }) => {
  await page.goto("/?mock&fast&many=30");
  await page.getByTestId("composer-input").fill("crowd");
  await page.getByTestId("composer-send").click();
  const svg = page.getByTestId("boundary-canvas");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  const b = (await svg.boundingBox())!;
  // draw a loop in the middle
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = Math.min(b.width, b.height) / 4;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let k = 1; k <= 48; k++) await page.mouse.move(cx + r * Math.cos((k / 48) * 2 * Math.PI), cy + r * Math.sin((k / 48) * 2 * Math.PI));
  await page.mouse.up();
  await arm(page);
  // handle drag
  const h = (await page.getByTestId("boundary-handle").first().boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 80, h.y + 40, { steps: 60 });
  await page.mouse.up();
  // pan
  await page.getByTestId("canvas-tool-pan").click();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy - 60, { steps: 60 });
  await page.mouse.up();
  const lat: number[] = await page.evaluate(() => (window as any).__lat);
  expect(lat.length).toBeGreaterThan(100);
  console.log(`feel p95=${p95(lat).toFixed(2)}ms n=${lat.length}`);
  expect(p95(lat)).toBeLessThan(16);
});
```

- [ ] **Step 4: Real-daemon mode in the Playwright config, plus the daemon smoke**

In `app/playwright.config.ts`, replace the `env: { VITE_MOCK: "1" },` line with:

```ts
    env: process.env.E2E_DAEMON_URL ? { VITE_DAEMON_URL: process.env.E2E_DAEMON_URL } : { VITE_MOCK: "1" },
```

Create `app/e2e/daemon.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.skip(!process.env.E2E_DAEMON_URL, "needs E2E_DAEMON_URL (real fixtures daemon)");

test("real fixtures daemon: home → plan → approve all → run → recap", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("composer-input").fill("Help me find a tennis racket less than $100 for my friends birthday present, and prepare a short message to my other friends to let them know I am planning a party via whatsapp.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-msg-step").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 120_000 });
});
```

- [ ] **Step 5: Run everything**

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
(cd daemon && uv run pytest -q)
(cd app && npm run typecheck && npm test && E2E_PORT=1439 npx playwright test)
D=$(mktemp -d); (cd daemon && OVERSIGHT_DATA_DIR="$D" uv run oversight-daemon --fixtures --port 8799 > "$D/daemon.log" 2>&1 &)
for i in $(seq 1 30); do curl -sf 127.0.0.1:8799/health >/dev/null && break; sleep 1; done
curl -sf -X POST 127.0.0.1:8799/setup/complete -H 'content-type: application/json' -d '{}'
(cd app && E2E_PORT=1439 E2E_DAEMON_URL=http://127.0.0.1:8799 npx playwright test e2e/daemon.spec.ts)
pkill -f "oversight-daemon --fixtures --port 8799"
```

Expected:
- pytest all pass.
- Playwright all pass, with `daemon.spec.ts` skipped in the mock run and `feel p95=<16ms` logged.
- The daemon run prints `1 passed`, and `/setup/complete` returns `{"ok":true}`.

For each failure: find the owning track from the matrix and fix it at the seam. Commit each fix separately as `integration: <what> (<tracks>)`, with the two attribution lines.

- [ ] **Step 6: Commit the specs**

```bash
git add app/e2e/flow.spec.ts app/e2e/feel.spec.ts app/e2e/daemon.spec.ts app/playwright.config.ts
git commit -m "integration: full-flow, feel and real-daemon e2e" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task W2-1b: Cross-track checks from Contract notes

**Files:**
- Create: `app/e2e/fixlink.spec.ts`

- [ ] **Step 1: Write the test that a Fix link opens the wizard at the right step**

```ts
import { expect, test } from "@playwright/test";

// U1 note: a health-pill "Fix" link must open SetupWizard at the matching initialStep.
test("health pill Fix opens the wizard at the permissions step", async ({ page }) => {
  await page.goto("/?mock&setup");
  await page.getByTestId("setup-skip-plan-only").click(); // plan-only: setup completes, cua_driver still false
  await expect(page.getByTestId("health-pill")).toBeVisible();
  await page.getByTestId("health-pill").getByRole("button", { name: /fix/i }).click();
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await expect(page.locator("[data-testid^='setup-step-'][aria-current='step']")).toHaveAttribute("data-testid", /setup-step-(driver|permissions)/);
});
```

Run: `cd app && E2E_PORT=1439 npx playwright test e2e/fixlink.spec.ts`
Expected: PASS. If the skip button sits on a later wizard step, click `setup-next` until `setup-skip-plan-only` is visible. U6 shows that button from the driver step onward.

- [ ] **Step 2: Do the manual cold-start check (R1 note)**

On a machine or clone where `daemon/.venv` doesn't exist yet: `rm -rf daemon/.venv`, then launch `npm run tauri dev` with the repo-local Rust env (Global Constraints). Expected:
- The splash shows "Starting…" while `uv sync` runs.
- The app never shows mock data.
- It reaches Home, or shows "The daemon won't start" with the log tail.

Record the time to Home in the W2-3 checklist.

- [ ] **Step 3: Commit**

```bash
git add app/e2e/fixlink.spec.ts
git commit -m "e2e: health pill Fix opens the wizard at the right step" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

### Task W2-2: Docs

**Files:** `CLAUDE.md`, `docs/02-ui-spec.md`, `RUNNING.md`, `BLOCKERS.md`

- [ ] **Step 1: CLAUDE.md records decision C**

Under `## Non-negotiables`, replace the **Parity before improvement.** paragraph with:

```markdown
**Parity before improvement, now in Paper view.** As of 2026-10-02 the default UI is
the chat-first redesign (`docs/superpowers/specs/2026-10-02-ui-redesign-design.md`),
chosen after Kyzyl's review of the sprint build. The source-video layout lives on as
**Paper view** (`app/src/paper/`, toggle in the workspace header or `?paper`), and the
parity checklist in `docs/04-build-plan.md` is evaluated against Paper view. The
boundary gesture, live reclassification, the ten dimensions, and the approved-only
executor are unchanged in both views.
```

In the `## Stack` table, change the App row to `Tauri 2 + React + TypeScript; the Rust shell launches and supervises the daemon`.

- [ ] **Step 2: docs/02 header**

Insert after the `# 02. UI spec` line:

```markdown
> **This is the Paper view spec.** The default UI is the chat-first redesign in
> `docs/superpowers/specs/2026-10-02-ui-redesign-design.md`. This document defines
> Paper view (`app/src/paper/`), the source-video replica that the docs/04 parity
> checklist is evaluated against.
```

- [ ] **Step 3: RUNNING.md**

Insert a new section `## 0. Quick start (redesign)` before `## 1. Prerequisites`:

````markdown
## 0. Quick start (redesign)

```sh
(cd daemon && uv sync) && (cd app && npm install)
cd app && npm run tauri dev     # the app starts and supervises the daemon itself
```

First launch opens the setup wizard: model key (stored in the OS keychain), cua-driver,
the two macOS permissions (Open Settings buttons, they turn green by themselves), and a
self-test. "Skip, plan-only mode" lets you plan and draw without granting anything.

Browser-only development, no Rust: `cd app && npm run dev:mock`, then open
`http://localhost:1420/?mock`. Mock flags: `?fast`, `?setup`, `?nonmac`, `?down=1`,
`?many=30`, `?paper`.

Tests: `cd daemon && uv run pytest -q`; `cd app && npm test && npx playwright test`
(set `E2E_PORT` per worktree; see the plan's E2E port table). Real-daemon e2e:
`E2E_DAEMON_URL=http://127.0.0.1:8799 npx playwright test e2e/daemon.spec.ts`, with a
`--fixtures` daemon on port 8799.
````

In the existing section 2, add one line: `The Tauri app starts the daemon for you. Start it by hand only for browser-only development or to pass flags such as --fixtures or --exec simulated.`

- [ ] **Step 4: BLOCKERS.md**

Run: `~/.local/bin/cua-driver permissions status`
- If both are granted, append `## [W2-2] 2026-10-02: permissions granted; live run unblocked` and the output.
- If not, append `## [W2-2] permissions still pending`, stating that the setup wizard's Permissions step is now the fix path, with the status output.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/02-ui-spec.md RUNNING.md BLOCKERS.md
git commit -m "docs: record decision C (redesign + Paper view), quick start, blockers" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task W2-3: Whole-branch review and human gate

**Files:** none, unless the review finds a defect. Fixes are committed as `review: <fix>`.

- [ ] **Step 1: Mechanical checks** (run each command; every expectation must hold)

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
# approval logic untouched
git diff --stat main...ui-redesign -- app/src/lib/approval.ts daemon/oversight/approval.py      # expect: empty
# approved-only assertion untouched
uv run --project daemon python - <<'EOF'
import ast, subprocess
def fns(src):
    t = ast.parse(src); return {n.name: ast.dump(n) for n in t.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in ("assert_all_approved", "assert_step_approved", "UnapprovedStepError")}
old = fns(subprocess.check_output(["git", "show", "main:daemon/oversight/executor.py"], text=True))
new = fns(open("daemon/oversight/executor.py").read())
assert old == new and len(old) == 3, "executor approval assertions changed"
print("executor assertions identical")
EOF
# assert call sites still present in run_steps
grep -c "assert_step_approved(step, approved_ids)" daemon/oversight/executor.py                  # expect: >= 1
# dependencies: only the allowed additions
git diff main...ui-redesign -- app/package.json daemon/pyproject.toml app/src-tauri/Cargo.toml | grep '^+' | grep -v '^+++'
#   expect only: @playwright/test, "e2e" script, keyring, python-multipart, serde, serde_json
# copy strings
for s in "What should the agent do?" "Approve & run" "approved, skip" "Fix permissions to run" "Set up the agent to run this" "still need a decision" "Drag a loop to approve · pinch or ⌘-scroll to zoom · two-finger drag or space-drag to pan" "with your task." "only this window is visible to the model" "Skip, plan-only mode"; do
  printf '%-60s %s\n' "$s" "$(grep -rlF -- "$s" app/src | wc -l | tr -d ' ')"; done                 # expect: every count >= 1
# no fetch() outside api/
grep -rn "fetch(" app/src --include=*.ts --include=*.tsx | grep -v "app/src/api/"                  # expect: empty
# CSS: new components use modules; globals only in theme/ and paper/
git diff --name-only main...ui-redesign -- 'app/src/**/*.css' | grep -v -E 'module\.css$|^app/src/theme/|^app/src/paper/'   # expect: empty
# full suites
(cd daemon && uv run pytest -q) && (cd app && npm run typecheck && npm test && E2E_PORT=1439 npx playwright test)
```

- [ ] **Step 2: Ownership audit**

```bash
for b in $(git branch --list 'rd/*' --format='%(refname:short)'); do
  echo "== $b"; git diff --name-only "$(git merge-base ui-redesign "$b")" "$b"; done
```

Compare each list against the master plan's ownership matrix. Record any file a track touched outside its Owns list, with the reason it was accepted at merge time.

- [ ] **Step 3: Code review**

Invoke `superpowers:requesting-code-review` on `main...ui-redesign`, focusing on the master plan's Review Focus list (all five items). Fix every confirmed issue with a `review:` commit and re-run Step 1.

- [ ] **Step 4: Human gate** (a person who did not build this; time it)

1. Fresh clone, or `git worktree add /tmp/gate ui-redesign`. Do not reuse `daemon/.data`: `export OVERSIGHT_DATA_DIR=$(mktemp -d)`.
2. `(cd daemon && uv sync) && (cd app && npm install)`. Install time doesn't count.
3. **Start the timer.** `cd app && npm run tauri dev` (with the repo-local Rust env from RUNNING.md).
4. The wizard appears. The tester follows only on-screen text: key, cua-driver, permissions (or **Skip, plan-only mode**), self-test.
5. On the home screen, type `Find a tennis racket under $100 for a birthday present` and press Enter.
6. **Stop the timer** when the boundary canvas shows badges.

Pass: under 2 minutes, with no terminal commands after step 3 and no help from the builder. Record the time, any hesitation points, and pass or fail in the final report. On a fail, file each hesitation point against its track (U6 wizard copy, U1 home, R1 startup).

- [ ] **Step 5: Final report** (no commit)

Report:
- Gates 1–6, each pass or fail with evidence.
- The feel p95.
- The human-gate time.
- Any ownership exceptions.
- Remaining blockers from BLOCKERS.md.
