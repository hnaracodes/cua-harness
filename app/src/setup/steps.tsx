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
          aria-label={`${provider === "anthropic" ? "Anthropic" : "OpenAI"} API key`}
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
        <span className={s.ico} aria-hidden="true">⚙</span>
        <div className={s.tx}>cua-driver<small>{d?.installed ? `Installed${d.version ? `, version ${d.version}` : ""}` : "Not installed"}</small></div>
        {!d?.installed ? (
          <button className={`${s.btn} ${s.primary}`} data-testid="setup-driver-install" disabled={busy !== null || !status} onClick={() => void install()}>
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
        <div className={s.row}><span className={s.ico} aria-hidden="true">✓</span><div className={s.tx}>n/a: nothing to grant on {status.platform === "windows" ? "Windows" : "Linux"}</div></div>
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
            <span className={s.ico} aria-hidden="true">{x.icon}</span>
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
