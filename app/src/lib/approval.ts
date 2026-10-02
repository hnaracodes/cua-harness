import type { Point, Score, Step, StepStatus } from "../api/types";
import { pointInPolygon } from "./geometry";

/** One polygon per axis pair, keyed "x_dim|y_dim". */
export type PolygonMap = Record<string, Point[]>;

export const pairKey = (x: string, y: string) => `${x}|${y}`;
export const splitPairKey = (k: string): [string, string] => {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)];
};

/** stepId -> dimension -> Score */
export type ScoreIndex = Map<string, Map<string, Score>>;

export function indexScores(scores: Score[]): ScoreIndex {
  const idx: ScoreIndex = new Map();
  for (const s of scores) {
    let m = idx.get(s.step_id);
    if (!m) idx.set(s.step_id, (m = new Map()));
    m.set(s.dimension, s);
  }
  return idx;
}

/** RAW point for an axis pair. Jitter is cosmetic and never enters here. */
export function rawPoint(idx: ScoreIndex, stepId: string, x: string, y: string): Point | null {
  const m = idx.get(stepId);
  const sx = m?.get(x);
  const sy = m?.get(y);
  if (!sx || !sy) return null;
  return [sx.position, sy.position];
}

export interface Classification {
  status: Record<string, StepStatus>;
  inside: Set<string>;
  approved: number;
  pending: number;
  removed: number;
  /** Stable string so memoized consumers can skip identical results. */
  signature: string;
}

/**
 * The approval rule from the contract addendum: removed if removed; else
 * approved if checked OR inside ANY stored polygon (union over axis pairs,
 * RAW positions, even-odd); else pending.
 */
export function classify(
  steps: Step[],
  idx: ScoreIndex,
  polygons: PolygonMap,
  checked: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Classification {
  const status: Record<string, StepStatus> = {};
  const inside = new Set<string>();
  const pairs = Object.entries(polygons).filter(([, p]) => p.length >= 3);
  let a = 0;
  let p = 0;
  let r = 0;
  let sig = "";
  for (const st of steps) {
    for (const [k, poly] of pairs) {
      const [x, y] = splitPairKey(k);
      const pt = rawPoint(idx, st.id, x, y);
      if (pt && pointInPolygon(pt[0], pt[1], poly)) {
        inside.add(st.id);
        break;
      }
    }
    let s: StepStatus;
    if (removed.has(st.id)) {
      s = "removed";
      r++;
    } else if (checked.has(st.id) || inside.has(st.id)) {
      s = "approved";
      a++;
    } else {
      s = "pending";
      p++;
    }
    status[st.id] = s;
    sig += s[0] + (inside.has(st.id) ? "1" : "0");
  }
  return { status, inside, approved: a, pending: p, removed: r, signature: sig };
}
