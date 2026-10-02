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

/** Daemon supervisor status from the Rust shell. Null outside Tauri. (Track R1 implements.) */
export async function daemonStatus(): Promise<SupervisorStatus | null> {
  return null;
}

/** Last `lines` lines of daemon output captured by the shell. "" outside Tauri. (Track R1.) */
export async function daemonLogTail(_lines: number): Promise<string> {
  return "";
}
