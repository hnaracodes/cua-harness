# Track U1: Shell and home (AppShell, HealthPill, Splash, Composer, HomeScreen)

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts C1 to C8, the Ownership matrix, and the E2E port table first. Spec sections: **Screens §1 (Home)** and **Error handling**. Mockups: `docs/superpowers/specs/2026-10-02-ui-redesign-mockups/4-home-run-setup.html` (Home, top) and `3-review-workspace.html` (rail, composer). Wave 1, Batch B. Worktree: `.worktrees/rd-U1`, branch `rd/U1`. E2E port: **1431**.

**Owns:** `app/src/shell/**`, `app/src/home/**`, `app/tests/u1-home.test.mts`, `app/e2e/home.spec.ts`. Touch nothing else. The exports `AppShell`, `Splash`, `HomeScreen`, `Composer`, and `ComposerProps` keep the exact C6 signatures. The test ids listed in C8 for the Composer and for Home and shell are kept exactly.

**Goal:**
- Replace the four Wave 0 stubs with the approved Home screen and app shell.
- The shell is a collapsible task rail with history and replay, a health pill that names the problem and links to the fix, the model picker, notices, a reconnecting banner, and a splash that shows supervisor state and the log when the daemon won't start.
- The composer handles image attachments (`+`, drag-drop, paste), with per-chip validation and upload state.

---

### Task U1-1: Pure helpers (attachment rules, health view, formatting)

**Files:**
- Create: `app/src/home/attachmentRules.ts`
- Create: `app/src/shell/healthModel.ts`
- Create: `app/src/shell/format.ts`
- Test: `app/tests/u1-home.test.mts`

**Interfaces:**
- Consumes: `Health`, `Provider` (C1), `SupervisorStatus` (C7), `SetupStepKey` (C5). All are **type-only** imports, because `node --test` runs these files directly.
- Produces (used only inside U1):
  - `validateImage(file: { type: string; size: number }, alreadyAttached: number): string | null`
  - `MAX_ATTACHMENTS = 4`, `MAX_BYTES = 5 * 1024 * 1024`, `IMAGE_MIMES`
  - `providerLabel(p: string | null | undefined): "Anthropic" | "OpenAI"`
  - `healthView(h: Health | null, reachable: boolean, sup: SupervisorStatus | null): HealthView`
  - `relTime(iso: string, now?: number): string`, `usd(n: number): string`, `latestCost(events, fallback): number`

- [ ] **Step 1: Write the failing tests**

Create `app/tests/u1-home.test.mts`:

```ts
// Run: npm test. Pure helpers for the shell and home (track U1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ATTACHMENTS, providerLabel, validateImage } from "../src/home/attachmentRules.ts";
import { healthView } from "../src/shell/healthModel.ts";
import { latestCost, relTime, usd } from "../src/shell/format.ts";
import type { Health } from "../src/api/types.ts";

const MB = 1024 * 1024;

test("validateImage mirrors the daemon's rules, count first", () => {
  assert.equal(validateImage({ type: "image/png", size: 10 }, 0), null);
  assert.equal(validateImage({ type: "image/webp", size: 5 * MB }, 3), null);
  assert.match(validateImage({ type: "image/png", size: 10 }, MAX_ATTACHMENTS)!, /At most 4 images/);
  assert.match(validateImage({ type: "image/heic", size: 10 }, 0)!, /Unsupported type image\/heic/);
  assert.match(validateImage({ type: "", size: 10 }, 0)!, /Unsupported type unknown/);
  assert.match(validateImage({ type: "image/jpeg", size: 0 }, 0)!, /empty/);
  assert.match(validateImage({ type: "image/jpeg", size: 5 * MB + 1 }, 0)!, /5 MB or smaller/);
});

test("providerLabel", () => {
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("anthropic"), "Anthropic");
  assert.equal(providerLabel("fixtures"), "Anthropic");
  assert.equal(providerLabel(null), "Anthropic");
});

const base: Health = {
  daemon: "ok", api_key: true, provider: "anthropic", model: "claude-sonnet-5-5", cua_driver: true,
  fixtures: false, exec_mode: "live", cost_usd_total: 0, status_line: "Ready.", setup_complete: true, plan_only: false,
};

test("healthView: ready, missing key, plan-only, permissions, driver", () => {
  assert.deepEqual(healthView(base, true, null), { tone: "ok", label: "Ready", fix: null, reason: null });
  assert.equal(healthView({ ...base, api_key: false }, true, null).fix, "key");
  const po = healthView({ ...base, plan_only: true }, true, null);
  assert.equal(po.label, "Plan-only");
  assert.equal(po.fix, "driver");
  const perm = healthView({ ...base, cua_driver: false, cua_driver_detail: "permissions pending: Accessibility" }, true, null);
  assert.equal(perm.fix, "permissions");
  assert.equal(perm.label, "Permissions needed");
  const drv = healthView({ ...base, cua_driver: false, cua_driver_detail: "cua-driver daemon not running" }, true, null);
  assert.equal(drv.fix, "driver");
  // simulated executor or fixtures never nags about the driver
  assert.equal(healthView({ ...base, cua_driver: false, exec_mode: "simulated" }, true, null).tone, "ok");
  assert.equal(healthView({ ...base, cua_driver: false, fixtures: true }, true, null).tone, "ok");
});

test("healthView: transport and supervisor states win", () => {
  assert.deepEqual(healthView(base, false, null), { tone: "bad", label: "Reconnecting…", fix: null, reason: "The daemon is not answering." });
  assert.equal(healthView(null, true, null).label, "Connecting…");
  assert.equal(healthView(base, false, { state: "restarting", restarts: 1, last_error: "exit 1" }).label, "Restarting daemon…");
  const failed = healthView(base, false, { state: "failed", restarts: 3, last_error: null });
  assert.equal(failed.tone, "bad");
  assert.equal(failed.reason, "The daemon won't start.");
  assert.equal(healthView(base, true, { state: "running", restarts: 0, last_error: null }).label, "Ready");
  assert.equal(healthView(base, true, { state: "external", restarts: 0, last_error: null }).label, "Ready");
});

test("relTime, usd, latestCost", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(relTime("2026-10-02T11:59:30Z", now), "just now");
  assert.equal(relTime("2026-10-02T11:45:00Z", now), "15m ago");
  assert.equal(relTime("2026-10-02T09:00:00Z", now), "3h ago");
  assert.equal(relTime("2026-09-29T12:00:00Z", now), "3d ago");
  assert.equal(relTime("garbage", now), "");
  assert.equal(usd(0.10834), "$0.1083");
  assert.equal(usd(2.5), "$2.50");
  const evs = [
    { kind: "cost", payload: { usd_total: 0.01 } },
    { kind: "step_started", payload: {} },
    { kind: "cost", payload: { usd_total: 0.05 } },
  ];
  assert.equal(latestCost(evs, 9), 0.05);
  assert.equal(latestCost([], 9), 9);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app && npm test`
