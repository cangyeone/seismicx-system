import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  filterEvents,
  mergeNotices,
} from "../src/platform/broadcast/liveEvents.ts";
import type { Quake } from "../src/platform/types.ts";
import type { Bulletin } from "../src/platform/broadcastState.ts";
const now = Date.parse("2026-10-03T01:00:00Z");
const options = { minMagnitude: 2, source: "all", candidates: false };
const event = (id: string, ago = 0, extra = {}) =>
  ({
    id,
    origin_time: new Date(now - ago).toISOString(),
    magnitude: 4.5,
    status: "external",
    source: "USGS",
    ...extra,
  }) as Quake;
const notice = (e: Quake, seq: number) =>
  ({ ...e, seq, received_at: new Date(now).toISOString() }) as Bulletin;
test("latest incoming earthquake takes priority even when sequence reflects import order", () => {
  const old = notice(event("old", 60000), 9),
    recent = notice(event("latest"), 10);
  const pending = mergeNotices(
    [old],
    [recent, { ...old, seq: 11 }],
    options,
    now,
  );
  assert.deepEqual(
    pending.map((e) => e.id),
    ["latest", "old"],
  );
  assert.equal(pending[1].seq, 11);
  assert.equal(
    mergeNotices(
      [],
      [{ ...recent, received_at: new Date(now - 600000).toISOString() }],
      options,
      now,
    ).length,
    0,
  );
  assert.equal(
    mergeNotices(
      [],
      [notice(event("candidate", 0, { status: "candidate" }), 12)],
      options,
      now,
    ).length,
    0,
  );
});
test("fresh feed replaces playlist, updates revisions and retains source filtering", () => {
  const older = event("older", 50000),
    newer = event("newer");
  assert.deepEqual(
    filterEvents([older, newer], options).map((e) => e.id),
    ["newer", "older"],
  );
  assert.deepEqual(
    filterEvents([{ ...newer, magnitude: 5.1 }], options).map(
      (e) => e.magnitude,
    ),
    [5.1],
  );
  const china = event("cenc", 0, { source: "CENC" });
  assert.equal(
    filterEvents([{ ...newer, alternate_reports: [china] }], {
      ...options,
      source: "CENC",
    })[0].id,
    "cenc",
  );
  assert.equal(
    filterEvents([event("small", 0, { magnitude: 1 })], options).length,
    0,
  );
});
