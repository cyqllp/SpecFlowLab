import assert from "node:assert/strict";
import test from "node:test";

import { removeEvidenceConnection, upsertEvidenceConnection } from "../src/lib/evidence-graph/connections.js";
import { updateDatasetEvidenceEntities } from "../src/lib/evidence-graph/entities.js";
import {
  EVIDENCE_GRAPH_SCHEMA,
  legacySampleNoteAnnotationId,
  migrateEvidenceGraph,
  validateEvidenceGraph,
} from "../src/lib/evidence-graph/schema.js";

test("legacy Unicode sample notes migrate losslessly into stable dataset annotations", () => {
  const datasets = [dataset("d1", "样品 α：氮气，700 nm")];
  const first = migrateEvidenceGraph(null, datasets, { createdAt: "2026-08-12T00:00:00.000Z" });
  const second = migrateEvidenceGraph(JSON.parse(JSON.stringify(first)), datasets, { createdAt: "2026-08-13T00:00:00.000Z" });

  assert.equal(first.schema, EVIDENCE_GRAPH_SCHEMA);
  assert.equal(first.entities.find((entity) => entity.id === "d1").kind, "dataset");
  assert.equal(first.annotations[0].id, legacySampleNoteAnnotationId("d1"));
  assert.equal(first.annotations[0].text, datasets[0].sampleNote);
  assert.deepEqual(second, first);
});

test("dataset evidence creates proposed species entities without changing numerical data", () => {
  const datasets = [dataset("d1", "")];
  const matrixBefore = structuredClone(datasets[0].analysis.matrix);
  datasets[0].evidenceMetadata = {
    technique: { id: "fsta" },
    measurementRole: "primary",
    conditions: { solvent: "toluene" },
  };
  const graph = updateDatasetEvidenceEntities(null, datasets[0], datasets, {
    speciesLabels: ["Radical anion", "Triplet"],
    createdAt: "2026-08-12T00:00:00.000Z",
  });

  assert.equal(graph.entities.filter((entity) => entity.kind === "species-hypothesis").length, 2);
  assert.equal(graph.entities.find((entity) => entity.label === "Radical anion").status, "proposed");
  assert.equal(datasets[0].evidenceMetadata.speciesStateIds.length, 2);
  assert.deepEqual(datasets[0].analysis.matrix, matrixBefore);
});

test("factual and interpretive relationships retain category and authored rationale", () => {
  const datasets = [dataset("d1", ""), dataset("d2", "")];
  let graph = migrateEvidenceGraph(null, datasets);
  graph = updateDatasetEvidenceEntities(graph, datasets[0], datasets, { speciesLabels: ["Radical anion"] });
  const speciesId = graph.entities.find((entity) => entity.kind === "species-hypothesis").id;
  graph = upsertEvidenceConnection(graph, {
    fromId: "d1", toId: "d2", type: "same-sample", rationale: "Aliquots from one preparation",
  }, datasets, { createdAt: "2026-08-12T00:00:00.000Z" });
  graph = upsertEvidenceConnection(graph, {
    fromId: "d1", toId: speciesId, type: "supports-assignment", rationale: "User-authored comparison",
  }, datasets, { createdAt: "2026-08-12T00:01:00.000Z" });

  assert.deepEqual(graph.relationships.map((item) => item.category), ["factual", "interpretive"]);
  assert.throws(() => upsertEvidenceConnection(graph, {
    fromId: "d1", toId: "d2", type: "supports-assignment", rationale: "Invalid endpoints",
  }, datasets), /cannot connect dataset to dataset/i);

  const datasetsBefore = structuredClone(datasets);
  const reduced = removeEvidenceConnection(graph, graph.relationships[0].id, datasets);
  assert.equal(reduced.relationships.length, 1);
  assert.deepEqual(datasets, datasetsBefore);
});

test("graph validation rejects dangling references", () => {
  const datasets = [dataset("d1", "")];
  const graph = migrateEvidenceGraph(null, datasets);
  graph.relationships.push({
    id: "connection:bad",
    fromId: "d1",
    toId: "missing",
    type: "same-sample",
    category: "factual",
    rationale: "Should fail",
  });
  assert.throws(() => validateEvidenceGraph(graph, datasets), /dangling evidence relationship/i);
});

test("external evidence becomes typed graph entities and duplicate bulk assertions update in place", () => {
  const datasets = [dataset("d1", "")];
  const evidenceAssets = [
    { id: "asset:abs", kind: "spectroscopy", label: "Absorption", techniqueId: "absorption", measurementRole: "reference", source: {}, citation: {} },
    { id: "asset:fig", kind: "figure", label: "Figure 3", techniqueId: "other", measurementRole: "supporting", source: {}, citation: {} },
  ];
  let graph = migrateEvidenceGraph(null, datasets, { evidenceAssets });
  assert.equal(graph.entities.find((entity) => entity.id === "asset:abs").kind, "external-dataset");
  assert.equal(graph.entities.find((entity) => entity.id === "asset:fig").kind, "figure-evidence");

  graph = upsertEvidenceConnection(graph, {
    fromId: "d1", toId: "asset:abs", type: "supplemented-by", rationale: "Same sample absorption reference",
  }, datasets, { evidenceAssets, createdAt: "2026-08-13T00:00:00.000Z" });
  graph = upsertEvidenceConnection(graph, {
    fromId: "d1", toId: "asset:abs", type: "supplemented-by", rationale: "Updated authored rationale",
  }, datasets, { evidenceAssets, createdAt: "2026-08-13T00:01:00.000Z" });

  assert.equal(graph.relationships.length, 1);
  assert.equal(graph.relationships[0].rationale, "Updated authored rationale");
  assert.equal(graph.relationships[0].updatedAt, "2026-08-13T00:01:00.000Z");
});

function dataset(id, sampleNote) {
  return {
    id,
    projectLabel: id,
    sampleNote,
    evidenceMetadata: null,
    analysis: { timeAxis: [0, 1], spectralAxis: [500], matrix: [[1, Number.NaN]] },
  };
}