Expected: FAIL with `Cannot find module '…/src/home/attachmentRules.ts'`.

- [ ] **Step 3: Implement the three helpers**

Create `app/src/home/attachmentRules.ts`:

```ts
// Client-side mirror of the daemon's attachment rules (spec: Daemon API §1), so a bad
// file is rejected on its own chip before any upload. The daemon re-checks everything.
import type { Provider } from "../api/types";

export const MAX_ATTACHMENTS = 4;
export const MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

export function validateImage(file: { type: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} images per task.`;
  if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) return `Unsupported type ${file.type || "unknown"}. Use PNG, JPEG or WebP.`;
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_BYTES) return "Images must be 5 MB or smaller.";
  return null;
}

export function providerLabel(p: Provider | string | null | undefined): "Anthropic" | "OpenAI" {
  return p === "openai" ? "OpenAI" : "Anthropic";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

Create `app/src/shell/healthModel.ts`:

```ts
// What the health pill says and which wizard step fixes it (spec: Error handling).
import type { Health } from "../api/types";
import type { SupervisorStatus } from "../lib/tauri";
import type { SetupStepKey } from "../screens";

export type Tone = "ok" | "warn" | "bad";
export interface HealthView {
  tone: Tone;
  label: string;
  fix: SetupStepKey | null;
  reason: string | null;
}

export function healthView(h: Health | null, reachable: boolean, sup: SupervisorStatus | null): HealthView {
  if (sup?.state === "starting") return { tone: "warn", label: "Starting…", fix: null, reason: sup.last_error };
  if (sup?.state === "restarting") return { tone: "warn", label: "Restarting daemon…", fix: null, reason: sup.last_error };
  if (sup?.state === "failed") return { tone: "bad", label: "Daemon stopped", fix: null, reason: sup.last_error ?? "The daemon won't start." };
  if (!reachable) return { tone: "bad", label: "Reconnecting…", fix: null, reason: "The daemon is not answering." };
  if (!h) return { tone: "warn", label: "Connecting…", fix: null, reason: null };
  if (!h.api_key) return { tone: "warn", label: "Add a model key", fix: "key", reason: "No API key for the selected provider." };
  if (h.plan_only) {
    return { tone: "warn", label: "Plan-only", fix: "driver", reason: "The agent can plan but not run. Finish setup to run tasks." };
  }
  if (!h.fixtures && h.exec_mode === "live" && !h.cua_driver) {
    const detail = h.cua_driver_detail ?? h.status_line;
    const perm = /permission/i.test(detail);
    return { tone: "warn", label: perm ? "Permissions needed" : "Agent driver offline", fix: perm ? "permissions" : "driver", reason: detail };
  }
  return { tone: "ok", label: "Ready", fix: null, reason: null };
}
```

Create `app/src/shell/format.ts`:

```ts
export function relTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Running cost of the current task: the newest `cost` event's usd_total, else `fallback`. */
export function latestCost(events: readonly { kind: string; payload: unknown }[], fallback: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "cost") return (events[i].payload as { usd_total: number }).usd_total;
  }
  return fallback;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: every test passes, including the 5 new U1 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/home/attachmentRules.ts app/src/shell/healthModel.ts app/src/shell/format.ts app/tests/u1-home.test.mts
git commit -m "app/U1: attachment rules, health view, format helpers" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U1-2: Composer (attachments, drag-drop, paste, send/stop)

**Files:**
- Replace: `app/src/home/Composer.tsx`
- Create: `app/src/home/Composer.module.css`
- Test: `app/e2e/home.spec.ts` (composer tests)

**Interfaces:**
- Consumes: `DaemonApi.uploadAttachment`, `DaemonApi.attachmentUrl` (C2), `Attachment` (C1), and `validateImage`, `formatBytes` (U1-1).
- Produces: `Composer(props: ComposerProps)` with `ComposerProps` exactly as in C6. Test ids: `composer-input`, `composer-send`, `composer-stop`, `composer-attach`, `composer-file`, `attachment-chip`, `attachment-error`.

- [ ] **Step 1: Write the failing e2e tests**

Create `app/e2e/home.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

async function home(page: Page, query = "?mock") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
}

