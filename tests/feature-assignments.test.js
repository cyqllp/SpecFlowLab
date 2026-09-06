import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyEvidenceGraph, migrateEvidenceGraph, validateEvidenceGraph } from "../src/lib/evidence-graph/schema.js";
import {
  FEATURE_ASSIGNMENTS,
  deleteFeatureSignature,
  normalizeFeatureAssignment,
  upsertFeatureAssignment,
  upsertFeatureSignature,
} from "../src/lib/evidence-graph/entities.js";
import { createManualSignature, mergeFeatureSignatures } from "../src/lib/feature-monitor/signatures.js";

const CANDIDATE = {
  id: "feature-candidate:dataset-a:eas:c02:r01",
  featureCode: "F2.1",
  componentIndex: 1,
  wavelengthMin: 473,
  wavelengthMax: 598,
  wavelengthCenter: 535.6,
  candidateType: "Negative feature: GSB or SE candidate",
};

function baseGraph() {
  const graph = createEmptyEvidenceGraph();
  graph.entities.push({
    id: "dataset-a",
    kind: "dataset",
    label: "Condition A",
    datasetId: "dataset-a",
  });
  return graph;
}

test("feature assignment vocabulary is the approved fixed set", () => {
  assert.deepEqual(FEATURE_ASSIGNMENTS, ["ESA", "GSB", "SE", "GSB or SE"]);
  assert.equal(normalizeFeatureAssignment("esa"), "ESA");
  assert.equal(normalizeFeatureAssignment("GSB or SE"), "GSB or SE");
  assert.equal(normalizeFeatureAssignment("unassigned"), "unassigned");
  assert.equal(normalizeFeatureAssignment(""), "unassigned");
  assert.throws(() => normalizeFeatureAssignment("hot band"), /Unsupported feature assignment/i);
});

test("first assignment creates a feature entity in the graph", () => {
  const graph = upsertFeatureAssignment(baseGraph(), { ...CANDIDATE, datasetId: "dataset-a", mode: "EAS" }, "GSB", "tentative overlap with ground-state bleach", [{ id: "dataset-a" }], { createdAt: "2026-08-23T08:00:00.000Z" });

  const entity = graph.entities.find((item) => item.id === CANDIDATE.id);
  assert.ok(entity);
  assert.equal(entity.kind, "feature");
  assert.equal(entity.assignment, "GSB");
  assert.equal(entity.mode, "EAS");
  assert.equal(entity.datasetId, "dataset-a");
  assert.equal(entity.featureCode, "F2.1");
  assert.equal(entity.note, "tentative overlap with ground-state bleach");
  assert.equal(entity.author, "project-user");
  assert.equal(entity.createdAt, "2026-08-23T08:00:00.000Z");
  assert.equal(entity.updatedAt, "2026-08-23T08:00:00.000Z");
  assert.equal(entity.label, "F2.1 GSB");
  assert.equal(graph.annotations.length, 0);
  validateEvidenceGraph(graph, [{ id: "dataset-a" }]);
});

test("updating an assignment preserves provenance and note unless replaced", () => {
  const first = upsertFeatureAssignment(baseGraph(), { ...CANDIDATE, datasetId: "dataset-a", mode: "EAS" }, "GSB", "tentative", [{ id: "dataset-a" }], { createdAt: "2026-08-23T08:00:00.000Z" });
  const second = upsertFeatureAssignment(first, { ...CANDIDATE, datasetId: "dataset-a", mode: "EAS" }, "SE", null, [{ id: "dataset-a" }], { createdAt: "2026-08-23T09:00:00.000Z", author: "reviewer" });

  const entity = second.entities.find((item) => item.id === CANDIDATE.id);
  assert.equal(entity.assignment, "SE");
  assert.equal(entity.note, "tentative");
  assert.equal(entity.author, "reviewer");
  assert.equal(entity.createdAt, "2026-08-23T08:00:00.000Z");
  assert.equal(entity.updatedAt, "2026-08-23T09:00:00.000Z");
  assert.equal(second.entities.filter((item) => item.kind === "feature").length, 1);
});

