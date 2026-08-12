import {
  HYPOTHESIS_STATUSES,
  migrateEvidenceGraph,
  normalizeDatasetEvidence,
  stableEntityId,
  validateEvidenceGraph,
} from "./schema.js";

export function updateDatasetEvidenceEntities(graph, dataset, datasets = [], options = {}) {
  const nextDatasets = datasets.map((item) => item.id === dataset.id ? dataset : item);
  const next = migrateEvidenceGraph(graph, nextDatasets, options);
  const metadata = normalizeDatasetEvidence(dataset.evidenceMetadata);
  const labels = Array.isArray(options.speciesLabels) ? options.speciesLabels : [];
  const speciesIds = [];
  labels.map((label) => String(label).trim()).filter(Boolean).forEach((label) => {
    const id = stableEntityId("species-hypothesis", label);
    speciesIds.push(id);
    const current = next.entities.find((entity) => entity.id === id);
    if (!current) {
      next.entities.push({
        id,
        kind: "species-hypothesis",
        label,
        status: "proposed",
        author: options.author ?? "project-user",
        createdAt: options.createdAt ?? null,
        rationale: "Candidate species/state recorded in Dataset Details.",
        statusHistory: [],
        attributes: {},
      });
    }
  });
  metadata.speciesStateIds = [...new Set(speciesIds)];
  dataset.evidenceMetadata = metadata;
  const datasetEntity = next.entities.find((entity) => entity.id === dataset.id);
  if (datasetEntity) {
    datasetEntity.attributes = {
      ...(datasetEntity.attributes ?? {}),
      technique: metadata.technique,
      measurementRole: metadata.measurementRole,
      sampleId: metadata.sampleId || null,
      preparationId: metadata.preparationId || null,
      speciesStateIds: metadata.speciesStateIds,
      conditions: metadata.conditions,
    };
  }
  validateEvidenceGraph(next, nextDatasets);
  return next;
}

export function setSpeciesHypothesisStatus(graph, entityId, status, rationale, datasets = [], options = {}) {
  if (!HYPOTHESIS_STATUSES.includes(status)) throw new Error(`Unsupported hypothesis status: ${status}.`);
  const next = migrateEvidenceGraph(graph, datasets, options);
  const entity = next.entities.find((item) => item.id === entityId && item.kind === "species-hypothesis");
  if (!entity) throw new Error(`Unknown species hypothesis: ${entityId}.`);
  const now = options.createdAt ?? new Date().toISOString();
  entity.statusHistory = [...(entity.statusHistory ?? []), {
    from: entity.status ?? "proposed",
    to: status,
    rationale: String(rationale || "").trim(),
    author: options.author ?? "project-user",
    createdAt: now,
  }];
  entity.status = status;
  entity.updatedAt = now;
  validateEvidenceGraph(next, datasets);
  return next;
}
