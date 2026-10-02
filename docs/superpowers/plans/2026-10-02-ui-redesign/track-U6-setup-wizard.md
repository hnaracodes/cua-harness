# Track U6: First-run setup wizard

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read Global Constraints, Contracts C1 to C8, the Ownership matrix, and the E2E port table first. Spec: **Screens §4 (First-run setup)** and the **Error handling** table. Mockup: `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/4-home-run-setup.html` (bottom). Wave 1, Batch B. Worktree `.worktrees/rd-U6`, branch `rd/U6`. E2E port **1436**.

**Owns:** `app/src/setup/**`, `app/tests/u6-setup.test.mts`, `app/e2e/setup.spec.ts`. The export `SetupWizard({ api, initialStep?, onClose })` keeps its C6 signature. The setup test ids listed in C8 are kept exactly.

**Mock dependency (track U8): `?setup` mode.**
- `setupStatus()` starts incomplete: `key.present=false`, `driver.installed=true`, `driver.running=false`, both permissions `"unknown"`, `self_test.passed_at=null`, `complete=false`.
- `health().setup_complete` mirrors that `complete` flag.
- `setKey` sets `key.present` and `key.tested` to true.
- `startDriver` sets `running=true`.
- `installDriver` sets `installed=true`.
- `openPermission(w)` flips that permission to `"granted"` after about 1.5 s.
- `selfTest` sets `passed_at`.
- `completeSetup` sets `complete=true`.
- `putSettings({plan_only})` sets `plan_only`.

---

### Task U6-1: Step gating (pure)

**Files:** Create `app/src/setup/gating.ts`. Test: `app/tests/u6-setup.test.mts`.

**Interfaces:**
- Consumes: `SetupStatus` (C1) and `SetupStepKey` (C5), both type-only.
- Produces: `STEPS`, `stepIndex`, `canContinue(step, status)`, `permsOk`, `canSkipPlanOnly(step)`, `POLL_STEPS`, `waitingText(step, status)`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/tests/u6-setup.test.mts. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { canContinue, canSkipPlanOnly, permsOk, POLL_STEPS, STEPS, waitingText } from "../src/setup/gating.ts";
import type { SetupStatus } from "../src/api/types.ts";

const st = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  platform: "macos",
  key: { provider: "anthropic", present: false, source: "none", tested: false, warning: null },
  driver: { installed: true, version: "0.32.0", running: false },
  permissions: { accessibility: "unknown", screen_recording: "unknown" },
  self_test: { passed_at: null },
  plan_only: false, complete: false, ...over,
});

test("order and labels", () => {
  assert.deepEqual(STEPS.map((x) => x.key), ["welcome", "key", "driver", "permissions", "selftest"]);
  assert.deepEqual(STEPS.map((x) => x.label), ["Welcome", "Model key", "cua-driver", "Permissions", "Self-test"]);
});

test("canContinue gates each step on the daemon's status", () => {
  assert.equal(canContinue("welcome", null), true);
  assert.equal(canContinue("key", null), false);
  assert.equal(canContinue("key", st({ key: { provider: "anthropic", present: true, source: "keychain", tested: false, warning: null } })), false);
  assert.equal(canContinue("key", st({ key: { provider: "anthropic", present: true, source: "keychain", tested: true, warning: null } })), true);
  assert.equal(canContinue("driver", st()), false);
  assert.equal(canContinue("driver", st({ driver: { installed: true, version: "x", running: true } })), true);
  assert.equal(canContinue("permissions", st({ permissions: { accessibility: "granted", screen_recording: "denied" } })), false);
  assert.equal(canContinue("permissions", st({ permissions: { accessibility: "granted", screen_recording: "granted" } })), true);
  assert.equal(canContinue("selftest", st({ self_test: { passed_at: "2026-10-02T00:00:00Z" } })), true);
});

test("non-macOS: n/a permissions pass", () => {
  assert.equal(permsOk(st({ platform: "linux", permissions: { accessibility: "n/a", screen_recording: "n/a" } })), true);
});

