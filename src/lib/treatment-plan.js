export function treatmentEnabled(dataset, folder, kind) {
  if (kind === "chirp" && typeof dataset?.chirpSettings?.enabled === "boolean") return dataset.chirpSettings.enabled;
  return Boolean(folder?.treatments?.[kind] && !dataset?.treatmentOverrides?.[kind]);
}

export function chirpHintForDataset(dataset, folder) {
  return Number.isFinite(dataset?.chirpSettings?.approximateZeroTimePs)
    ? dataset.chirpSettings.approximateZeroTimePs : folder?.chirpZeroTimePs;
}

export function chirpFitRangeForDataset(dataset, folder) {
  return dataset?.chirpSettings && Object.hasOwn(dataset.chirpSettings, "fitRange")
    ? dataset.chirpSettings.fitRange : folder?.chirpFitRange ?? null;
}

// A local retry must not change either a sibling's matrix or its input settings.
export function configureChirpTreatment(datasets, folder, { datasetId, scope = "dataset", enabled, approximateZeroTimePs, fitRange }) {
  if (!["dataset", "folder"].includes(scope) || typeof enabled !== "boolean") throw new Error("Invalid chirp action scope or state.");
  if (!datasets.some(d => d.id === datasetId && d.folderId === folder.id)) throw new Error("The chirp dataset is not in the selected folder.");
  const nextFolder = scope === "folder"
    ? { ...folder, treatments: { ...folder.treatments, chirp: enabled }, ...(Number.isFinite(approximateZeroTimePs) ? { chirpZeroTimePs: approximateZeroTimePs } : {}), ...(fitRange !== undefined ? { chirpFitRange: fitRange } : {}) }
    : folder;
  const affectedIds = [];
  const nextDatasets = datasets.map(dataset => {
    if (dataset.folderId !== folder.id || (scope === "dataset" && dataset.id !== datasetId)) return dataset;
    affectedIds.push(dataset.id);
    return {
      ...dataset,
      chirpSettings: scope === "folder" ? null : {
        enabled,
        approximateZeroTimePs: Number.isFinite(approximateZeroTimePs) ? approximateZeroTimePs : chirpHintForDataset(dataset, folder),
        fitRange: fitRange !== undefined ? fitRange : chirpFitRangeForDataset(dataset, folder),
      },
      treatmentOverrides: { ...dataset.treatmentOverrides, chirp: false },
    };
  });
  return { folder: nextFolder, datasets: nextDatasets, affectedIds };
}

export function snapshotTreatmentStates(datasets, folder) {
  return new Map((datasets ?? []).map((dataset) => [
    dataset.id,
    {
      baseline: treatmentEnabled(dataset, folder, "baseline"),
      chirp: treatmentEnabled(dataset, folder, "chirp"),
    },
  ]));
}

export function changedTreatmentDatasetIds(datasets, folder, previousStates) {
  return (datasets ?? [])
    .filter((dataset) => {
      const previous = previousStates?.get(dataset.id) ?? {};
      return previous.baseline !== treatmentEnabled(dataset, folder, "baseline")
        || previous.chirp !== treatmentEnabled(dataset, folder, "chirp");
    })
    .map((dataset) => dataset.id);
}
