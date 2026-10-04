export type CardId = "waves" | "ai" | "context" | "science" | "events";
export interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const CARD_LAYOUT_KEY = "seismicx-cards-v1";
export const defaultCards: Record<CardId, CardRect> = {
  waves: { x: 0.35, y: 0.62, w: 0.34, h: 0.27 },
  events: { x: 0.035, y: 0.62, w: 0.295, h: 0.27 },
  ai: { x: 0.715, y: 0.17, w: 0.26, h: 0.22 },
  context: { x: 0.715, y: 0.41, w: 0.26, h: 0.24 },
  science: { x: 0.715, y: 0.67, w: 0.26, h: 0.22 },
};
// Normalized, finite coordinates survive resizing the window without losing handles.
export function clampCard(
  rect: CardRect,
  width: number,
  height: number,
): CardRect {
  const minW = Math.min(0.9, 240 / width),
    minH = Math.min(0.8, 145 / height);
  const bottom = Math.max(0.6, 1 - 102 / height);
  const w = Math.max(minW, Math.min(0.95, rect.w)),
    h = Math.max(minH, Math.min(bottom - 0.12, rect.h));
  return {
    x: Math.max(0.01, Math.min(0.99 - w, rect.x)),
    y: Math.max(0.12, Math.min(bottom - h, rect.y)),
    w,
    h,
  };
}
export function readCard(raw: string | null, id: CardId): CardRect {
  try {
    const r = JSON.parse(raw || "{}")[id];
    if (
      r &&
      ["x", "y", "w", "h"].every(
        (k) => typeof r[k] === "number" && Number.isFinite(r[k]),
      )
    )
      return r;
  } catch {
    /* Corrupt preferences never break a broadcast. */
  }
  return defaultCards[id];
}
