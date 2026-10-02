// app/src/canvas/useBadgeLayout.ts
import { useMemo } from "react";
import type { Point, Step } from "../api/types";
import { rawPoint, type ScoreIndex } from "../lib/approval";
import { clampPoint } from "../lib/geometry";
import { groupStacks, minSeparation } from "../lib/stacks";
import { dataToBase, type Rect } from "../lib/viewport";
import { BADGE_R } from "./constants";

export interface LaidStack { key: string; ids: string[]; centerBase: Point }
export interface BadgeLayout {
  byId: Map<string, Step>;
  data: Map<string, Point>;   // TRUE point (classification uses this, via lib/approval)
  base: Map<string, Point>;   // TRUE point in base px; badges render exactly here
  stacks: LaidStack[];        // singletons are stacks of one
}

export function useBadgeLayout(steps: Step[], idx: ScoreIndex, xKey: string, yKey: string, plot: Rect, scale: number): BadgeLayout {
  const pts = useMemo(() => {
    const byId = new Map<string, Step>(), data = new Map<string, Point>(), base = new Map<string, Point>();
    for (const s of steps) {
      const raw = rawPoint(idx, s.id, xKey, yKey);
      if (!raw) continue;
      byId.set(s.id, s);
      data.set(s.id, raw);
      base.set(s.id, dataToBase(clampPoint(raw), plot));
    }
    return { byId, data, base };
  }, [steps, idx, xKey, yKey, plot]);
  const stacks = useMemo(
    () =>
      groupStacks([...pts.base].map(([id, b]) => ({ id, px: [b[0] * scale, b[1] * scale] as Point })), minSeparation(BADGE_R)).map((s) => ({
        key: s.key,
        ids: s.ids,
        centerBase: [s.center[0] / scale, s.center[1] / scale] as Point,
      })),
    [pts, scale],
  );
  return useMemo(() => ({ ...pts, stacks }), [pts, stacks]);
}
