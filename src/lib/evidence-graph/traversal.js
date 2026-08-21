import { migrateEvidenceGraph } from "./schema.js";

export function resolveConnectedEvidenceScope(project, scope = {}) {
  const datasets = project.datasets ?? [];
  const graph = migrateEvidenceGraph(project.evidenceGraph, datasets);
  const datasetById = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const roots = [...new Set([...(scope.datasetIds ?? []), ...(scope.focusEntityIds ?? [])])]
    .filter((id) => graph.entities.some((entity) => entity.id === id));
  const rootDatasetIds = roots.filter((id) => datasetById.has(id));
  const includedEntityIds = new Set(roots);
  const includedConnectionIds = new Set();
  const inclusionReasons = Object.fromEntries(rootDatasetIds.map((id) => [id, [{ kind: "user-selected", entityId: id }]]));

  graph.relationships.slice().sort((left, right) => left.id.localeCompare(right.id)).forEach((relationship) => {
    const fromRoot = roots.includes(relationship.fromId);
    const toRoot = roots.includes(relationship.toId);
    if (!fromRoot && !toRoot) return;
    includedConnectionIds.add(relationship.id);
    includedEntityIds.add(relationship.fromId);
    includedEntityIds.add(relationship.toId);
    const connectedId = fromRoot ? relationship.toId : relationship.fromId;
    if (datasetById.has(connectedId)) {
      inclusionReasons[connectedId] ??= [];
      inclusionReasons[connectedId].push({
        kind: "one-hop-connection",
        connectionId: relationship.id,
        relationshipType: relationship.type,
        rationale: relationship.rationale,
        fromEntityId: fromRoot ? relationship.fromId : relationship.toId,
      });
    }
  });

  const resolvedDatasets = datasets.filter((dataset) => includedEntityIds.has(dataset.id));
  const connectionIds = [...includedConnectionIds].sort();
  return {
    graph,
    datasets: resolvedDatasets,
    rootEntityIds: roots,
    entities: graph.entities.filter((entity) => includedEntityIds.has(entity.id)).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: graph.relationships.filter((relationship) => includedConnectionIds.has(relationship.id)).sort((left, right) => left.id.localeCompare(right.id)),
    annotations: graph.annotations.filter((annotation) => includedEntityIds.has(annotation.targetId) || includedConnectionIds.has(annotation.targetId)).sort((left, right) => left.id.localeCompare(right.id)),
    inclusionReasons,
    depth: 1,
  };
}
