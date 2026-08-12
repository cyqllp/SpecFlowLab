import { CONDITION_FIELDS, normalizeDatasetEvidence } from "./schema.js";

export const COMPARABILITY_FIELDS = Object.freeze(CONDITION_FIELDS.slice());

export function compareDatasetConditions(leftDataset, rightDataset) {
  const left = normalizeDatasetEvidence(leftDataset?.evidenceMetadata);
  const right = normalizeDatasetEvidence(rightDataset?.evidenceMetadata);
  const report = { matching: [], different: [], unknown: [] };
  COMPARABILITY_FIELDS.forEach((field) => {
    const leftValue = left.conditions[field];
    const rightValue = right.conditions[field];
    const record = { field, left: leftValue, right: rightValue };
    if (isUnknown(leftValue) || isUnknown(rightValue)) report.unknown.push(record);
    else if (canonical(leftValue) === canonical(rightValue)) report.matching.push(record);
    else report.different.push(record);
  });
  return {
    schema: "specflowlab.evidence_comparability.v1",
    leftDatasetId: leftDataset?.id ?? null,
    rightDatasetId: rightDataset?.id ?? null,
    conclusion: "review-required",
    ...report,
  };
}

export function buildComparabilityRows(datasets, relationships = []) {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  return relationships
    .filter((relationship) => byId.has(relationship.fromId) && byId.has(relationship.toId))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((relationship) => ({
      connectionId: relationship.id,
      relationshipType: relationship.type,
      ...compareDatasetConditions(byId.get(relationship.fromId), byId.get(relationship.toId)),
    }));
}

function isUnknown(value) {
  return value == null || (typeof value === "string" && !value.trim());
}

function canonical(value) {
  if (typeof value === "string") return value.trim().toLocaleLowerCase();
  return JSON.stringify(value);
}
