import assert from "node:assert/strict";
import test from "node:test";

import { compareDatasetConditions } from "../src/lib/evidence-graph/comparability.js";

test("condition comparison separates matches, differences, and unknowns without declaring equivalence", () => {
  const left = dataset("left", { solvent: "Toluene", temperature: "298 K", atmosphere: null });
  const right = dataset("right", { solvent: "toluene", temperature: "77 K", atmosphere: "nitrogen" });
  const report = compareDatasetConditions(left, right);

  assert.equal(report.conclusion, "review-required");
  assert.ok(report.matching.some((item) => item.field === "solvent"));
  assert.ok(report.different.some((item) => item.field === "temperature"));
  assert.ok(report.unknown.some((item) => item.field === "atmosphere"));
  assert.equal("equivalent" in report, false);
});

function dataset(id, conditions) {
  return { id, evidenceMetadata: { technique: { id: "fsta" }, measurementRole: "primary", conditions } };
}
