import { resolveConnectedEvidenceScope } from "../evidence-graph/traversal.js";

export function defaultAiScope(project) {
  if ((project.datasets?.length ?? 0) <= 1) return { kind: "active-dataset", datasetIds: [] };
  return { kind: "current-folder", datasetIds: [] };
}

export function resolveAiScope(project, scope) {
  const datasets = project.datasets ?? [];
  let resolved;
  if (scope.kind === "active-dataset") {
    const active = datasets.find((dataset) => dataset.id === project.activeDatasetId)
      ?? datasets[project.activeIndex ?? 0];
    resolved = active ? [active] : [];
  } else if (scope.kind === "current-folder") {
    const active = datasets.find((dataset) => dataset.id === project.activeDatasetId)
      ?? datasets[project.activeIndex ?? 0];
    resolved = active ? datasets.filter((dataset) => dataset.folderId === active.folderId) : [];
  } else if (scope.kind === "selected-datasets") {
    const selected = new Set(scope.datasetIds ?? []);
    resolved = datasets.filter((dataset) => selected.has(dataset.id));
  } else if (scope.kind === "connected-evidence") {
    resolved = resolveConnectedEvidenceScope(project, scope).datasets;
  } else if (scope.kind === "project") {
    resolved = datasets.slice();
  } else {
    resolved = [];
  }
  return resolved;
}
