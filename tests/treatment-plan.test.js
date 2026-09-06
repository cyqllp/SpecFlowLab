import assert from "node:assert/strict";
import test from "node:test";

import {
  changedTreatmentDatasetIds,
  snapshotTreatmentStates,
  treatmentEnabled,
} from "../src/lib/treatment-plan.js";

test("re-enabling a reset dataset treatment does not invalidate folder siblings", () => {
  const folder = { id: "folder", treatments: { baseline: true, chirp: true } };
  const datasets = [
    { id: "active", treatmentOverrides: { baseline: true, chirp: true } },
    { id: "sibling", treatmentOverrides: { baseline: false, chirp: false } },
  ];
  const before = snapshotTreatmentStates(datasets, folder);

  datasets[0].treatmentOverrides.baseline = false;

  assert.equal(treatmentEnabled(datasets[0], folder, "baseline"), true);
  assert.deepEqual(changedTreatmentDatasetIds(datasets, folder, before), ["active"]);
});

test("changing a folder treatment reports every dataset whose analysis changed", () => {
  const folder = { id: "folder", treatments: { baseline: false, chirp: false } };
  const datasets = [
    { id: "first", treatmentOverrides: {} },
    { id: "second", treatmentOverrides: {} },
  ];
  const before = snapshotTreatmentStates(datasets, folder);

  folder.treatments.baseline = true;

  assert.deepEqual(changedTreatmentDatasetIds(datasets, folder, before), ["first", "second"]);
});
