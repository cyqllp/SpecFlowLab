export const EVIDENCE_GRAPH_SCHEMA = "specflowlab.evidence_graph.v1";
export const DATASET_EVIDENCE_SCHEMA = "specflowlab.dataset_evidence.v1";
export const EVIDENCE_VOCABULARY_VERSION = "2026-08-12";

export const ENTITY_KINDS = Object.freeze([
  "molecular-system",
  "sample",
  "species-hypothesis",
  "dataset",
  "external-dataset",
  "feature",
  "literature-source",
  "figure-evidence",
  "document-evidence",
  "annotation",
]);

export const HYPOTHESIS_STATUSES = Object.freeze(["proposed", "supported", "contested", "rejected"]);
export const MEASUREMENT_ROLES = Object.freeze(["unknown", "primary", "reference", "control", "supporting"]);

export const CONDITION_FIELDS = Object.freeze([
  "solvent",
  "concentration",
  "temperature",
  "atmosphere",
  "ph",
  "excitationWavelength",
  "fluence",
  "polarization",
  "repetitionRate",
  "acquisitionDate",
  "instrument",
]);

export const RELATIONSHIP_DEFINITIONS = Object.freeze({
  "same-sample": { category: "factual", pairs: datasetPairs() },
  "same-preparation": { category: "factual", pairs: datasetPairs() },
  "same-molecular-system": { category: "factual", pairs: datasetPairs() },
  "aliquot-of": { category: "factual", pairs: [["dataset", "dataset"], ["sample", "sample"]] },
  "before-after": { category: "factual", pairs: [["dataset", "dataset"], ["sample", "sample"]] },
  "control-for": { category: "factual", pairs: [["dataset", "dataset"]] },
  "replicate-of": { category: "factual", pairs: [["dataset", "dataset"]] },
  "parent-of": { category: "factual", pairs: [["dataset", "dataset"]] },
  "derived-from": { category: "factual", pairs: [["dataset", "dataset"]] },
  "merged-from": { category: "factual", pairs: [["dataset", "dataset"]] },
  "reference-for": { category: "factual", pairs: [...datasetPairs(), ["dataset", "species-hypothesis"], ["external-dataset", "species-hypothesis"]] },
  "generated-species-reference": { category: "factual", pairs: [["dataset", "species-hypothesis"]] },
  "measured-under-comparable-conditions": { category: "factual", pairs: datasetPairs() },
  "supplemented-by": { category: "factual", pairs: supportingEvidencePairs() },
  "documented-by": { category: "factual", pairs: documentEvidencePairs() },
  "supports-assignment": { category: "interpretive", pairs: assignmentEvidencePairs() },
  "challenges-assignment": { category: "interpretive", pairs: assignmentEvidencePairs() },
  "alternative-to": { category: "interpretive", pairs: [["species-hypothesis", "species-hypothesis"], ["dataset", "dataset"]] },
});

export function createEmptyEvidenceGraph() {
  return {
    schema: EVIDENCE_GRAPH_SCHEMA,
    vocabularyVersion: EVIDENCE_VOCABULARY_VERSION,
    entities: [],
    relationships: [],
    annotations: [],
  };
}

export function defaultDatasetEvidence(techniqueId = "fsta") {
  return {
    schema: DATASET_EVIDENCE_SCHEMA,
    technique: { id: techniqueId || "unknown", label: "" },
    measurementRole: "unknown",
    sampleId: "",
    preparationId: "",
    speciesStateIds: [],
    conditions: Object.fromEntries(CONDITION_FIELDS.map((field) => [field, null])),
  };
}

export function normalizeDatasetEvidence(value, techniqueId = "fsta") {
  const defaults = defaultDatasetEvidence(techniqueId);
  const role = MEASUREMENT_ROLES.includes(value?.measurementRole) ? value.measurementRole : "unknown";
  return {
    ...defaults,
    ...(value && typeof value === "object" ? value : {}),
    schema: DATASET_EVIDENCE_SCHEMA,
    technique: {
      id: String(value?.technique?.id || techniqueId || "unknown"),
      label: String(value?.technique?.label || ""),
    },
    measurementRole: role,
    sampleId: String(value?.sampleId || ""),
    preparationId: String(value?.preparationId || ""),
    speciesStateIds: uniqueStrings(value?.speciesStateIds),
    conditions: Object.fromEntries(CONDITION_FIELDS.map((field) => [
      field,
      normalizeUnknown(value?.conditions?.[field]),
    ])),
  };
}

