import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  clampCard,
  readCard,
  defaultCards,
} from "../src/platform/broadcast/cardLayout.ts";
// @ts-expect-error Public service worker policy is JavaScript, shared without bundling.
import { cacheable } from "../public/map-cache-policy.js";
test("card layouts stay in the viewport with reachable handles after resizing", () => {
  for (const [w, h] of [
    [1440, 900],
    [1024, 700],
    [320, 640],
  ]) {
    for (const r of [
      { x: -4, y: 7, w: 9, h: 20 },
      { x: 0.9, y: 0.9, w: 0.01, h: 0.01 },
    ]) {
      const rect = clampCard(r, w, h);
      assert.ok(rect.x >= 0.01 && rect.y >= 0.12);
      assert.ok(rect.x + rect.w <= 0.991 && rect.y + rect.h <= 0.911);
    }
  }
  assert.deepEqual(readCard("not-json", "ai"), defaultCards.ai);
  assert.deepEqual(
    readCard('{"ai":{"x":null,"y":1,"w":1,"h":1}}', "ai"),
    defaultCards.ai,
  );
});
test("map cache excludes live data, credentials, auth, private settings and mutations", () => {
  const origin = "https://example.com";
  for (const path of [
    "/api/auth/me",
    "/api/settings",
    "/api/events",
    "/api/broadcast/feed",
    "/admin",
    "/",
    "/assets/a-Ab12.js?token=secret",
    "https://foreign.example/world.geojson",
  ])
    assert.equal(cacheable(path, origin), false, path);
  for (const path of [
    "/world.geojson",
    "/plates.geojson",
    "/api/map/tiles/elevation/2/1/2",
    "/assets/globeEngine-Ab12.js",
    "/cesium/Workers/createBoxGeometry.js",
  ]) {
    assert.equal(cacheable(path, origin), true, path);
    assert.equal(cacheable(path, origin, "POST"), false);
  }
});