test("Enter sends, Shift+Enter makes a newline", async ({ page }) => {
  await home(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await expect(input).toHaveValue("line one\nline two");
  await expect(page.getByTestId("composer-send")).toBeEnabled();
});

test("rejects bad attachments on their own chip; a good image still sends", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
    { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024, 1) },
  ]);
  await expect(page.getByTestId("attachment-error")).toHaveCount(2);
  await expect(page.getByTestId("attachment-error").first()).toContainText("Unsupported type text/plain");
  await expect(page.getByTestId("attachment-error").nth(1)).toContainText("5 MB or smaller");
  await page.getByTestId("composer-file").setInputFiles([png("ok.png")]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(3);
  await expect(page.getByText("Sent to Anthropic with your task.")).toBeVisible();
  await page.getByTestId("composer-input").fill("Fill this form using the screenshot I attach");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
});

test("a fifth image is rejected", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([png("1.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png")]);
  await expect(page.getByTestId("attachment-error")).toHaveCount(1);
  await expect(page.getByTestId("attachment-error")).toContainText("At most 4 images per task.");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(5);
});

test("removing an attached image removes its chip and the note", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([png("a.png")]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(page.getByText("Sent to Anthropic with your task.")).toHaveCount(0);
});
```

Run: `cd app && E2E_PORT=1431 npx playwright test e2e/home.spec.ts`
Expected: FAIL. The stub composer has no `composer-file` input.

- [ ] **Step 2: Write the composer styles**

Create `app/src/home/Composer.module.css`:

```css
.wrap { position: relative; width: 100%; display: flex; flex-direction: column; gap: 6px; }
.box {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-xl);
  padding: 12px 10px 10px 18px; transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.box:focus-within { border-color: color-mix(in srgb, var(--text) 22%, var(--line)); }
.dock { border-radius: 22px; padding: 8px 8px 8px 12px; gap: 6px; }
.dragging { border-color: var(--accent); background: var(--accent-soft); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip {
  position: relative; width: 54px; height: 40px; border-radius: var(--r-sm); overflow: hidden;
  border: 1px solid var(--line); background: var(--raised);
}
.chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bad {
  width: auto; max-width: 240px; height: auto; padding: 6px 24px 6px 8px;
  border-color: color-mix(in srgb, var(--rm) 55%, transparent); background: var(--rm-soft);
  font-size: var(--fs-xs); line-height: 1.35;
}
.remove {
  position: absolute; top: 3px; right: 3px; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
  background: rgba(0, 0, 0, 0.62); color: #fff; font-size: 11px; line-height: 16px; cursor: pointer;
}
.spin { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); }
.spin::after {
  content: ""; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #fff; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.input {
  resize: none; border: 0; outline: 0; background: transparent; padding: 0;
  font-size: var(--fs-lg); line-height: 1.45; min-height: 24px; max-height: 200px;
}
.dock .input { font-size: var(--fs-md); }
.input::placeholder { color: var(--text-3); }
.row { display: flex; align-items: center; gap: 8px; }
.iconBtn {
  width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--line); background: transparent;
  display: grid; place-items: center; font-size: 17px; cursor: pointer; transition: background var(--dur) var(--ease);
}
.iconBtn:hover { background: var(--raised); }
.send {
  margin-left: auto; width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 15px; display: grid; place-items: center;
}
.dock .send { width: 28px; height: 28px; font-size: 13px; }
.send:disabled { opacity: 0.35; cursor: default; }
.stop {
  margin-left: auto; height: 30px; padding: 0 12px; border-radius: var(--r-pill); cursor: pointer; font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--rm) 45%, transparent); background: var(--rm-soft); color: var(--rm);
}
.note, .reason { font-size: var(--fs-xs); color: var(--text-3); padding: 0 14px; }
.reason { color: var(--pend); }
.hidden { display: none; }
```

- [ ] **Step 3: Implement the composer**

Replace `app/src/home/Composer.tsx` entirely:

```tsx
// The one composer (home hero and chat dock). Controlled text and attachments; uploads
// go through DaemonApi.uploadAttachment, and each file gets its own chip and error.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { DaemonApi } from "../api/client";
import type { Attachment } from "../api/types";
import { formatBytes, validateImage } from "./attachmentRules";
import s from "./Composer.module.css";

export interface ComposerProps {
  api: DaemonApi;
  value: string;
  onChange: (v: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (a: Attachment[]) => void;
  allowAttachments: boolean;
  providerLabel: string; // "Anthropic" | "OpenAI", for the attachment note
  placeholder: string;
  size: "hero" | "dock";
  disabledReason: string | null; // non-null disables send and shows the reason
  running: boolean; // true: the send button becomes Stop
  onSend: () => void;
  onStop?: () => void;
}

interface Local {
  key: string;
  name: string;
  preview: string;
  error: string | null; // null while uploading
}

let seq = 0;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Composer(p: ComposerProps) {
  const [local, setLocal] = useState<Local[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(p);
  latest.current = p;
  // Accumulates attachments between a resolve and the parent's re-render, so two uploads
  // finishing back to back never overwrite each other.
  const attRef = useRef(p.attachments);
  useEffect(() => {
    attRef.current = p.attachments;
  }, [p.attachments]);
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => () => localRef.current.forEach((l) => URL.revokeObjectURL(l.preview)), []);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [p.value]);