test("unassigning removes the feature entity and annotations targeting it", () => {
  const annotation = { id: "annotation:feature-assignment", kind: "annotation", targetId: CANDIDATE.id, targetKind: "feature", text: "ESA", tags: ["feature-assignment"], author: "project-user", createdAt: "2026-08-23T08:00:00.000Z", updatedAt: null, status: "recorded", origin: "feature-assignment", statusHistory: [] };
  const assigned = upsertFeatureAssignment(baseGraph(), { ...CANDIDATE, datasetId: "dataset-a", mode: "EAS" }, "ESA", "", [{ id: "dataset-a" }]);
  assigned.annotations.push(annotation);
  assert.equal(assigned.entities.some((item) => item.id === CANDIDATE.id), true);

  const cleared = upsertFeatureAssignment(assigned, { ...CANDIDATE, datasetId: "dataset-a", mode: "EAS" }, "unassigned", "", [{ id: "dataset-a" }]);
  assert.equal(cleared.entities.some((item) => item.id === CANDIDATE.id), false);
  assert.equal(cleared.annotations.some((item) => item.targetId === CANDIDATE.id), false);
  validateEvidenceGraph(cleared, [{ id: "dataset-a" }]);
});

test("feature entities survive graph migration and validation", () => {
  const graph = upsertFeatureAssignment(baseGraph(), { ...CANDIDATE, datasetId: "dataset-a", mode: "DAS" }, "ESA", "dominant positive band", [{ id: "dataset-a" }]);
  const migrated = migrateEvidenceGraph(graph, [{ id: "dataset-a" }]);

  const entity = migrated.entities.find((item) => item.id === CANDIDATE.id);
  assert.equal(entity.kind, "feature");
  assert.equal(entity.assignment, "ESA");
  assert.doesNotThrow(() => validateEvidenceGraph(migrated, [{ id: "dataset-a" }]));
});

test("orphaned feature entities are tolerated by validation", () => {
  const graph = upsertFeatureAssignment(baseGraph(), { ...CANDIDATE, datasetId: "removed-dataset", mode: "EAS" }, "GSB", "", [{ id: "dataset-a" }]);
  // datasetId references a dataset that is no longer present; the graph must still validate.
  assert.doesNotThrow(() => validateEvidenceGraph(graph, [{ id: "dataset-a" }]));
});

test("manual signatures persist exact EAS positions and editable details", () => {
  const dataset = { id: "dataset-a" };
  const signature = createManualSignature(dataset, 1, 612.4, -0.03, {
    sequence: 2,
    createdAt: "2026-08-27T08:00:00.000Z",
    idSuffix: "test",
  });
  const graph = upsertFeatureSignature(baseGraph(), signature, {
    assignment: "SE",
    label: "red-edge emission",
    note: "selected directly on EAS 2",
  }, [dataset], { createdAt: "2026-08-27T08:00:00.000Z" });
  const entity = graph.entities.find((item) => item.id === signature.id);

  assert.equal(entity.signatureSource, "manual");
  assert.equal(entity.wavelengthCenter, 612.4);
  assert.equal(entity.componentIndex, 1);
  assert.equal(entity.assignment, "SE");
  assert.equal(entity.label, "red-edge emission");
  assert.equal(entity.note, "selected directly on EAS 2");
});

test("automatic signatures can be edited and persistently deleted", () => {
  const dataset = { id: "dataset-a" };
  const monitor = { candidates: [{ ...CANDIDATE, sign: "negative", datasetId: dataset.id, mode: "EAS" }] };
  const edited = upsertFeatureSignature(baseGraph(), monitor.candidates[0], {
    assignment: "GSB",
    wavelengthCenter: 541.2,
  }, [dataset], { createdAt: "2026-08-27T08:00:00.000Z" });
  const merged = mergeFeatureSignatures(dataset, monitor, edited.entities);
  assert.equal(merged[0].assignment, "GSB");
  assert.equal(merged[0].wavelengthCenter, 541.2);

  const deleted = deleteFeatureSignature(edited, merged[0], [dataset], { createdAt: "2026-08-27T09:00:00.000Z" });
  assert.deepEqual(mergeFeatureSignatures(dataset, monitor, deleted.entities), []);
  assert.equal(deleted.entities.find((item) => item.id === CANDIDATE.id).signatureDeleted, true);
});

test("manual signatures stay isolated to their EAS or DAS spectrum mode", () => {
  const dataset = { id: "dataset-a" };
  const eas = createManualSignature(dataset, 0, 510, 0.02, { mode: "EAS", idSuffix: "eas" });
  const das = createManualSignature(dataset, 0, 620, -0.01, { mode: "DAS", idSuffix: "das" });
  let graph = upsertFeatureSignature(baseGraph(), eas, {}, [dataset]);
  graph = upsertFeatureSignature(graph, das, {}, [dataset]);

  assert.deepEqual(
    mergeFeatureSignatures(dataset, { spectrumMode: "EAS", candidates: [] }, graph.entities).map((item) => item.wavelengthCenter),
    [510],
  );
  assert.deepEqual(
    mergeFeatureSignatures(dataset, { spectrumMode: "DAS", candidates: [] }, graph.entities).map((item) => item.wavelengthCenter),
    [620],
  );
});
