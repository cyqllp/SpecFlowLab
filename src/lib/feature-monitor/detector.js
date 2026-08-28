import { fitMultiGaussianSpectrum } from "./multigaussian.js";

export const FEATURE_MONITOR_SCHEMA = "specflowlab.feature_monitor.v1";
const monitorCache = new WeakMap();

export function detectFstaFeatureCandidates(dataset, graph, evidenceAssets = [], options = {}) {
  const techniqueId = dataset?.evidenceMetadata?.technique?.id ?? "fsta";
  if (!dataset?.fit) return monitorResult("awaiting-global-analysis", dataset, [], [], ["Run global analysis to create component spectra before feature monitoring."]);
  if (techniqueId !== "fsta") return monitorResult("unsupported-technique", dataset, [], [], ["Automatic feature candidates are currently limited to fsTA datasets."]);

  const requestedMode = String(options.spectrumMode ?? "").toUpperCase();
  const sourceMode = requestedMode === "DAS"
    ? "DAS"
    : requestedMode === "EAS" ? "EAS" : dataset.fit.easSpectra?.length ? "EAS" : "DAS";
  const spectra = sourceMode === "EAS" ? dataset.fit.easSpectra : dataset.fit.dasSpectra ?? [];
  if (!spectra.length) return monitorResult("unavailable", dataset, [], [], ["The current global analysis produced no EAS or DAS spectra."]);
  const cacheKey = monitorCacheKey(sourceMode, graph, evidenceAssets, options);
  const cached = monitorCache.get(dataset);
  if (cached?.fit === dataset.fit && cached.key === cacheKey) return cached.result;
  const linkedReferences = linkedSpectralReferences(dataset.id, graph, evidenceAssets);
  const candidates = spectra.flatMap((spectrum, spectrumIndex) => {
    const componentIndex = Number.isInteger(spectrum.componentIndex) ? spectrum.componentIndex : spectrumIndex;
    return (
    dataset.fit.irfLimited?.[componentIndex]
      ? []
      : detectSpectrumRegions(spectrum, componentIndex, sourceMode, linkedReferences, options)
    );
  });
  const perComponentLimit = Math.max(1, options.maximumPeaksPerComponent ?? 6);
  const componentIndexes = [...new Set(candidates.map((candidate) => candidate.componentIndex))].sort((left, right) => left - right);
  const selected = componentIndexes.flatMap((componentIndex) => candidates
    .filter((candidate) => candidate.componentIndex === componentIndex)
    .sort((left, right) => (right.amplitudeSnr ?? right.relativeStrength) - (left.amplitudeSnr ?? left.relativeStrength) || left.wavelengthMin - right.wavelengthMin)
    .slice(0, perComponentLimit));
  const ranked = selected
    .sort((left, right) => left.componentIndex - right.componentIndex || left.wavelengthCenter - right.wavelengthCenter)
    .slice(0, options.limit ?? Math.max(10, spectra.length * perComponentLimit))
    .map((candidate) => ({
      ...candidate,
      id: `feature-candidate:${dataset.id}:${sourceMode.toLowerCase()}:c${String(candidate.componentIndex + 1).padStart(2, "0")}:r${String(candidate.regionIndex + 1).padStart(2, "0")}`,
    }));

  const result = {
    ...monitorResult("live", dataset, ranked, linkedReferences.map(referenceDescriptor), [
    "Signs are optical observations: positive regions suggest ESA; negative regions remain GSB/SE candidates until external evidence and kinetics discriminate them.",
    "Absorption/PL overlap supplies context only and never confirms a species or mechanism.",
    "IRF-limited components are excluded from feature detection, labels, and feature-time evolution.",
    "Peak centers come from noise-aware signed multi-Gaussian model selection with iterative re-seeding; asymmetric or under-resolved bands may remain unstable.",
    "Lifetime covariance is model-conditional; the lineshape decomposition has no validated peak-parameter uncertainty and neither result proves species identity.",
    ]),
    spectrumMode: sourceMode,
  };
  monitorCache.set(dataset, { fit: dataset.fit, key: cacheKey, result });
  return result;
}

function monitorCacheKey(sourceMode, graph, assets, options) {
  return JSON.stringify({
    sourceMode,
    minimumFwhmNm: options.minimumFwhmNm,
    minimumSnr: options.minimumSnr,
    maximumPeaksPerComponent: options.maximumPeaksPerComponent,
    minimumBicImprovement: options.minimumBicImprovement,
    limit: options.limit,
    relationships: (graph?.relationships ?? []).map((relationship) => [relationship.id, relationship.fromId, relationship.toId]),
    assets: assets.map((asset) => [asset.id, asset.techniqueId, asset.source?.sha256, asset.nativePreview?.xAxis?.values?.length]),
  });
}

function detectSpectrumRegions(spectrum, componentIndex, sourceMode, references, options) {
  const fitted = fitMultiGaussianSpectrum(spectrum.x ?? [], spectrum.y ?? [], {
    minimumFwhmNm: options.minimumFwhmNm,
    minimumSnr: options.minimumSnr,
    maximumPeaks: options.maximumPeaksPerComponent,
    minimumBicImprovement: options.minimumBicImprovement,
  });
  if (fitted.status === "fit") return fittedRegions(spectrum, componentIndex, sourceMode, references, fitted);
  return [];
}

