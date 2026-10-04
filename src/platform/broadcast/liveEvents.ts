import type { Quake } from "../types";
import type { Bulletin, TourSettings } from "../broadcastState";
type Filter = Pick<TourSettings, "minMagnitude" | "source" | "candidates">;
export function matchesEvent(event: Quake, options: Filter) {
  return (
    (event.magnitude ?? -2) >= options.minMagnitude &&
    (options.source === "all" || event.source === options.source) &&
    (options.candidates || event.status !== "candidate")
  );
}
export function filterEvents(events: Quake[], options: Filter): Quake[] {
  return events
    .map((e) =>
      options.source === "all" || e.source === options.source
        ? e
        : e.alternate_reports?.find((r) => r.source === options.source) || e,
    )
    .filter((e) => matchesEvent(e, options))
    .sort(
      (a, b) =>
        Date.parse(b.origin_time) - Date.parse(a.origin_time) ||
        a.id.localeCompare(b.id),
    );
}
export function mergeNotices(
  pending: Bulletin[],
  incoming: Bulletin[],
  options: Filter,
  now = Date.now(),
) {
  return [...new Map([...pending, ...incoming].map((e) => [e.id, e])).values()]
    .filter(
      (e) =>
        matchesEvent(e, options) &&
        now - Date.parse(e.received_at) < 300000 &&
        now >= Date.parse(e.received_at) - 60000,
    )
    .sort(
      (a, b) =>
        Date.parse(b.origin_time) - Date.parse(a.origin_time) || b.seq - a.seq,
    )
    .slice(0, 12);
}
