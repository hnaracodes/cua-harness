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
