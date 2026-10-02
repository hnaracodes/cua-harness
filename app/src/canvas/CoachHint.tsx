import css from "./BoundaryCanvas.module.css";

const KEY = "oversight.coach.loopDone";
export function readCoachDone(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function writeCoachDone(): void {
  try { localStorage.setItem(KEY, "1"); } catch { /* storage blocked: hint just shows again next time */ }
}
export function CoachHint() {
  return <div className={css.coach} data-testid="coach-hint">Drag a loop to approve · pinch or ⌘-scroll to zoom · two-finger drag or space-drag to pan</div>;
}
