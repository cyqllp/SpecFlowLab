export const FEATURE_TIME_SCHEMA = "specflowlab.feature_time_map.v1";

export function buildFeatureTimeMap(dataset, monitor, options = {}) {
  const analysis = dataset?.analysis;
  if (!analysis || !Array.isArray(analysis.spectralAxis) || !Array.isArray(analysis.timeAxis) || !Array.isArray(analysis.matrix)) {
    return unavailable(dataset, "A treated fsTA matrix is required for feature-time compression.");
  }
  if (monitor?.status !== "live" || !monitor.candidates?.length) {
    return unavailable(dataset, "No live feature regions are available from the current global analysis.");
  }

  const maxFeatures = options.maxFeatures ?? 10;
  const features = monitor.candidates.slice(0, maxFeatures).map((candidate) => {
    const spectralIndices = analysis.spectralAxis
      .map((wavelength, index) => wavelength >= candidate.wavelengthMin && wavelength <= candidate.wavelengthMax ? index : -1)
      .filter((index) => index >= 0);
    if (!spectralIndices.length) return null;
    const trace = analysis.timeAxis.map((_, timeIndex) => meanFinite(
      spectralIndices.map((spectralIndex) => analysis.matrix[spectralIndex]?.[timeIndex]),
    ));
    return {
      id: candidate.id,
      featureCode: candidate.featureCode,
      candidateType: candidate.candidateType,
      componentIndex: candidate.componentIndex,
      lifetimePs: candidate.lifetimePs,
      wavelengthMin: candidate.wavelengthMin,
      wavelengthMax: candidate.wavelengthMax,
      wavelengthCenter: candidate.wavelengthCenter,
      wavelengthPointCount: spectralIndices.length,
      spectralIndices,
      trace,
      status: candidate.status,
    };
  }).filter(Boolean);
  if (!features.length) return unavailable(dataset, "The detected feature regions do not intersect the treated wavelength axis.");

  const reconstruction = reconstructionDiagnostics(analysis, features);
  return {
    schema: FEATURE_TIME_SCHEMA,
    status: "live",
    datasetId: dataset.id,
    timeAxis: analysis.timeAxis.slice(),
    features,
    matrix: features.map((feature) => feature.trace.slice()),
    compression: {
      sourceCellCount: analysis.spectralAxis.length * analysis.timeAxis.length,
      featureCellCount: features.length * analysis.timeAxis.length,
      cellReductionFactor: (analysis.spectralAxis.length * analysis.timeAxis.length) / (features.length * analysis.timeAxis.length),
      ...reconstruction,
    },
    method: "finite mean DeltaOD within each deterministic EAS/DAS candidate wavelength region at every measured time",
    limitations: [
      "This is a lossy regional summary, not a replacement for the source fsTA matrix.",
      "The reconstruction score compares piecewise feature-region means with the treated matrix and must be reported rather than assumed.",
      "Candidate identities remain suggested-not-confirmed.",
    ],
  };
}

function reconstructionDiagnostics(analysis, features) {
  let totalEnergy = 0;
  let errorEnergy = 0;
  let comparedCellCount = 0;
  const covered = new Set(features.flatMap((feature) => feature.spectralIndices));
  analysis.matrix.forEach((row, spectralIndex) => {
    row.forEach((value, timeIndex) => {
      if (!Number.isFinite(value)) return;
      const contributors = features
        .filter((feature) => feature.spectralIndices.includes(spectralIndex))
        .map((feature) => feature.trace[timeIndex])
        .filter(Number.isFinite);
      const reconstructed = contributors.length ? meanFinite(contributors) : 0;
      totalEnergy += value * value;
      errorEnergy += (value - reconstructed) ** 2;
      comparedCellCount += 1;
    });
  });
  return {
    coveredWavelengthFraction: analysis.spectralAxis.length ? covered.size / analysis.spectralAxis.length : 0,
    reconstructionScore: totalEnergy > 0 ? 1 - (errorEnergy / totalEnergy) : null,
    reconstructionRmse: comparedCellCount ? Math.sqrt(errorEnergy / comparedCellCount) : null,
    comparedCellCount,
  };
}

function unavailable(dataset, reason) {
  return {
    schema: FEATURE_TIME_SCHEMA,
    status: "unavailable",
    datasetId: dataset?.id ?? null,
    timeAxis: [],
    features: [],
    matrix: [],
    compression: null,
    method: null,
    limitations: [reason],
  };
}

function meanFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : Number.NaN;
}
