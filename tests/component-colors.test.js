import assert from "node:assert/strict";
import test from "node:test";

import { ORIGIN_CLASSIC_COMPONENT_COLORS, componentColor } from "../src/lib/component-colors.js";

test("component spectra begin with the classical Origin color sequence", () => {
  assert.deepEqual(ORIGIN_CLASSIC_COMPONENT_COLORS.slice(0, 5), [
    "#000000",
    "#ff0000",
    "#008000",
    "#0000ff",
    "#00bfc4",
  ]);
  assert.equal(componentColor(0), "#000000");
  assert.equal(componentColor(4), "#00bfc4");
  assert.equal(componentColor(ORIGIN_CLASSIC_COMPONENT_COLORS.length), "#000000");
});
