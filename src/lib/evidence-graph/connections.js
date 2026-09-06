import {
  migrateEvidenceGraph,
  relationshipDefinition,
  validateEvidenceGraph,
} from "./schema.js";

export function upsertEvidenceConnection(graph, input, datasets = [], options = {}) {
  const next = migrateEvidenceGraph(graph, datasets, options);
  const definition = relationshipDefinition(input?.type);
  if (!definition) throw new Error(`Unsupported evidence relationship type: ${input?.type || "missing"}.`);
  const now = options.createdAt ?? new Date().toISOString();
  const [fromId, toId] = normalizedEndpoints(input?.fromId, input?.toId, definition.symmetric);
  const matching = input.id ? null : next.relationships.find((item) => (
    item.type === input.type && sameEndpoints(item, fromId, toId, definition.symmetric)
  ));
  const relationship = {
    id: input.id || matching?.id || createConnectionId(fromId, toId, input.type, next.relationships),
    fromId,
    toId,
    type: input.type,
    category: definition.category,
    assertionStatus: input.assertionStatus || (definition.category === "interpretive" ? "proposed" : "recorded"),
    rationale: String(input.rationale || "").trim(),
    author: String(input.author || "project-user").trim() || "project-user",
    createdAt: input.createdAt ?? matching?.createdAt ?? now,
    updatedAt: input.id || matching ? now : null,
  };
  if (relationship.fromId === relationship.toId) throw new Error("An evidence connection requires two different entities.");
  const index = next.relationships.findIndex((item) => item.id === relationship.id);
  if (index >= 0) next.relationships[index] = { ...next.relationships[index], ...relationship, createdAt: next.relationships[index].createdAt ?? relationship.createdAt };
  else next.relationships.push(relationship);
  validateEvidenceGraph(next, datasets);
  return next;
}

export function removeEvidenceConnection(graph, connectionId, datasets = []) {
  const next = migrateEvidenceGraph(graph, datasets);
  next.relationships = next.relationships.filter((relationship) => relationship.id !== connectionId);
  next.annotations = next.annotations.filter((annotation) => annotation.targetId !== connectionId);
  validateEvidenceGraph(next, datasets);
  return next;
}

export function connectionsForEntity(graph, entityId) {
  return (graph?.relationships ?? [])
    .filter((relationship) => relationship.fromId === entityId || relationship.toId === entityId)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function removeDatasetFromEvidenceGraph(graph, datasetId, remainingDatasets = []) {
  const next = migrateEvidenceGraph(graph, [
    ...remainingDatasets,
    { id: datasetId, projectLabel: datasetId, sampleNote: "", evidenceMetadata: null },
  ]);
  const removedEntityIds = new Set([datasetId]);
  next.relationships = next.relationships.filter((relationship) => !removedEntityIds.has(relationship.fromId) && !removedEntityIds.has(relationship.toId));
  next.annotations = next.annotations.filter((annotation) => !removedEntityIds.has(annotation.targetId));
  next.entities = next.entities.filter((entity) => !removedEntityIds.has(entity.id));
  validateEvidenceGraph(next, remainingDatasets);
  return next;
}

function createConnectionId(fromId, toId, type, relationships) {
  const stem = `connection:${safe(fromId)}:${safe(type)}:${safe(toId)}`;
  if (!relationships.some((item) => item.id === stem)) return stem;
  let suffix = 2;
  while (relationships.some((item) => item.id === `${stem}:${suffix}`)) suffix += 1;
  return `${stem}:${suffix}`;
}

function normalizedEndpoints(fromId, toId, symmetric) {
  const endpoints = [String(fromId || ""), String(toId || "")];
  return symmetric && endpoints[0] > endpoints[1] ? [endpoints[1], endpoints[0]] : endpoints;
}

function sameEndpoints(relationship, fromId, toId, symmetric) {
  if (relationship.fromId === fromId && relationship.toId === toId) return true;
  return Boolean(symmetric && relationship.fromId === toId && relationship.toId === fromId);
}

function safe(value) {
  return encodeURIComponent(String(value || "entity"));
}
