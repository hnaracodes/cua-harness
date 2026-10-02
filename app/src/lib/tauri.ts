// Every Tauri API is guarded: the same app runs in a plain browser at
// http://localhost:1420 for Playwright verification.

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

/** Float the oversight window above the agent's desk during execution. */
export async function setAlwaysOnTop(on: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setAlwaysOnTop(on);
  } catch (e) {
    console.warn("setAlwaysOnTop failed", e);
  }
}

export interface SupervisorStatus {
  state: "starting" | "running" | "restarting" | "failed" | "external";
  restarts: number;
  last_error: string | null;
}

/** Daemon supervisor status from the Rust shell. Null outside Tauri or on error. */
export async function daemonStatus(): Promise<SupervisorStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SupervisorStatus>("daemon_status");
  } catch (e) {
    console.warn("daemon_status failed", e);
    return null;
  }
}

/** Last `lines` lines of daemon output captured by the shell. "" outside Tauri. */
export async function daemonLogTail(lines: number): Promise<string> {
  if (!isTauri()) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("daemon_log_tail", { lines });
  } catch (e) {
    console.warn("daemon_log_tail failed", e);
    return "";
  }
}

/** Probe every `intervalMs` until it returns true or `timeoutMs` elapses (inclusive). */
export async function pollUntil(
  probe: () => Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const end = now() + opts.timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (now() >= end) return false;
    await sleep(opts.intervalMs);
  }
}