export function migrateEvidenceGraph(graph, datasets = [], options = {}) {
  if (graph?.schema && graph.schema !== EVIDENCE_GRAPH_SCHEMA) {
    throw new Error(`Unsupported evidence graph schema: ${graph.schema}.`);
  }
  const next = {
    ...createEmptyEvidenceGraph(),
    ...(graph && typeof graph === "object" ? structuredCopy(graph) : {}),
    schema: EVIDENCE_GRAPH_SCHEMA,
    vocabularyVersion: graph?.vocabularyVersion || EVIDENCE_VOCABULARY_VERSION,
    entities: Array.isArray(graph?.entities) ? structuredCopy(graph.entities) : [],
    relationships: Array.isArray(graph?.relationships) ? structuredCopy(graph.relationships) : [],
    annotations: Array.isArray(graph?.annotations) ? structuredCopy(graph.annotations) : [],
  };
  const entityById = new Map(next.entities.map((entity) => [entity.id, entity]));
  datasets.forEach((dataset) => {
    const evidence = normalizeDatasetEvidence(dataset.evidenceMetadata, dataset.kind === "merged" ? "fsta" : "fsta");
    const current = entityById.get(dataset.id);
    const entity = {
      ...(current ?? {}),
      id: dataset.id,
      kind: "dataset",
      label: dataset.projectLabel || dataset.source?.fileName || dataset.id,
      datasetId: dataset.id,
      attributes: {
        ...(current?.attributes ?? {}),
        technique: evidence.technique,
        measurementRole: evidence.measurementRole,
        sampleId: evidence.sampleId || null,
        preparationId: evidence.preparationId || null,
        conditions: evidence.conditions,
      },
    };
    if (current) Object.assign(current, entity);
    else {
      next.entities.push(entity);
      entityById.set(entity.id, entity);
    }
    migrateSampleNote(next, dataset, options.createdAt ?? null);
  });
  (options.evidenceAssets ?? []).forEach((asset) => {
    const current = entityById.get(asset.id);
    const entity = {
      ...(current ?? {}),
      id: asset.id,
      kind: evidenceAssetKind(asset.kind),
      label: asset.label || asset.source?.fileName || asset.id,
      assetId: asset.id,
      attributes: {
        ...(current?.attributes ?? {}),
        assetKind: asset.kind,
        techniqueId: asset.techniqueId || "other",
        measurementRole: asset.measurementRole || "supporting",
        sourceFileName: asset.source?.fileName || null,
        sourceChecksum: asset.source?.sha256 || null,
        citation: asset.citation ? structuredCopy(asset.citation) : null,
      },
    };
    if (current) Object.assign(current, entity);
    else {
      next.entities.push(entity);
      entityById.set(entity.id, entity);
    }
  });
  validateEvidenceGraph(next, datasets);
  return next;
}

export function validateEvidenceGraph(graph, datasets = []) {
  const errors = [];
  if (graph?.schema !== EVIDENCE_GRAPH_SCHEMA) errors.push("The evidence graph schema is missing or unsupported.");
  for (const key of ["entities", "relationships", "annotations"]) {
    if (!Array.isArray(graph?.[key])) errors.push(`Evidence graph ${key} must be an array.`);
  }
  if (errors.length) throw new Error(errors.join(" "));
  assertUniqueIds([...graph.entities, ...graph.relationships, ...graph.annotations]);
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  graph.entities.forEach((entity) => {
    if (!ENTITY_KINDS.includes(entity.kind)) errors.push(`Unsupported evidence entity kind: ${entity.kind || "missing"}.`);
    if (entity.kind === "species-hypothesis" && !HYPOTHESIS_STATUSES.includes(entity.status ?? "proposed")) {
      errors.push(`Invalid species-hypothesis status for ${entity.id}.`);
    }
  });
  const datasetIds = new Set(datasets.map((dataset) => dataset.id));
  graph.entities.filter((entity) => entity.kind === "dataset").forEach((entity) => {
    if (datasets.length && !datasetIds.has(entity.datasetId ?? entity.id)) errors.push(`Dangling dataset entity: ${entity.id}.`);
  });
  graph.relationships.forEach((relationship) => {
    const from = entityById.get(relationship.fromId);
    const to = entityById.get(relationship.toId);
    if (!from || !to) {
      errors.push(`Dangling evidence relationship: ${relationship.id}.`);
      return;
    }
    const definition = RELATIONSHIP_DEFINITIONS[relationship.type];
    if (!definition) {
      errors.push(`Unsupported evidence relationship type: ${relationship.type || "missing"}.`);
      return;
    }
    if (!definition.pairs.some(([fromKind, toKind]) => from.kind === fromKind && to.kind === toKind)) {
      errors.push(`Relationship ${relationship.type} cannot connect ${from.kind} to ${to.kind}.`);
    }
    if (relationship.category !== definition.category) errors.push(`Relationship ${relationship.id} has the wrong factual/interpretive category.`);
    if (!String(relationship.rationale ?? "").trim()) errors.push(`Relationship ${relationship.id} requires an authored rationale.`);
  });
  graph.annotations.forEach((annotation) => {
    if (!entityById.has(annotation.targetId) && !graph.relationships.some((item) => item.id === annotation.targetId)) {
      errors.push(`Dangling evidence annotation: ${annotation.id}.`);
    }
    if (!String(annotation.text ?? "").trim()) errors.push(`Evidence annotation ${annotation.id} has no text.`);
  });
  if (errors.length) throw new Error(errors.join(" "));
  return graph;
}

