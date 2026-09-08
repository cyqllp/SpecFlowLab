import assert from "node:assert/strict";
import test from "node:test";

import { comparisonStyleDefaults } from "../src/lib/comparison-style.js";

test("dataset comparison defaults to solid Origin-classic styles", () => {
  const styles = Array.from({ length: 5 }, (_, index) => comparisonStyleDefaults(index, `Dataset ${index + 1}`));
  assert.deepEqual(styles.map((style) => style.color), ["#000000", "#ff0000", "#008000", "#0000ff", "#00bfc4"]);
  assert.equal(styles.every((style) => style.lineStyle === "solid"), true);
});