  const uploading = local.some((l) => l.error === null);
  const canSend = !p.disabledReason && !uploading && p.value.trim().length > 0;

  const drop = (key: string) =>
    setLocal((cur) => {
      const hit = cur.find((l) => l.key === key);
      if (hit) URL.revokeObjectURL(hit.preview);
      return cur.filter((l) => l.key !== key);
    });

  const addFiles = (files: File[]) => {
    if (!latest.current.allowAttachments || files.length === 0) return;
    let count = attRef.current.length + localRef.current.filter((l) => l.error === null).length;
    const added: Local[] = [];
    for (const f of files) {
      const key = `up${++seq}`;
      const error = validateImage(f, count);
      added.push({ key, name: f.name || "image", preview: URL.createObjectURL(f), error });
      if (error) continue;
      count += 1;
      latest.current.api.uploadAttachment(f, f.name || "image").then(
        (att) => {
          drop(key);
          attRef.current = [...attRef.current, att];
          latest.current.onAttachmentsChange(attRef.current);
        },
        (e) => setLocal((cur) => cur.map((l) => (l.key === key ? { ...l, error: errText(e) } : l))),
      );
    }
    setLocal((cur) => [...cur, ...added]);
  };

  const removeAttachment = (id: string) => {
    attRef.current = attRef.current.filter((a) => a.attachment_id !== id);
    p.onAttachmentsChange(attRef.current);
  };

  const send = () => {
    if (!canSend) return;
    setLocal((cur) => {
      cur.filter((l) => l.error !== null).forEach((l) => URL.revokeObjectURL(l.preview));
      return cur.filter((l) => l.error === null);
    });
    p.onSend();
  };

