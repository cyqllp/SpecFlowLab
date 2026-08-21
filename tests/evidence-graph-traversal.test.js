import assert from "node:assert/strict";
import test from "node:test";

import { upsertEvidenceConnection } from "../src/lib/evidence-graph/connections.js";
import { migrateEvidenceGraph } from "../src/lib/evidence-graph/schema.js";
import { resolveConnectedEvidenceScope } from "../src/lib/evidence-graph/traversal.js";

test("connected evidence traversal is deterministic and bounded to one explicit hop", () => {
  const datasets = [dataset("a"), dataset("b"), dataset("c"), dataset("unrelated")];
  let evidenceGraph = migrateEvidenceGraph(null, datasets);
  evidenceGraph = upsertEvidenceConnection(evidenceGraph, {
    fromId: "b", toId: "c", type: "reference-for", rationale: "Second hop",
  }, datasets, { createdAt: "2026-08-12T00:00:00.000Z" });
  evidenceGraph = upsertEvidenceConnection(evidenceGraph, {
    fromId: "a", toId: "b", type: "same-sample", rationale: "Explicit first hop",
  }, datasets, { createdAt: "2026-08-12T00:00:01.000Z" });
  const project = { datasets, evidenceGraph };

  const first = resolveConnectedEvidenceScope(project, { kind: "connected-evidence", datasetIds: ["a"] });
  const second = resolveConnectedEvidenceScope(project, { kind: "connected-evidence", datasetIds: ["a"] });

  assert.deepEqual(first.datasets.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(first.relationships.map((item) => item.type), ["same-sample"]);
  assert.equal(first.inclusionReasons.b[0].connectionId, first.relationships[0].id);
  assert.deepEqual(second, first);
});

test("connected scope never infers links from matching filenames", () => {
  const datasets = [dataset("a", "same.csv"), dataset("b", "same.csv")];
  const result = resolveConnectedEvidenceScope({ datasets, evidenceGraph: null }, {
    kind: "connected-evidence",
    datasetIds: ["a"],
  });
  assert.deepEqual(result.datasets.map((item) => item.id), ["a"]);
  assert.deepEqual(result.relationships, []);
});

function dataset(id, fileName = `${id}.csv`) {
  return { id, projectLabel: id, sampleNote: "", source: { fileName }, analysis: { matrix: [] } };
}
