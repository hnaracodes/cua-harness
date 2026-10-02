// app/src/canvas/constants.ts
export const BADGE_R = 13;      // ~26pt badge, constant on screen
export const HANDLE_R = 4.5;    // visual handle radius
export const HANDLE_HIT = 14;   // generous grab radius (screen px)
export const EDGE_HIT = 9;
export const BADGE_HIT = BADGE_R + 2;
export const DRAG_THRESHOLD = 3;
export const MIN_AREA_PX = 180; // reject scribbles smaller than this (screen px²)
export const MARGIN = { left: 44, right: 16, top: 16, bottom: 40 };
export type Tool = "draw" | "pan";