  const onDragOver = (e: DragEvent) => {
    if (!p.allowAttachments || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!p.allowAttachments) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length || !p.allowAttachments) return;
    e.preventDefault();
    addFiles(files);
  };

  return (
    <div className={s.wrap}>
      <div
        className={`${s.box} ${p.size === "dock" ? s.dock : ""} ${dragging ? s.dragging : ""}`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {(p.attachments.length > 0 || local.length > 0) && (
          <div className={s.chips}>
            {p.attachments.map((a) => (
              <div key={a.attachment_id} className={s.chip} data-testid="attachment-chip" title={`${a.mime}, ${formatBytes(a.bytes)}`}>
                <img src={p.api.attachmentUrl(a.attachment_id)} alt="Attached image" />
                <button className={s.remove} aria-label="Remove image" onClick={() => removeAttachment(a.attachment_id)}>
                  ×
                </button>
              </div>
            ))}
            {local.map((l) =>
              l.error ? (
                <div key={l.key} className={`${s.chip} ${s.bad}`} data-testid="attachment-chip">
                  <span data-testid="attachment-error">
                    {l.name}: {l.error}
                  </span>
                  <button className={s.remove} aria-label="Dismiss" onClick={() => drop(l.key)}>
                    ×
                  </button>
                </div>
              ) : (
                <div key={l.key} className={s.chip} data-testid="attachment-chip" aria-busy="true" title={`Uploading ${l.name}`}>
                  <img src={l.preview} alt="" />
                  <span className={s.spin} />
                </div>
              ),
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          className={s.input}
          data-testid="composer-input"
          rows={1}
          value={p.value}
          placeholder={p.placeholder}
          onChange={(e) => p.onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!p.running) send();
          }}
        />
        <div className={s.row}>
          {p.allowAttachments && (
            <>
              <button className={s.iconBtn} data-testid="composer-attach" aria-label="Attach images" title="Attach images" onClick={() => fileRef.current?.click()}>
                +
              </button>
              <input
                ref={fileRef}
                className={s.hidden}
                data-testid="composer-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </>
          )}
          {p.running ? (
            <button className={s.stop} data-testid="composer-stop" onClick={p.onStop}>
              ■ Stop
            </button>
          ) : (
            <button className={s.send} data-testid="composer-send" aria-label="Send" disabled={!canSend} onClick={send}>
              ↑
            </button>
          )}
        </div>
      </div>
      {p.attachments.length > 0 && <div className={s.note}>Sent to {p.providerLabel} with your task.</div>}
      {p.disabledReason && <div className={s.reason}>{p.disabledReason}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and run the composer e2e**

Run: `cd app && npm run typecheck && E2E_PORT=1431 npx playwright test e2e/home.spec.ts`
Expected: typecheck clean. All 4 tests pass. (The stub `HomeScreen` already renders the heading and passes `allowAttachments` and `providerLabel="Anthropic"`.)

- [ ] **Step 5: Commit**

```bash
git add app/src/home/Composer.tsx app/src/home/Composer.module.css app/e2e/home.spec.ts
git commit -m "app/U1: composer with image attachments, drag-drop, paste, per-chip errors" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U1-3: HomeScreen

**Files:**
- Replace: `app/src/home/HomeScreen.tsx`
- Create: `app/src/home/HomeScreen.module.css`
- Test: `app/e2e/home.spec.ts` (append)

**Interfaces:**
- Consumes: `ScreenProps` (C5), `session.actions.submit`, `DaemonApi.getSettings` (C2), `Composer` (U1-2), `providerLabel` (U1-1).
- Produces: `HomeScreen(props: ScreenProps)`. Test id: `home-suggestion`.

- [ ] **Step 1: Append the failing e2e test**

Append to `app/e2e/home.spec.ts`:

```ts
test("suggestions fill the composer and never send", async ({ page }) => {
  await home(page);
  await expect(page.getByTestId("home-suggestion")).toHaveCount(3);
  await page.getByTestId("home-suggestion").nth(1).click();
  await expect(page.getByTestId("composer-input")).toHaveValue("Draft a reply to my latest email (don't send it)");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
  await expect(page.getByTestId("boundary-canvas")).toHaveCount(0);
  await expect(page.getByText("Chrome (agent's own)")).toBeVisible();
});
```

Run: `cd app && E2E_PORT=1431 npx playwright test e2e/home.spec.ts -g suggestions`
Expected: FAIL (no `home-suggestion`).

- [ ] **Step 2: Write the styles**

Create `app/src/home/HomeScreen.module.css`:

```css
.home { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 0 60px 8vh; }
.title { margin: 0; font-size: var(--fs-xl); font-weight: 500; letter-spacing: -0.01em; }
.composer { width: 100%; max-width: 680px; }
.under { width: 100%; max-width: 680px; display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--r-pill);
  padding: 4px 10px; color: var(--text-2); font-size: var(--fs-xs);
}
.chipDot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
.sugg { width: 100%; max-width: 680px; display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.item {
  display: flex; gap: 12px; align-items: center; text-align: left; padding: 10px 14px; border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); cursor: pointer; transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.item:hover { background: var(--surface); color: var(--text); }
.icon { width: 16px; text-align: center; color: var(--text-3); }
```

- [ ] **Step 3: Implement HomeScreen**

Replace `app/src/home/HomeScreen.tsx` entirely:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Attachment, Provider } from "../api/types";
import type { ScreenProps } from "../screens";
import { providerLabel } from "./attachmentRules";
import { Composer } from "./Composer";
import s from "./HomeScreen.module.css";

// Examples only: a click fills the composer, it never sends (spec: Screens §1).
const SUGGESTIONS: { icon: string; text: string }[] = [
  { icon: "⌕", text: "Compare prices for a product across three stores" },
  { icon: "✎", text: "Draft a reply to my latest email (don't send it)" },
  { icon: "▦", text: "Fill this form using the screenshot I attach" },
];

export function HomeScreen({ api, conn, session }: ScreenProps) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.getSettings().then(
      (st) => alive && setProvider(st.provider),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, conn.health?.model]);

  const reason = !conn.reachable
    ? "The daemon is reconnecting…"
    : conn.health && !conn.health.api_key
      ? "Add a model key to start (click the status pill)."
      : null;

  const fill = (t: string) => {
    setText(t);
    requestAnimationFrame(() => wrapRef.current?.querySelector("textarea")?.focus());
  };

  return (
    <div className={s.home}>
      <h1 className={s.title}>What should the agent do?</h1>
      <div className={s.composer} ref={wrapRef}>
        <Composer
          api={api}
          value={text}
          onChange={setText}
          attachments={atts}
          onAttachmentsChange={setAtts}
          allowAttachments
          providerLabel={providerLabel(provider ?? conn.health?.provider)}
          placeholder="Find me a tennis racket under $100 for my friend's birthday…"
          size="hero"
          disabledReason={reason}
          running={false}
          onSend={() => void session.actions.submit(text, atts)}
        />
      </div>
      <div className={s.under}>
        <span className={s.chip} title="The agent works in its own browser profile, never in your windows">
          <i className={s.chipDot} /> Chrome (agent's own)
        </span>
      </div>
      <div className={s.sugg}>
        {SUGGESTIONS.map((x) => (
          <button key={x.text} className={s.item} data-testid="home-suggestion" onClick={() => fill(x.text)}>
            <span className={s.icon} aria-hidden>
              {x.icon}
            </span>
            {x.text}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run all of U1's e2e and the smoke test**

Run: `cd app && npm run typecheck && E2E_PORT=1431 npx playwright test e2e/home.spec.ts e2e/smoke.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/home/HomeScreen.tsx app/src/home/HomeScreen.module.css app/e2e/home.spec.ts
git commit -m "app/U1: home screen (hero composer, suggestions, agent app chip)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

### Task U1-4: AppShell, HealthPill, ModelPicker, Splash

**Files:**
- Replace: `app/src/shell/AppShell.tsx`, `app/src/shell/Splash.tsx`
- Create: `app/src/shell/HealthPill.tsx`, `app/src/shell/ModelPicker.tsx`
- Create: `app/src/shell/AppShell.module.css`, `app/src/shell/HealthPill.module.css`, `app/src/shell/Splash.module.css`
- Test: `app/e2e/home.spec.ts` (append)

**Interfaces:**
- Consumes:
  - `ScreenProps` (C5).
  - `DaemonApi.listTasks`, `getSettings`, `putSettings` (C2).
  - `session.actions.newTask`, `openTask`, `dismissNotice`, and `session.state.{phase, taskId, notice, events}` (C5).
  - `isTauri`, `daemonStatus`, `daemonLogTail` (C7).
  - `healthView`, `relTime`, `usd`, `latestCost` (U1-1).
- Produces:
  - `AppShell(props: ScreenProps & { children: ReactNode })`
  - `Splash(props: { conn: DaemonConn })`
  - Test ids: `new-task`, `history-item`, `health-pill`, `notice`, `notice-dismiss`, `splash`. Extra non-contract ids: `history-toggle`, `settings`.
- Depends on mock `?down=1` (track U8): `health()` rejects, so `conn.reachable` is false.

- [ ] **Step 1: Append the failing e2e tests**

Append to `app/e2e/home.spec.ts`:

```ts
test("history lists a finished task and reopening it replays the run chat", async ({ page }) => {
  test.setTimeout(120_000);
  await home(page);
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("new-task").click();
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-item")).toHaveCount(1);
  await expect(page.getByTestId("history-item")).toContainText("Find a tennis racket under $100");
  await page.getByTestId("history-item").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 10_000 });
});

test("health pill shows Ready and opens its details", async ({ page }) => {
  await home(page);
  const pill = page.getByTestId("health-pill");
  await expect(pill).toContainText("Ready");
  await pill.click();
  await expect(page.getByRole("dialog", { name: "Daemon status" })).toContainText("This session");
});

test("daemon down: pill and banner say Reconnecting…, sending is blocked with a reason", async ({ page }) => {
  await page.goto("/?mock&down=1");
  await expect(page.getByTestId("health-pill")).toContainText("Reconnecting…", { timeout: 10_000 });
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to the daemon…" })).toBeVisible();
  await page.getByTestId("composer-input").fill("anything");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByText("The daemon is reconnecting…")).toBeVisible();
});
```

Run: `cd app && E2E_PORT=1431 npx playwright test e2e/home.spec.ts -g "history|health|daemon down"`
Expected: FAIL (no `history-toggle`, no `health-pill`).

- [ ] **Step 2: Write the shell styles**

Create `app/src/shell/AppShell.module.css`:

```css
.shell { display: flex; height: 100%; background: var(--bg); }
.rail {
  width: var(--rail-w); flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 14px 0 12px; border-right: 1px solid var(--line); transition: width var(--dur) var(--ease);
}
.open { width: 268px; align-items: stretch; padding: 14px 10px 12px; }
.top { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.open .top { flex-direction: row; }
.logo { width: 28px; height: 28px; border-radius: var(--r-sm); background: var(--raised); display: grid; place-items: center; font-size: 15px; }
.railBtn {
  width: 28px; height: 28px; border-radius: var(--r-sm); border: 1px solid var(--line); background: transparent;
  display: grid; place-items: center; font-size: 15px; cursor: pointer; color: var(--text-2);
}
.railBtn:hover { background: var(--raised); color: var(--text); }
.railBtn[aria-expanded="true"] { background: var(--raised); color: var(--text); }
.history { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.historyHead { font-size: var(--fs-xs); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 8px; }
.empty { color: var(--text-3); font-size: var(--fs-sm); padding: 8px; }
.item {
  display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px; border: 0; border-radius: var(--r-sm);
  background: transparent; cursor: pointer; color: var(--text-2);
}
.item:hover { background: var(--surface); color: var(--text); }
.current { background: var(--raised); color: var(--text); }
.itemText { font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.itemMeta { font-size: var(--fs-xs); color: var(--text-3); }
.spacer { flex: 1; }
.bottom { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.open .bottom { flex-direction: row; justify-content: space-between; }
.main { flex: 1; min-width: 0; position: relative; }
.topRight { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; align-items: center; z-index: 5; }
.banner, .notice {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 20; display: flex; gap: 12px; align-items: center;
  padding: 7px 14px; border-radius: var(--r-pill); font-size: var(--fs-sm); box-shadow: var(--shadow); max-width: min(720px, 90%);
}
.banner { background: var(--rm-soft); border: 1px solid color-mix(in srgb, var(--rm) 45%, transparent); color: var(--text); }
.notice { top: 52px; background: var(--raised); border: 1px solid var(--line); }
.notice button { border: 0; background: transparent; color: var(--accent); cursor: pointer; padding: 0; }
.picker {
  height: 28px; border: 1px solid var(--line); border-radius: var(--r-pill); background: var(--surface);
  padding: 0 10px; font-size: var(--fs-xs); color: var(--text-2); cursor: pointer;
}
```

Create `app/src/shell/HealthPill.module.css`:

```css
.wrap { position: relative; display: inline-flex; gap: 6px; align-items: center; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: var(--r-pill);
  border: 1px solid var(--line); background: var(--surface); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer;
}
.compact { width: 28px; padding: 0; justify-content: center; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.warn .dot { background: var(--pend); }
.bad .dot { background: var(--rm); }
.warn { border-color: color-mix(in srgb, var(--pend) 45%, var(--line)); color: var(--text); }
.bad { border-color: color-mix(in srgb, var(--rm) 45%, var(--line)); color: var(--text); }
.fix { border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: var(--fs-xs); padding: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pop {
  position: absolute; top: 36px; right: 0; width: 300px; z-index: 30; display: flex; flex-direction: column; gap: 8px;
  background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; box-shadow: var(--shadow);
  font-size: var(--fs-sm);
}
.popUp { top: auto; bottom: 0; right: auto; left: 40px; }
.muted { color: var(--text-3); line-height: 1.4; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.mono { font-family: var(--mono); font-size: var(--fs-xs); }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.actions button { border: 1px solid var(--line); background: var(--surface); border-radius: var(--r-pill); padding: 5px 11px; cursor: pointer; }
.actions .primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
```

Create `app/src/shell/Splash.module.css`:

```css
.splash { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; }
.logo { width: 44px; height: 44px; border-radius: var(--r-md); background: var(--raised); display: grid; place-items: center; font-size: 22px; }
.title { font-size: var(--fs-lg); font-weight: 600; }
.muted { color: var(--text-3); max-width: 520px; text-align: center; line-height: 1.5; }
.spinner { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.log {
  width: min(720px, 100%); max-height: 40vh; overflow: auto; margin: 0; padding: 12px; border-radius: var(--r-md);
  background: var(--surface); border: 1px solid var(--line); font-family: var(--mono); font-size: var(--fs-xs); white-space: pre-wrap;
}
.btn { border: 1px solid var(--line); background: var(--raised); border-radius: var(--r-pill); padding: 6px 14px; cursor: pointer; }
```

- [ ] **Step 3: Implement HealthPill and ModelPicker**

Create `app/src/shell/HealthPill.tsx`:

```tsx
import { useEffect, useState } from "react";
import { daemonLogTail, daemonStatus, isTauri, type SupervisorStatus } from "../lib/tauri";
import type { SetupStepKey } from "../screens";
import type { DaemonConn } from "../state/useDaemon";
import { usd } from "./format";
import { healthView } from "./healthModel";
import s from "./HealthPill.module.css";

export function HealthPill({ conn, cost, openSetup, compact = false }: {
  conn: DaemonConn;
  cost: number;
  openSetup: (step?: SetupStepKey) => void;
  compact?: boolean;
}) {
  const [sup, setSup] = useState<SupervisorStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = () => daemonStatus().then((x) => alive && setSup(x), () => undefined);
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const v = healthView(conn.health, conn.reachable, sup);
  const copyLog = async () => {
    await navigator.clipboard.writeText(await daemonLogTail(40));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const fix = (step: SetupStepKey) => {
    setOpen(false);
    openSetup(step);
  };

  return (
    <div className={s.wrap}>
      <button
        className={`${s.pill} ${s[v.tone]} ${compact ? s.compact : ""}`}
        data-testid="health-pill"
        aria-expanded={open}
        title={v.label}
        onClick={() => setOpen((o) => !o)}
      >
        <i className={s.dot} />
        {compact ? <span className={s.sr}>{v.label}</span> : v.label}
      </button>
      {!compact && v.fix && (
        <button className={s.fix} onClick={() => fix(v.fix!)}>
          Fix
        </button>
      )}
      {open && (
        <div className={`${s.pop} ${compact ? s.popUp : ""}`} role="dialog" aria-label="Daemon status">
          <b>{v.label}</b>
          {v.reason && <div className={s.muted}>{v.reason}</div>}
          {conn.health && <div className={s.muted}>{conn.health.status_line}</div>}
          <div className={s.row}>
            <span>Model</span>
            <span className={s.mono}>{conn.health?.model ?? "…"}</span>
          </div>
          <div className={s.row}>
            <span>This session</span>
            <span className={s.mono}>{usd(cost)}</span>
          </div>
          <div className={s.actions}>
            {sup && <button onClick={() => void copyLog()}>{copied ? "Copied" : "Copy log"}</button>}
            {v.fix && (
              <button className={s.primary} onClick={() => fix(v.fix!)}>
                Fix
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

Create `app/src/shell/ModelPicker.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { AppSettings, Provider } from "../api/types";
import type { DaemonConn } from "../state/useDaemon";
import s from "./AppShell.module.css";

const LABEL: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

export function ModelPicker({ api, conn }: { api: DaemonApi; conn: DaemonConn }) {
  const [st, setSt] = useState<AppSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getSettings().then((x) => alive && setSt(x), () => undefined);
    return () => {
      alive = false;
    };
  }, [api, conn.reachable]);

  if (!st) return null;
  const change = async (value: string) => {
    const [provider, model] = value.split("::") as [Provider, string];
    try {
      setSt(await api.putSettings({ provider, model }));
      setErr(null);
      await conn.refreshHealth();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <select className={s.picker} aria-label="Model" title={err ?? "Planner and scorer model"} value={`${st.provider}::${st.model}`}
      onChange={(e) => void change(e.target.value)}>
      {(Object.keys(st.models) as Provider[]).map((p) => (
        <optgroup key={p} label={LABEL[p]}>
          {st.models[p].map((m) => (
            <option key={m} value={`${p}::${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Implement AppShell and Splash**

Replace `app/src/shell/AppShell.tsx` entirely:

```tsx
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { TaskSummary } from "../api/types";
import type { ScreenProps } from "../screens";
import { latestCost, relTime } from "./format";
import { HealthPill } from "./HealthPill";
import { ModelPicker } from "./ModelPicker";
import s from "./AppShell.module.css";

export function AppShell({ api, conn, session, openSetup, children }: ScreenProps & { children: ReactNode }) {
  const { state, actions } = session;
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  // Refresh history whenever the task or its phase changes (a new task, a plan, a finished run).
  useEffect(() => {
    let alive = true;
    api.listTasks().then((t) => alive && setTasks(t), () => undefined);
    return () => {
      alive = false;
    };
  }, [api, state.phase, state.taskId, conn.reachable]);

  const cost = useMemo(() => latestCost(state.events, conn.health?.cost_usd_total ?? 0), [state.events, conn.health]);
  const home = state.phase === "home";

  return (
    <div className={s.shell}>
      <nav className={`${s.rail} ${open ? s.open : ""}`} aria-label="Tasks">
        <div className={s.top}>
          <div className={s.logo} aria-hidden>
            ◎
          </div>
          <button className={s.railBtn} data-testid="new-task" title="New task" aria-label="New task" onClick={actions.newTask}>
            +
          </button>
          <button className={s.railBtn} data-testid="history-toggle" title="Past tasks" aria-label="Past tasks" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>
            ☰
          </button>
        </div>
        {open ? (
          <div className={s.history}>
            <div className={s.historyHead}>Past tasks</div>
            {tasks.length === 0 && <div className={s.empty}>No tasks yet.</div>}
            {tasks.map((t) => (
              <button key={t.id} data-testid="history-item" className={`${s.item} ${t.id === state.taskId ? s.current : ""}`} title={t.prompt}
                onClick={() => void actions.openTask(t.id)}>
                <span className={s.itemText}>{t.prompt}</span>
                <span className={s.itemMeta}>
                  {relTime(t.created_at)} · {t.step_count} steps
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={s.spacer} />
        )}
        <div className={s.bottom}>
          {!home && <HealthPill conn={conn} cost={cost} openSetup={openSetup} compact />}
          <button className={s.railBtn} data-testid="settings" title="Setup and settings" aria-label="Setup and settings" onClick={() => openSetup()}>
            ⚙
          </button>
        </div>
      </nav>
      <main className={s.main}>
        {!conn.reachable && (
          <div className={s.banner} role="status">
            Reconnecting to the daemon…
          </div>
        )}
        {state.notice && (
          <div className={s.notice} data-testid="notice" role="alert">
            <span>{state.notice}</span>
            <button data-testid="notice-dismiss" onClick={actions.dismissNotice}>
              Dismiss
            </button>
          </div>
        )}
        {home && (
          <div className={s.topRight}>
            <HealthPill conn={conn} cost={cost} openSetup={openSetup} />
            <ModelPicker api={api} conn={conn} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
```

Replace `app/src/shell/Splash.tsx` entirely:

```tsx
import { useEffect, useState } from "react";
import { daemonLogTail, daemonStatus, isTauri, type SupervisorStatus } from "../lib/tauri";
import type { DaemonConn } from "../state/useDaemon";
import s from "./Splash.module.css";

// Shown until the app has a DaemonApi. Inside Tauri it reflects the supervisor; when the
// daemon won't start it shows the last log lines with Copy log (spec: Error handling).
export function Splash(_props: { conn: DaemonConn }) {
  const [sup, setSup] = useState<SupervisorStatus | null>(null);
  const [log, setLog] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = async () => {
      const x = await daemonStatus().catch(() => null);
      if (!alive) return;
      setSup(x);
      if (x?.state === "failed") setLog(await daemonLogTail(40).catch(() => ""));
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const failed = sup?.state === "failed";
  const title = failed ? "The daemon won't start" : sup?.state === "restarting" ? "Restarting the daemon…" : "Starting the daemon…";
  const copy = async () => {
    await navigator.clipboard.writeText(log);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={s.splash} data-testid="splash">
      <div className={s.logo} aria-hidden>
        ◎
      </div>
      <div className={s.title}>{title}</div>
      {!failed && <div className={s.spinner} />}
      {sup && sup.restarts > 0 && !failed && <div className={s.muted}>Restart {sup.restarts} of 3.</div>}
      {failed && (
        <>
          <div className={s.muted}>{sup?.last_error ?? "It exited during startup three times."}</div>
          <pre className={s.log}>{log || "(no output captured)"}</pre>
          <button className={s.btn} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy log"}
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Verify everything**

Run: `cd app && npm run typecheck && npm test && E2E_PORT=1431 npx playwright test e2e/home.spec.ts e2e/smoke.spec.ts`
Expected: typecheck clean, unit tests pass, and every home and smoke test passes.

If U8 has not merged yet, the `daemon down` test fails because the mock ignores `?down=1`. In that case, run every other test with `--grep-invert "daemon down"` and note it in the hand-off. The orchestrator re-runs it after U8 merges, and it must pass then.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell app/e2e/home.spec.ts
git commit -m "app/U1: app shell (history rail, health pill with fix links, model picker, notices, splash)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes (for the orchestrator; U1 does not change any contract)

- **U8 must support `?down=1`** in the mock: `health()` rejects, which drives `conn.reachable=false`. All other mock calls can keep working. U1's `daemon down` e2e test depends on it.
- **Extra test ids** used here, outside C8: `history-toggle` (rail history drawer) and `settings` (gear). They are additive. W2-1 may use them.
- **The pill is placed by phase.** On Home, the full pill and model picker sit top-right. On other phases, a compact dot sits in the rail, so it never collides with U4's workspace header. U4 and U5 don't render their own health pill.
