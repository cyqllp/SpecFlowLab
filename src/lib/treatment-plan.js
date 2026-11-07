export function treatmentEnabled(dataset, folder, kind) {
  if (kind === "chirp" && typeof dataset?.chirpSettings?.enabled === "boolean") return dataset.chirpSettings.enabled;
  return Boolean(folder?.treatments?.[kind] && !dataset?.treatmentOverrides?.[kind]);
}

export function chirpHintForDataset(dataset, folder) {
  return Number.isFinite(dataset?.chirpSettings?.approximateZeroTimePs)
    ? dataset.chirpSettings.approximateZeroTimePs : folder?.chirpZeroTimePs;
}

export function chirpReferenceForDataset(dataset, folder) {
  return Number.isFinite(dataset?.chirpSettings?.referenceWavelength)
    ? dataset.chirpSettings.referenceWavelength : folder?.chirpReferenceWavelength;
}

export function chirpCursorSeeds(analysis, timeIndex, wavelengthIndex) {
  const at = (axis, index) => axis?.[Math.max(0, Math.min(axis.length - 1, index))] ?? 0;
  const time = at(analysis?.timeAxis, timeIndex), wavelength = at(analysis?.spectralAxis, wavelengthIndex);
  const lastChirp = analysis?.provenance?.findLast(p => p.label === "Chirp");
  const curve = analysis?.chirp?.curve;
  const applied = lastChirp ? lastChirp.status === "applied" : Array.isArray(curve) && curve.length > 0;
  const point = applied && curve?.length ? curve.reduce((best, item) => Math.abs(item.wavelength - wavelength) < Math.abs(best.wavelength - wavelength) ? item : best) : null;
  return { time: time + (Number.isFinite(point?.shift) ? point.shift : 0), wavelength };
}

// A local retry must not change either a sibling's matrix or its input settings.
export function configureChirpTreatment(datasets, folder, { datasetId, scope = "dataset", enabled, approximateZeroTimePs, referenceWavelength }) {
  if (!["dataset", "folder"].includes(scope) || typeof enabled !== "boolean") throw new Error("Invalid chirp action scope or state.");
  if (!datasets.some(d => d.id === datasetId && d.folderId === folder.id)) throw new Error("The chirp dataset is not in the selected folder.");
  const nextFolder = scope === "folder"
    ? { ...folder, treatments: { ...folder.treatments, chirp: enabled }, chirpZeroTimePs: enabled ? approximateZeroTimePs : null, chirpReferenceWavelength: enabled ? referenceWavelength : null, chirpFitRange: null }
    : folder;
  const affectedIds = [];
  const nextDatasets = datasets.map(dataset => {
    if (dataset.folderId !== folder.id || (scope === "dataset" && dataset.id !== datasetId)) return dataset;
    affectedIds.push(dataset.id);
    return {
      ...dataset,
      chirpSettings: scope === "folder" ? null : {
        enabled,
        approximateZeroTimePs: enabled ? approximateZeroTimePs : null,
        referenceWavelength: enabled ? referenceWavelength : null,
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