test("plan-only skip is offered from the cua-driver step on; polling only where status changes outside the app", () => {
  assert.deepEqual(STEPS.map((x) => canSkipPlanOnly(x.key)), [false, false, true, true, true]);
  assert.deepEqual(POLL_STEPS, ["driver", "permissions"]);
});

test("waitingText names what is missing", () => {
  assert.equal(waitingText("permissions", st({ permissions: { accessibility: "granted", screen_recording: "unknown" } })), "Waiting for Screen Recording…");
  assert.equal(waitingText("driver", st()), "Waiting for cua-driver to start…");
  assert.equal(waitingText("permissions", st({ permissions: { accessibility: "granted", screen_recording: "granted" } })), null);
});
```

Run: `cd app && npm test`. Expected: FAIL, `Cannot find module …/setup/gating.ts`.

- [ ] **Step 2: Implement**

```ts
// app/src/setup/gating.ts. Which wizard step may continue, decided only from GET /setup/status.
import type { PermState, SetupStatus } from "../api/types";
import type { SetupStepKey } from "../screens";

export const STEPS: { key: SetupStepKey; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "key", label: "Model key" },
  { key: "driver", label: "cua-driver" },
  { key: "permissions", label: "Permissions" },
  { key: "selftest", label: "Self-test" },
];
export const POLL_STEPS: SetupStepKey[] = ["driver", "permissions"];
export const stepIndex = (k: SetupStepKey) => STEPS.findIndex((x) => x.key === k);

const permOk = (p: PermState) => p === "granted" || p === "n/a";
export const permsOk = (s: SetupStatus) => permOk(s.permissions.accessibility) && permOk(s.permissions.screen_recording);

export function canContinue(step: SetupStepKey, s: SetupStatus | null): boolean {
  if (step === "welcome") return true;
  if (!s) return false;
  switch (step) {
    case "key": return s.key.present && s.key.tested;
    case "driver": return s.driver.installed && s.driver.running;
    case "permissions": return permsOk(s);
    case "selftest": return s.self_test.passed_at !== null;
  }
}

export const canSkipPlanOnly = (step: SetupStepKey) => stepIndex(step) >= stepIndex("driver");

export function waitingText(step: SetupStepKey, s: SetupStatus | null): string | null {
  if (!s || canContinue(step, s)) return null;
  if (step === "driver") return s.driver.installed ? "Waiting for cua-driver to start…" : "cua-driver is not installed yet.";
  if (step === "permissions") {
    if (!permOk(s.permissions.accessibility)) return "Waiting for Accessibility…";
    return "Waiting for Screen Recording…";
  }
  return null;
}
```

Run: `cd app && npm test`. Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/setup/gating.ts app/tests/u6-setup.test.mts
git commit -m "app/U6: setup step gating" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U6-2: The wizard (shell and five steps)

**Files:**
- Replace: `app/src/setup/SetupWizard.tsx`
- Create: `app/src/setup/steps.tsx`, `app/src/setup/Wizard.module.css`
- Test: `app/e2e/setup.spec.ts`

**Interfaces:**
- Consumes these `DaemonApi` calls (C2): `setupStatus`, `setKey`, `installDriver`, `startDriver`, `openPermission`, `selfTest`, `completeSetup`, `putSettings`. Also `HttpError.body.error` and U6-1.
- Produces: `SetupWizard` (C6). Test ids: `setup-wizard`, `setup-step-{key}`, `setup-next`, `setup-skip-plan-only`, `setup-key-input`, `setup-key-save`, `setup-driver-install`, `setup-driver-start`, `setup-open-accessibility`, `setup-open-screen_recording`, `setup-selftest-run`, `setup-done`. Extra id: `setup-close` (shown only when setup is already complete).

- [ ] **Step 1: Write the failing e2e tests**

```ts
// app/e2e/setup.spec.ts. Run: E2E_PORT=1436 npx playwright test e2e/setup.spec.ts
import { expect, test, type Page } from "@playwright/test";

