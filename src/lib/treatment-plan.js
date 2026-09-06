export function treatmentEnabled(dataset, folder, kind) {
  return Boolean(folder?.treatments?.[kind] && !dataset?.treatmentOverrides?.[kind]);
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
