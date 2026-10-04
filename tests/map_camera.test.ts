import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cameraPose } from "../src/platform/broadcast/mapCamera.ts";
const fixed = {
  longitude: 105,
  latitude: 35,
  range: 3500000,
  heading: 0,
  pitch: -55,
};
test("fixed views stay put when the event and playback time change", () => {
  for (const mode of ["region", "global"] as const) {
    assert.deepEqual(
      cameraPose(mode, 179, 52, 0, fixed, true),
      cameraPose(mode, -179, -42, 0.5, fixed, true),
    );
  }
});
test("epicentral tour returns to a global view without inventing event coordinates", () => {
  const start = cameraPose("epicenter", -179, 52, 0, fixed, true);
  const close = cameraPose("epicenter", -179, 52, 0.5, fixed, true);
  const end = cameraPose("epicenter", -179, 52, 1, fixed, true);
  assert.ok(start.range > 18000000 && close.range < 101000);
  assert.equal(start.range, end.range);
  assert.equal(close.longitude, -179);
  assert.equal(close.latitude, 52);
  assert.ok(close.pitch > -60);
});
test("reduced motion produces a stable regional view", () => {
  assert.deepEqual(
    cameraPose("epicenter", 140, 36, 0, fixed, false),
    cameraPose("epicenter", 140, 36, 0.8, fixed, false),
  );
});