export function relationshipDefinition(type) {
  return RELATIONSHIP_DEFINITIONS[type] ?? null;
}

export function stableEntityId(kind, label) {
  const stem = String(label ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `${kind}:${stem || "unnamed"}`;
}

export function legacySampleNoteAnnotationId(datasetId) {
  return `annotation:sample-note:${encodeURIComponent(String(datasetId))}`;
}

function migrateSampleNote(graph, dataset, createdAt) {
  const text = String(dataset.sampleNote ?? "");
  if (!text.trim()) return;
  const id = legacySampleNoteAnnotationId(dataset.id);
  const current = graph.annotations.find((annotation) => annotation.id === id);
  const annotation = {
    ...(current ?? {}),
    id,
    kind: "annotation",
    targetId: dataset.id,
    targetKind: "dataset",
    text,
    author: current?.author ?? "project-user",
    createdAt: current?.createdAt ?? createdAt,
    updatedAt: current && current.text !== text ? createdAt : current?.updatedAt ?? null,
    tags: uniqueStrings([...(current?.tags ?? []), "sample-note", "legacy-migration"]),
    status: "recorded",
    origin: "legacy-sample-note",
    statusHistory: Array.isArray(current?.statusHistory) ? current.statusHistory : [],
  };
  if (current) Object.assign(current, annotation);
  else graph.annotations.push(annotation);
}

function assertUniqueIds(records) {
  const seen = new Set();
  records.forEach((record) => {
    if (!record?.id) throw new Error("Every evidence graph record requires an ID.");
    if (seen.has(record.id)) throw new Error(`Duplicate evidence graph ID: ${record.id}.`);
    seen.add(record.id);
  });
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)).filter(Boolean))];
}

function normalizeUnknown(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  return structuredCopy(value);
}

function structuredCopy(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function evidenceAssetKind(kind) {
  if (["spectroscopy", "characterization"].includes(kind)) return "external-dataset";
  if (kind === "figure") return "figure-evidence";
  if (kind === "literature") return "literature-source";
  return "document-evidence";
}

function datasetPairs() {
  return [
    ["dataset", "dataset"],
    ["dataset", "external-dataset"],
    ["external-dataset", "dataset"],
    ["external-dataset", "external-dataset"],
  ];
}

function supportingEvidencePairs() {
  const evidenceKinds = ["dataset", "external-dataset", "figure-evidence", "document-evidence", "literature-source"];
  return ["dataset", "external-dataset"].flatMap((fromKind) => evidenceKinds
    .filter((toKind) => toKind !== fromKind || fromKind !== "dataset")
    .map((toKind) => [fromKind, toKind]));
}

function documentEvidencePairs() {
  return ["dataset", "external-dataset", "feature", "species-hypothesis"].flatMap((fromKind) => [
    [fromKind, "figure-evidence"],
    [fromKind, "document-evidence"],
    [fromKind, "literature-source"],
  ]);
}

function assignmentEvidencePairs() {
  return ["dataset", "external-dataset", "feature", "figure-evidence", "document-evidence", "literature-source"]
    .map((fromKind) => [fromKind, "species-hypothesis"]);
}