function fittedRegions(spectrum, componentIndex, sourceMode, references, fitted) {
  const x = spectrum.x ?? [];
  const y = spectrum.y ?? [];
  const finiteMaximum = Math.max(...y.filter(Number.isFinite).map(Math.abs), 1e-12);
  return fitted.peaks.map((peak, regionIndex) => {
    const overlaps = references.filter((reference) => rangesOverlap(peak.wavelengthMin, peak.wavelengthMax, reference.wavelengthMin, reference.wavelengthMax));
    const absorption = overlaps.filter((reference) => reference.techniqueId === "absorption");
    const pl = overlaps.filter((reference) => reference.techniqueId === "pl");
    const peakIndex = nearestFiniteIndex(x, peak.centerNm);
    return {
      componentIndex,
      regionIndex,
      featureCode: `F${componentIndex + 1}.${regionIndex + 1}`,
      componentLabel: spectrum.label ?? `Component ${componentIndex + 1}`,
      lifetimePs: Number.isFinite(spectrum.lifetime) ? spectrum.lifetime : null,
      wavelengthMin: peak.wavelengthMin,
      wavelengthMax: peak.wavelengthMax,
      wavelengthCenter: peak.centerNm,
      peakWavelength: x[peakIndex] ?? peak.centerNm,
      sign: peak.sign,
      amplitude: peak.amplitude,
      amplitudeSnr: peak.amplitudeSnr,
      area: peak.area,
      relativeStrength: peak.amplitudeAbs / finiteMaximum,
      gaussianShape: {
        rSquared: peak.rSquared,
        centerNm: peak.centerNm,
        fwhmNm: peak.fwhmNm,
        sigmaNm: peak.sigmaNm,
        peakIndex,
        pointCount: peak.pointCount,
        truncated: peak.truncated,
        qualityFlags: peak.qualityFlags,
      },
      lineshapeFit: fitted.diagnostics,
      candidateType: classifyCandidate(peak.sign, absorption.length, pl.length),
      supportingReferenceIds: overlaps.map((reference) => reference.id),
      supportSummary: supportSummary(peak.sign, absorption, pl),
      status: "suggested-not-confirmed",
      source: `${sourceMode} component ${componentIndex + 1}`,
      detectionMethod: "multi-gaussian",
    };
  });
}

function linkedSpectralReferences(datasetId, graph, assets) {
  const linkedIds = new Set((graph?.relationships ?? []).flatMap((relationship) => {
    if (relationship.fromId === datasetId) return [relationship.toId];
    if (relationship.toId === datasetId) return [relationship.fromId];
    return [];
  }));
  return assets.filter((asset) => linkedIds.has(asset.id) && ["absorption", "pl"].includes(asset.techniqueId) && asset.nativePreview)
    .map((asset) => {
      const x = asset.nativePreview.xAxis?.values ?? [];
      const y = asset.nativePreview.signal?.values ?? [];
      const finite = y.filter(Number.isFinite).map(Math.abs);
      const max = finite.length ? Math.max(...finite) : 0;
      const active = x.filter((value, index) => Number.isFinite(value) && Number.isFinite(y[index]) && Math.abs(y[index]) >= max * 0.25);
      if (!active.length || !(max > 0)) return null;
      return { id: asset.id, label: asset.label, techniqueId: asset.techniqueId, wavelengthMin: Math.min(...active), wavelengthMax: Math.max(...active) };
    }).filter(Boolean);
}

function classifyCandidate(sign, absorptionCount, plCount) {
  if (sign === "positive") return "ESA candidate";
  if (absorptionCount && plCount) return "GSB / SE overlap candidate";
  if (absorptionCount) return "GSB candidate";
  if (plCount) return "SE candidate";
  return "Negative feature: GSB or SE candidate";
}

function supportSummary(sign, absorption, pl) {
  if (sign === "positive") return "Positive ΔOD region; linked Abs/PL overlap does not establish ESA identity.";
  const parts = [];
  if (absorption.length) parts.push(`overlaps ${absorption.length} linked absorption reference${absorption.length === 1 ? "" : "s"}`);
  if (pl.length) parts.push(`overlaps ${pl.length} linked PL reference${pl.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" and ") : "No linked Abs/PL reference overlaps this region.";
}

function referenceDescriptor(reference) {
  return { ...reference };
}

function monitorResult(status, dataset, candidates, references, limitations) {
  return {
    schema: FEATURE_MONITOR_SCHEMA,
    status,
    datasetId: dataset?.id ?? null,
    candidates,
    references,
    detectionMethod: "multi-gaussian",
    limitations,
    recomputePolicy: "derived from the current analysis, fit, feature-finding options, and explicit one-hop evidence connections",
  };
}

function nearestFiniteIndex(values, target) {
  let best = -1;
  let distance = Infinity;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const next = Math.abs(value - target);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

function rangesOverlap(leftMin, leftMax, rightMin, rightMax) {
  return Math.max(leftMin, rightMin) <= Math.min(leftMax, rightMax);
}
