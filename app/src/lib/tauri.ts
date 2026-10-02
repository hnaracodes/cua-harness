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
