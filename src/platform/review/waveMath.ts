import type { Wave } from "../types";
export const PHASES = ["Pg", "Sg", "Pn", "Sn", "P", "S"] as const;
export type Phase = (typeof PHASES)[number];
export interface TimeWindow {
  start: number;
  end: number;
}
export function clampWindow(view: TimeWindow, bounds: TimeWindow): TimeWindow {
  const span = Math.min(
    bounds.end - bounds.start,
    Math.max(0.1, view.end - view.start),
  );
  const start = Math.max(bounds.start, Math.min(bounds.end - span, view.start));
  return { start, end: start + span };
}
export function zoomWindow(
  view: TimeWindow,
  factor: number,
  anchor: number,
  bounds: TimeWindow,
) {
  const fraction = Math.max(0, Math.min(1, anchor));
  const span = Math.min(
    bounds.end - bounds.start,
    Math.max(0.1, (view.end - view.start) * factor),
  );
  const start =
    view.start + (view.end - view.start) * fraction - span * fraction;
  return clampWindow({ start, end: start + span }, bounds);
}
export function panWindow(view: TimeWindow, start: number, bounds: TimeWindow) {
  return clampWindow({ start, end: start + view.end - view.start }, bounds);
}
export function tracePath(
  trace: Wave["traces"][number],
  originMs: number,
  view: TimeWindow,
  left: number,
  width: number,
  center: number,
  height: number,
) {
  const offset = (Date.parse(trace.start) - originMs) / 1000;
  const visible = trace.points.filter(
    (p) => p[0] + offset >= view.start && p[0] + offset <= view.end,
  );
  const scale = Math.max(
    1,
    ...visible.map((p) => Math.max(Math.abs(p[1] || 0), Math.abs(p[2] || 0))),
  );
  const raw = trace.sample_stride === 1;
  let pen = false,
    path = "";
  for (const [t, low, high] of visible) {
    if (low === null || high === null) {
      pen = false;
      continue;
    }
    const x =
      left + ((t + offset - view.start) / (view.end - view.start)) * width;
    const y = center - (low / scale) * height;
    if (raw) {
      path += `${pen ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`;
      pen = true;
    } else
      path += `M${x.toFixed(3)},${y.toFixed(3)}L${x.toFixed(3)},${(center - (high / scale) * height).toFixed(3)}`;
  }
  return path;
}
export function sampleTime(
  seconds: number,
  trace: Wave["traces"][number],
  originMs: number,
) {
  const offset = (Date.parse(trace.start) - originMs) / 1000;
  return (
    offset +
    Math.round((seconds - offset) * trace.sample_rate) / trace.sample_rate
  );
}
