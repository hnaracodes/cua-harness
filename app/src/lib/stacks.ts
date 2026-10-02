// Which badges cover each other at the current zoom. Pure and self-contained.
export type Pt = [number, number];
export interface StackItem { id: string; px: Pt } // base px × scale (translation is irrelevant)
export interface Stack { key: string; ids: string[]; center: Pt }

/** Two disks of radius r overlap visibly when their centers are closer than this. */
export const minSeparation = (badgeR: number) => 2 * badgeR - 2;

/** Union-find over pairs closer than `minSepPx`. Deterministic: ids sorted, stacks ordered by first id. */
export function groupStacks(items: readonly StackItem[], minSepPx: number): Stack[] {
  const s = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parent = s.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let a = 0; a < s.length; a++)
    for (let b = a + 1; b < s.length; b++)
      if (Math.hypot(s[a].px[0] - s[b].px[0], s[a].px[1] - s[b].px[1]) < minSepPx) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
  const groups = new Map<number, StackItem[]>();
  s.forEach((it, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), it]);
  });
  return [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => ({
    key: g.map((m) => m.id).join("+"),
    ids: g.map((m) => m.id),
    center: [g.reduce((t, m) => t + m.px[0], 0) / g.length, g.reduce((t, m) => t + m.px[1], 0) / g.length],
  }));
}

/** Zoom above which two base-px points stop overlapping (Infinity for exact ties). */
export function splitScale(a: Pt, b: Pt, minSepPx: number): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  return d === 0 ? Infinity : minSepPx / d;
}

export function stackStatus<S extends string>(ids: readonly string[], status: Readonly<Record<string, S>>, fallback: S): S | "mixed" {
  const first = status[ids[0]] ?? fallback;
  return ids.every((id) => (status[id] ?? fallback) === first) ? first : "mixed";
}

/** Ring positions (screen px) around `center`; radius grows with n so badges never touch. */
export function fanOutPositions(center: Pt, n: number, badgeR: number, gapPx = 6): Pt[] {
  if (n <= 0) return [];
  const minR = 2 * badgeR + gapPx;
  const ring = n === 1 ? minR : Math.max(minR, (badgeR + gapPx / 2) / Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return [center[0] + ring * Math.cos(a), center[1] + ring * Math.sin(a)] as Pt;
  });
}
