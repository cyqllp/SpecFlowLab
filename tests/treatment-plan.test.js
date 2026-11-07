import assert from "node:assert/strict";
import test from "node:test";

import {
  changedTreatmentDatasetIds,
  snapshotTreatmentStates,
  treatmentEnabled,
  chirpHintForDataset,
  configureChirpTreatment,
  chirpReferenceForDataset,
  chirpCursorSeeds,
} from "../src/lib/treatment-plan.js";

test("cursor seeds map actual applied shifts including legacy retained reviews", () => {
  const analysis = { timeAxis: [-1, 0, 1], spectralAxis: [400, 600], chirp: { curve: [{ wavelength: 400, shift: 0.2 }, { wavelength: 600, shift: 0.7 }] }, provenance: [{ label: 'Chirp', status: 'applied' }, { label: 'Chirp review', status: 'review-required', attemptedModel: { referenceTime: 99 } }] };
  assert.deepEqual(chirpCursorSeeds(analysis, 1, 1), { time: 0.7, wavelength: 600 });
  assert.deepEqual(chirpCursorSeeds({ ...analysis, provenance: [] }, 1, 1), { time: 0.7, wavelength: 600 });
  assert.deepEqual(chirpCursorSeeds({ ...analysis, provenance: [{ label: 'Chirp', status: 'skipped' }], chirp: { curve: [] } }, 1, 1), { time: 0, wavelength: 600 });
  assert.deepEqual(chirpCursorSeeds(analysis, 99, -1), { time: 1.2, wavelength: 400 });
});

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
  assert.equal(removed.datasets[0].chirpSettings.approximateZeroTimePs, null);
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

test("local reference changes do not affect folder siblings", () => {
  const folder = { id: 'f', treatments: { chirp: true }, chirpReferenceWavelength: 550, chirpFitRange: { min: 400, max: 700 } };
  const datasets = [{ id: 'a', folderId: 'f' }, { id: 'b', folderId: 'f' }];
  const local = configureChirpTreatment(datasets, folder, { datasetId: 'a', enabled: true, approximateZeroTimePs: 0, referenceWavelength: 620 });
  assert.equal(chirpReferenceForDataset(local.datasets[0], folder), 620);
  assert.equal(chirpReferenceForDataset(local.datasets[1], folder), 550);
  assert.equal('fitRange' in local.datasets[0].chirpSettings, false);
  assert.deepEqual(folder.chirpFitRange, { min: 400, max: 700 });
});
