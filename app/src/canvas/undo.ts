// Polygon undo history, one stack per axis pair. Pure; no relative value imports.
export type Poly = [number, number][] | null;
export const UNDO_LIMIT = 50;

export class UndoHistory {
  #stacks = new Map<string, Poly[]>();
  push(key: string, prev: Poly): void {
    const s = this.#stacks.get(key) ?? [];
    s.push(prev ? prev.map((p) => [p[0], p[1]] as [number, number]) : null);
    if (s.length > UNDO_LIMIT) s.shift();
    this.#stacks.set(key, s);
  }
  pop(key: string): { ok: true; poly: Poly } | { ok: false } {
    const s = this.#stacks.get(key);
    return s && s.length ? { ok: true, poly: s.pop()! } : { ok: false };
  }
  size(key: string): number {
    return this.#stacks.get(key)?.length ?? 0;
  }
}
