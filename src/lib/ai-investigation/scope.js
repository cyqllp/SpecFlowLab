export function defaultAiScope(project) {
  const datasets = project.datasets ?? [];
  const active = datasets.find((dataset) => dataset.id === project.activeDatasetId)
    ?? datasets[project.activeIndex ?? 0];
  const folderIds = active
    ? datasets.filter((dataset) => dataset.folderId === active.folderId).map((dataset) => dataset.id)
    : [];
  return { kind: "current-folder", datasetIds: folderIds };
}

export function resolveAiScope(project, scope) {
  const datasets = project.datasets ?? [];
  const selected = new Set(scope.datasetIds ?? []);
  let resolved;
  if (scope.kind === "selected-datasets") {
    resolved = datasets.filter((dataset) => selected.has(dataset.id));
  } else if (scope.kind === "current-folder") {
    const active = datasets.find((dataset) => dataset.id === project.activeDatasetId)
      ?? datasets[project.activeIndex ?? 0];
    const folderDatasets = active ? datasets.filter((dataset) => dataset.folderId === active.folderId) : [];
    resolved = selected.size ? folderDatasets.filter((dataset) => selected.has(dataset.id)) : folderDatasets;
  } else if (scope.kind === "project") {
    resolved = selected.size ? datasets.filter((dataset) => selected.has(dataset.id)) : datasets.slice();
  } else {
    resolved = [];
  }
  return resolved;
}
