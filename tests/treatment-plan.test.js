import assert from "node:assert/strict";
import test from "node:test";

import {
  changedTreatmentDatasetIds,
  snapshotTreatmentStates,
  treatmentEnabled,
  chirpHintForDataset,
  configureChirpTreatment,
  chirpFitRangeForDataset,
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

test("a local chirp retry changes only its dataset, not the folder hint or sibling settings", () => {
  const folder = { id: "f", treatments: { baseline: true, chirp: true }, chirpZeroTimePs: 1 };
  const datasets = [{ id: "a", folderId: "f" }, { id: "b", folderId: "f" }];
  const before = structuredClone({ folder, datasets });
  const result = configureChirpTreatment(datasets, folder, { datasetId: "a", enabled: true, approximateZeroTimePs: 2 });
  assert.deepEqual({ folder, datasets }, before);
  assert.deepEqual(result.affectedIds, ["a"]);
  assert.equal(result.folder, folder);
  assert.equal(result.datasets[1], datasets[1]);
  assert.equal(chirpHintForDataset(result.datasets[0], result.folder), 2);
  assert.equal(chirpHintForDataset(result.datasets[1], result.folder), 1);
});

test("local chirp enable and remove work independently of the folder default", () => {
  const folder = { id: "f", treatments: { chirp: false } };
  const datasets = [{ id: "a", folderId: "f" }, { id: "b", folderId: "f" }];
  const enabled = configureChirpTreatment(datasets, folder, { datasetId: "a", enabled: true, approximateZeroTimePs: 1 });
  assert.equal(treatmentEnabled(enabled.datasets[0], folder, "chirp"), true);
  assert.equal(treatmentEnabled(enabled.datasets[1], folder, "chirp"), false);
  const removed = configureChirpTreatment(enabled.datasets, folder, { datasetId: "a", enabled: false });
  assert.equal(treatmentEnabled(removed.datasets[0], folder, "chirp"), false);
  assert.equal(chirpHintForDataset(removed.datasets[0], folder), 1);
});

test("an explicit folder action replaces local chirp choices only in that folder", () => {
  const folder = { id: "f", treatments: { chirp: false } };
  const datasets = [{ id: "a", folderId: "f", chirpSettings: { enabled: true, approximateZeroTimePs: 2 } }, { id: "b", folderId: "other" }];
  const result = configureChirpTreatment(datasets, folder, { datasetId: "a", scope: "folder", enabled: true, approximateZeroTimePs: 1 });
  assert.equal(result.folder.chirpZeroTimePs, 1);
  assert.equal(result.datasets[0].chirpSettings, null);
  assert.equal(treatmentEnabled(result.datasets[0], result.folder, "chirp"), true);
  assert.equal(result.datasets[1], datasets[1]);
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

test("local fitting-range changes and auto overrides do not affect folder siblings", () => {
  const folder = { id: 'f', treatments: { chirp: true }, chirpFitRange: { min: 400, max: 700 } };
  const datasets = [{ id: 'a', folderId: 'f' }, { id: 'b', folderId: 'f' }];
  const local = configureChirpTreatment(datasets, folder, { datasetId: 'a', enabled: true, fitRange: null });
  assert.equal(chirpFitRangeForDataset(local.datasets[0], folder), null);
  assert.deepEqual(chirpFitRangeForDataset(local.datasets[1], folder), { min: 400, max: 700 });
  const manual = configureChirpTreatment(datasets, folder, { datasetId: 'a', enabled: true, fitRange: { min: 420, max: 680 } });
  assert.deepEqual(chirpFitRangeForDataset(manual.datasets[0], folder), { min: 420, max: 680 });
  assert.deepEqual(folder.chirpFitRange, { min: 400, max: 700 });
});
