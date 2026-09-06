import assert from "node:assert/strict";
import test from "node:test";

import { originVersionLabel } from "../src/lib/origin-display.js";

test("Origin status presents only the current release version", () => {
  assert.equal(originVersionLabel({ majorVersion: 2024, displayName: "Origin2024 (Origin64)", bitness: 64 }), "Origin 2024");
  assert.equal(originVersionLabel({ majorVersion: 8, minorVersion: 6, displayName: "Origin86 (Origin86)" }), "Origin 8.6");
  assert.equal(originVersionLabel({ displayName: "Origin2023 (Origin64)" }), "Origin 2023");
});
