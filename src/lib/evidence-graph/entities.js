import {
  HYPOTHESIS_STATUSES,
  migrateEvidenceGraph,
  normalizeDatasetEvidence,
  stableEntityId,
  validateEvidenceGraph,
} from "./schema.js";

export const FEATURE_ASSIGNMENTS = Object.freeze(["ESA", "GSB", "SE", "GSB or SE"]);

export function normalizeFeatureAssignment(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.toLowerCase() === "unassigned") return "unassigned";
  const exact = FEATURE_ASSIGNMENTS.find((candidate) => candidate.toLowerCase() === normalized.toLowerCase());
  if (!exact) throw new Error(`Unsupported feature assignment: ${normalized}. Use ESA, GSB, SE, or "GSB or SE".`);
  return exact;
}

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

/**
 * Record (or retract) a user-authored assignment on a detected EAS/DAS feature
 * region. Assignments live as "feature" entities in the evidence graph so they
 * persist through .sflproj archives and .sflai packages without touching the
 * deterministic feature monitor. Unassigning removes the entity and any
 * annotations that targeted it.
 */
export function upsertFeatureAssignment(graph, candidate, assignment, note, datasets = [], options = {}) {
  const normalized = normalizeFeatureAssignment(assignment);
  const next = migrateEvidenceGraph(graph, datasets, options);
  const now = options.createdAt ?? new Date().toISOString();
  const existingIndex = next.entities.findIndex((entity) => entity.id === candidate.id);

  if (normalized === "unassigned") {
    if (existingIndex >= 0) next.entities.splice(existingIndex, 1);
    next.annotations = next.annotations.filter((annotation) => annotation.targetId !== candidate.id);
    validateEvidenceGraph(next, datasets);
    return next;
  }

  const existing = existingIndex >= 0 ? next.entities[existingIndex] : null;
  const entity = {
    ...(existing ?? {}),
    id: candidate.id,
    kind: "feature",
    label: `${candidate.featureCode ?? "F"} ${normalized}`,
    datasetId: String(candidate.datasetId ?? options.datasetId ?? ""),
    mode: String(candidate.mode ?? options.mode ?? ""),
    featureCode: String(candidate.featureCode ?? ""),
    componentIndex: Number.isInteger(candidate.componentIndex) ? candidate.componentIndex : null,
    wavelengthMin: Number.isFinite(candidate.wavelengthMin) ? candidate.wavelengthMin : null,
    wavelengthMax: Number.isFinite(candidate.wavelengthMax) ? candidate.wavelengthMax : null,
    wavelengthCenter: Number.isFinite(candidate.wavelengthCenter) ? candidate.wavelengthCenter : null,
    automaticType: String(candidate.candidateType ?? candidate.automaticType ?? ""),
    assignment: normalized,
    note: String(note ?? existing?.note ?? "").trim(),
    author: options.author ?? existing?.author ?? "project-user",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    attributes: existing?.attributes ?? {},
  };
  if (existingIndex >= 0) next.entities[existingIndex] = entity;
  else next.entities.push(entity);

  validateEvidenceGraph(next, datasets);
  return next;
}

export function upsertFeatureSignature(graph, signature, changes = {}, datasets = [], options = {}) {
  const next = migrateEvidenceGraph(graph, datasets, options);
  const existingIndex = next.entities.findIndex((entity) => entity.id === signature.id && entity.kind === "feature");
  const existing = existingIndex >= 0 ? next.entities[existingIndex] : null;
  const now = options.createdAt ?? new Date().toISOString();
  const assignment = normalizeFeatureAssignment(changes.assignment ?? signature.assignment ?? existing?.assignment ?? "unassigned");
  const center = Number(changes.wavelengthCenter ?? signature.wavelengthCenter ?? existing?.wavelengthCenter);
  const componentIndex = Number(changes.componentIndex ?? signature.componentIndex ?? existing?.componentIndex);
  if (!Number.isFinite(center)) throw new Error("A signature requires a finite wavelength position.");
  if (!Number.isInteger(componentIndex) || componentIndex < 0) throw new Error("A signature requires a valid EAS/DAS component.");
  const featureCode = String(changes.featureCode ?? signature.featureCode ?? existing?.featureCode ?? "S").trim() || "S";
  const signatureSource = changes.signatureSource ?? signature.signatureSource ?? existing?.signatureSource ?? "manual";
  const entity = {
    ...(existing ?? {}),
    id: signature.id,
    kind: "feature",
    label: String(changes.label ?? existing?.label ?? `${featureCode} ${assignment}`).trim(),
    datasetId: String(signature.datasetId ?? existing?.datasetId ?? options.datasetId ?? ""),
    mode: String(changes.mode ?? signature.mode ?? existing?.mode ?? "EAS").toUpperCase(),
    featureCode,
    componentIndex,
    wavelengthMin: Number.isFinite(signature.wavelengthMin) ? signature.wavelengthMin : center,
    wavelengthMax: Number.isFinite(signature.wavelengthMax) ? signature.wavelengthMax : center,
    wavelengthCenter: center,
    automaticType: String(signature.candidateType ?? existing?.automaticType ?? ""),
    sign: String(signature.sign ?? existing?.sign ?? (assignment === "ESA" ? "positive" : "negative")),
    assignment,
    note: String(changes.note ?? existing?.note ?? "").trim(),
    signatureSource,
    signatureDeleted: false,
    author: options.author ?? existing?.author ?? "project-user",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    attributes: existing?.attributes ?? {},
  };
  if (existingIndex >= 0) next.entities[existingIndex] = entity;
  else next.entities.push(entity);
  validateEvidenceGraph(next, datasets);
  return next;
}

export function deleteFeatureSignature(graph, signature, datasets = [], options = {}) {
  const next = migrateEvidenceGraph(graph, datasets, options);
  const index = next.entities.findIndex((entity) => entity.id === signature.id && entity.kind === "feature");
  if (signature.signatureSource === "automatic") {
    const now = options.createdAt ?? new Date().toISOString();
    const tombstone = {
      ...(index >= 0 ? next.entities[index] : {}),
      id: signature.id,
      kind: "feature",
      label: `${signature.featureCode ?? "F"} deleted signature`,
      datasetId: signature.datasetId,
      mode: signature.mode ?? "EAS",
      featureCode: signature.featureCode ?? "F",
      componentIndex: signature.componentIndex,
      wavelengthCenter: signature.wavelengthCenter,
      assignment: "unassigned",
      signatureSource: "automatic",
      signatureDeleted: true,
      author: options.author ?? "project-user",
      createdAt: index >= 0 ? next.entities[index].createdAt : now,
      updatedAt: now,
      attributes: index >= 0 ? next.entities[index].attributes ?? {} : {},
    };
    if (index >= 0) next.entities[index] = tombstone;
    else next.entities.push(tombstone);
  } else if (index >= 0) {
    next.entities.splice(index, 1);
    next.annotations = next.annotations.filter((annotation) => annotation.targetId !== signature.id);
    next.relationships = next.relationships.filter((relationship) => relationship.fromId !== signature.id && relationship.toId !== signature.id);
  }
  validateEvidenceGraph(next, datasets);
  return next;
}