async function toKey(page: Page) {
  await page.goto("/?mock&setup");
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await expect(page.getByTestId("setup-skip-plan-only")).toHaveCount(0);
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await expect(page.getByTestId("setup-skip-plan-only")).toHaveCount(0);
  await page.getByTestId("setup-key-input").fill("sk-test-123");
  await page.getByTestId("setup-key-save").click();
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await expect(page.getByTestId("setup-key-input")).toHaveValue(""); // never kept in the page
  await page.getByTestId("setup-next").click();
}

test("full walk-through: key, driver, permissions (live), self-test, done", async ({ page }) => {
  await toKey(page);
  if (await page.getByTestId("setup-driver-install").isVisible()) await page.getByTestId("setup-driver-install").click();
  await page.getByTestId("setup-driver-start").click();
  await expect(page.getByTestId("setup-next")).toBeEnabled({ timeout: 5_000 });
  await page.getByTestId("setup-next").click();
  await expect(page.getByText("CuaDriver")).toBeVisible();
  await page.getByTestId("setup-open-accessibility").click();
  await page.getByTestId("setup-open-screen_recording").click();
  await expect(page.getByText("Waiting for", { exact: false })).toBeVisible();
  await expect(page.getByTestId("setup-next")).toBeEnabled({ timeout: 6_000 }); // polled, no click needed
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-selftest-run").click();
  await expect(page.getByTestId("setup-done")).toBeEnabled({ timeout: 5_000 });
  await page.getByTestId("setup-done").click();
  await expect(page.getByTestId("setup-wizard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
});

test("plan-only skip from the cua-driver step lands on home", async ({ page }) => {
  await toKey(page);
  await page.getByTestId("setup-skip-plan-only").click();
  await expect(page.getByTestId("setup-wizard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
});
```

Run it. Expected: FAIL, because the stub has no `setup-next`.

- [ ] **Step 2: Styles.** `app/src/setup/Wizard.module.css`. These are the mockup values; keep the class names, since the code uses them:

```css
.page { height: 100%; display: grid; place-items: center; background: var(--bg); padding: 24px; }
.card { width: min(560px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 22px; display: flex; flex-direction: column; gap: 14px; position: relative; }
.close { position: absolute; top: 12px; right: 14px; border: 0; background: transparent; color: var(--text-3); font-size: 18px; cursor: pointer; }
.strip { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; font-size: var(--fs-xs); color: var(--text-3); }
.strip li { flex: 1; border-top: 3px solid var(--raised); padding-top: 6px; }
.strip .done { border-color: var(--ok); color: var(--text-2); }
.strip .on { border-color: var(--accent); color: var(--text); }
.h { font-size: var(--fs-lg); font-weight: 600; margin: 0; }
.p { color: var(--text-2); line-height: 1.5; margin: 0; }
.p b { color: var(--text); }
.list { margin: 0; padding-left: 18px; color: var(--text-2); line-height: 1.6; }
.row { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; background: var(--bg); }
.ico { width: 32px; height: 32px; border-radius: var(--r-sm); background: var(--raised); display: grid; place-items: center; flex: none; }
.tx { flex: 1; line-height: 1.4; } .tx small { display: block; color: var(--text-3); }
.st { display: inline-flex; gap: 6px; align-items: center; font-size: var(--fs-sm); } .st i { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.seg { display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; }
.seg button { border: 0; background: transparent; padding: 4px 12px; border-radius: 6px; color: var(--text-2); cursor: pointer; }
.seg .segOn { background: var(--raised); color: var(--text); }
.input { flex: 1; height: 34px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--bg); padding: 0 10px; font-family: var(--mono); font-size: var(--fs-sm); }
.btn { border: 1px solid var(--line); background: var(--raised); border-radius: var(--r-pill); padding: 6px 13px; cursor: pointer; font-size: var(--fs-sm); white-space: nowrap; }
.btn:disabled { opacity: 0.4; cursor: default; }
.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
.ghost { background: transparent; }
.ok { color: var(--ok); } .err { color: var(--rm); font-size: var(--fs-sm); } .muted { color: var(--text-3); font-size: var(--fs-sm); }
.log { margin: 0; max-height: 160px; overflow: auto; padding: 10px; border-radius: var(--r-sm); background: var(--bg); border: 1px solid var(--line); font-family: var(--mono); font-size: var(--fs-xs); white-space: pre-wrap; }
.footer { display: flex; align-items: center; gap: 8px; } .sp { flex: 1; }
```

- [ ] **Step 3: Steps.** Create `app/src/setup/steps.tsx`:

```tsx
import { useState } from "react";
import type { DaemonApi } from "../api/client";
import { HttpError } from "../api/client";
import type { PermState, Provider, SetupStatus } from "../api/types";
import s from "./Wizard.module.css";

const msg = (e: unknown) => (e instanceof HttpError ? String(e.body.error ?? e.message) : e instanceof Error ? e.message : String(e));
export interface StepProps { api: DaemonApi; status: SetupStatus | null; refresh: () => Promise<void> }

export function Welcome() {
  return (
    <>
      <h2 className={s.h}>Welcome to Sketch Oversight</h2>
      <p className={s.p}>The agent plans a task, you draw a loop around the steps you're OK with, and only those run.</p>
      <ul className={s.list}>
        <li>It works in its own browser window on its own desk, never in your windows.</li>
        <li>Nothing runs until you approve it.</li>
        <li>Stop any time with the Stop button; the run halts before its next action.</li>
      </ul>
      <p className={s.muted}>Setup takes about two minutes. You can skip the agent part and use plan-only mode.</p>
    </>
  );
}

export function KeyStep({ api, status, refresh }: StepProps) {
  const [provider, setProvider] = useState<Provider>(status?.key.provider ?? "anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = status?.key.present && status.key.tested && status.key.provider === provider;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.setKey(provider, key.trim());
      if (!r.ok) setErr(r.error ?? "That key didn't work.");
      else { setKey(""); await refresh(); }
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <h2 className={s.h}>Connect a model</h2>
      <p className={s.p}>Paste an API key. It is stored in your system keychain and tested with a 1-token call.</p>
      <div className={s.seg} role="radiogroup" aria-label="Provider">
        {(["anthropic", "openai"] as Provider[]).map((p) => (
          <button key={p} role="radio" aria-checked={provider === p} className={provider === p ? s.segOn : ""} onClick={() => setProvider(p)}>
            {p === "anthropic" ? "Anthropic" : "OpenAI"}
          </button>
        ))}
      </div>
      <div className={s.footer}>
        <input className={s.input} data-testid="setup-key-input" type="password" autoComplete="off" placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
          value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()} />
        <button className={`${s.btn} ${s.primary}`} data-testid="setup-key-save" disabled={!key.trim() || busy} onClick={() => void save()}>
          {busy ? "Testing…" : "Save & test"}
        </button>
      </div>
      {ok && <div className={s.ok}>✓ Key saved ({status!.key.source}) and working.</div>}
      {status?.key.warning && <div className={s.muted}>{status.key.warning}</div>}
      {err && <div className={s.err} role="alert">{err}</div>}
    </>
  );
}

export function DriverStep({ api, status, refresh }: StepProps) {
  const [busy, setBusy] = useState<"install" | "start" | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = status?.driver;
  const install = async () => {
    setBusy("install"); setErr(null); setLog(null);
    try { const r = await api.installDriver(); if (!r.ok) { setErr("Install failed."); setLog(r.log_tail); } await refresh(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  };
  const start = async () => {
    setBusy("start"); setErr(null);
    try { const r = await api.startDriver(); if (!r.ok) setErr(r.error ?? "cua-driver didn't start."); await refresh(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(null); }
  };
  return (
    <>
      <h2 className={s.h}>The agent's driver</h2>
      <p className={s.p}><b>cua-driver</b> is what lets the agent click and type in its own window.</p>
      <div className={s.row}>
        <span className={s.ico}>⚙</span>
        <div className={s.tx}>cua-driver<small>{d?.installed ? `Installed${d.version ? `, version ${d.version}` : ""}` : "Not installed"}</small></div>
        {!d?.installed ? (
          <button className={`${s.btn} ${s.primary}`} data-testid="setup-driver-install" disabled={busy !== null} onClick={() => void install()}>
            {busy === "install" ? "Installing… (up to a minute)" : "Install"}
          </button>
        ) : !d.running ? (
          <button className={`${s.btn} ${s.primary}`} data-testid="setup-driver-start" disabled={busy !== null} onClick={() => void start()}>
            {busy === "start" ? "Starting…" : "Start"}
          </button>
        ) : (
          <span className={s.st}><i />Running</span>
        )}
      </div>
      {err && <div className={s.err} role="alert">{err}</div>}
      {log && <pre className={s.log}>{log}</pre>}
    </>
  );
}

const PERMS: { which: "accessibility" | "screen_recording"; name: string; why: string; icon: string }[] = [
  { which: "accessibility", name: "Accessibility", why: "Lets the agent click and type in its own window", icon: "♿" },
  { which: "screen_recording", name: "Screen Recording", why: "Lets the agent see its own window (never your other windows)", icon: "▣" },
];

export function PermissionsStep({ api, status }: StepProps) {
  const [err, setErr] = useState<string | null>(null);
  if (status && status.platform !== "macos") {
    return (
      <>
        <h2 className={s.h}>Permissions</h2>
        <div className={s.row}><span className={s.ico}>✓</span><div className={s.tx}>n/a: nothing to grant on {status.platform === "windows" ? "Windows" : "Linux"}</div></div>
      </>
    );
  }
  const open = (w: "accessibility" | "screen_recording") => api.openPermission(w).then(() => setErr(null), (e) => setErr(msg(e)));
  const label = (p: PermState | undefined) => (p === "granted" ? "Allowed" : p === "denied" ? "Denied" : "Not yet");
  return (
    <>
      <h2 className={s.h}>Let the agent see and use its window</h2>
      <p className={s.p}>macOS asks you to allow this twice. Click each button, flip the switch next to <b>CuaDriver</b>, and come back. This page updates by itself.</p>
      {PERMS.map((x) => {
        const p = status?.permissions[x.which];
        return (
          <div key={x.which} className={s.row}>
            <span className={s.ico}>{x.icon}</span>
            <div className={s.tx}>{x.name}<small>{x.why}</small></div>
            {p === "granted" ? (
              <span className={s.st}><i />Allowed</span>
            ) : (
              <>
                {p === "denied" && <span className={s.muted}>{label(p)}</span>}
                <button className={`${s.btn} ${s.primary}`} data-testid={`setup-open-${x.which}`} onClick={() => void open(x.which)}>Open Settings</button>
              </>
            )}
          </div>
        );
      })}
      {err && <div className={s.err} role="alert">{err}</div>}
    </>
  );
}

export function SelfTestStep({ api, status, refresh }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; detail: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try { setRes(await api.selfTest()); await refresh(); } catch (e) { setRes({ ok: false, detail: msg(e) }); } finally { setBusy(false); }
  };
  const passed = status?.self_test.passed_at;
  return (
    <>
      <h2 className={s.h}>Quick self-test</h2>
      <p className={s.p}>Opens a scratch window, types “hello”, screenshots that window only, and reads it back. About 10 seconds.</p>
      <div className={s.footer}>
        <button className={`${s.btn} ${s.primary}`} data-testid="setup-selftest-run" disabled={busy} onClick={() => void run()}>
          {busy ? "Running…" : res && !res.ok ? "Try again" : "Run self-test"}
        </button>
        {passed && <span className={s.ok}>✓ Passed</span>}
      </div>
      {res && !res.ok && <div className={s.err} role="alert">{res.detail}</div>}
    </>
  );
}
```

- [ ] **Step 4: Wizard shell.** Replace `app/src/setup/SetupWizard.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { SetupStatus } from "../api/types";
import type { SetupStepKey } from "../screens";
import { canContinue, canSkipPlanOnly, POLL_STEPS, STEPS, stepIndex, waitingText } from "./gating";
import { DriverStep, KeyStep, PermissionsStep, SelfTestStep, Welcome } from "./steps";
import s from "./Wizard.module.css";

export function SetupWizard({ api, initialStep, onClose }: { api: DaemonApi; initialStep?: SetupStepKey; onClose: () => void }) {
  const [step, setStep] = useState<SetupStepKey>(initialStep ?? "welcome");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await api.setupStatus()); setErr(null); }
    catch (e) { setErr(`Can't reach the daemon: ${e instanceof Error ? e.message : String(e)}`); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Status changes outside the app (System Settings, the driver starting), so poll there.
  useEffect(() => {
    if (!POLL_STEPS.includes(step)) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [step, refresh]);

  const i = stepIndex(step);
  const last = step === "selftest";
  const finish = async (planOnly: boolean) => {
    setBusy(true);
    try {
      if (planOnly) await api.putSettings({ plan_only: true });
      await api.completeSetup();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const props = { api, status, refresh };

  return (
    <div className={s.page} data-testid="setup-wizard">
      <div className={s.card}>
        {status?.complete && <button className={s.close} data-testid="setup-close" aria-label="Close setup" onClick={onClose}>×</button>}
        <ol className={s.strip}>
          {STEPS.map((x, k) => {
            const done = k !== i && canContinue(x.key, status) && x.key !== "welcome" ? true : k < i;
            return (
              <li key={x.key} data-testid={`setup-step-${x.key}`} className={k === i ? s.on : done ? s.done : ""} aria-current={k === i ? "step" : undefined}>
                {done && k !== i ? "✓ " : ""}{x.label}
              </li>
            );
          })}
        </ol>
        {step === "welcome" && <Welcome />}
        {step === "key" && <KeyStep {...props} />}
        {step === "driver" && <DriverStep {...props} />}
        {step === "permissions" && <PermissionsStep {...props} />}
        {step === "selftest" && <SelfTestStep {...props} />}
        <div className={s.footer}>
          <span className={err ? s.err : s.muted}>{err ?? waitingText(step, status) ?? ""}</span>
          <span className={s.sp} />
          {i > 0 && <button className={`${s.btn} ${s.ghost}`} onClick={() => setStep(STEPS[i - 1].key)}>Back</button>}
          {canSkipPlanOnly(step) && (
            <button className={s.btn} data-testid="setup-skip-plan-only" disabled={busy} onClick={() => void finish(true)}>Skip, plan-only mode</button>
          )}
          {last ? (
            <button className={`${s.btn} ${s.primary}`} data-testid="setup-done" disabled={busy || !canContinue("selftest", status)} onClick={() => void finish(false)}>Done</button>
          ) : (
            <button className={`${s.btn} ${s.primary}`} data-testid="setup-next" disabled={!canContinue(step, status)} onClick={() => setStep(STEPS[i + 1].key)}>Continue</button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify.** Run `cd app && npm run typecheck && npm test && E2E_PORT=1436 npx playwright test e2e/setup.spec.ts e2e/smoke.spec.ts`. Expected: all pass. If U8 hasn't merged yet, `setup.spec.ts` fails because the mock ignores `?setup`. Report that; the orchestrator re-runs it after U8 merges, and it must pass then. `smoke.spec.ts` must pass regardless.

- [ ] **Step 6: Commit**

```bash
git add app/src/setup app/e2e/setup.spec.ts
git commit -m "app/U6: first-run setup wizard (key, driver, live permissions, self-test, plan-only)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

## Contract notes

- **U8 `?setup` mode** is required exactly as described at the top of this file. In particular, `health().setup_complete` must mirror the mock's `complete`, so the wizard closes onto Home after `completeSetup`.
- **Extra test id `setup-close`**, outside C8. It appears only when `status.complete` is true (the wizard was reopened from Settings or a Fix link).
- **`initialStep` from Fix links** isn't covered by U6's e2e, because the Fix links live in U1. W2-1 should add "health-pill Fix opens the wizard at that step".
