export const FEATURE_MONITOR_SCHEMA = "specflowlab.feature_monitor.v1";

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
  const linkedReferences = linkedSpectralReferences(dataset.id, graph, evidenceAssets);
  const candidates = spectra.flatMap((spectrum, spectrumIndex) => {
    const componentIndex = Number.isInteger(spectrum.componentIndex) ? spectrum.componentIndex : spectrumIndex;
    return (
    dataset.fit.irfLimited?.[componentIndex]
      ? []
      : detectSpectrumRegions(spectrum, componentIndex, sourceMode, linkedReferences, options)
    );
  });
  const ranked = candidates
    .sort((left, right) => right.relativeStrength - left.relativeStrength || left.wavelengthMin - right.wavelengthMin)
    .slice(0, options.limit ?? 10)
    .map((candidate) => ({
      ...candidate,
      id: `feature-candidate:${dataset.id}:${sourceMode.toLowerCase()}:c${String(candidate.componentIndex + 1).padStart(2, "0")}:r${String(candidate.regionIndex + 1).padStart(2, "0")}`,
    }));

  return monitorResult("live", dataset, ranked, linkedReferences.map(referenceDescriptor), [
    "Signs are optical observations: positive regions suggest ESA; negative regions remain GSB/SE candidates until external evidence and kinetics discriminate them.",
    "Absorption/PL overlap supplies context only and never confirms a species or mechanism.",
    "IRF-limited components are excluded from feature detection, labels, and feature-time evolution.",
    "The current global analysis is a preview fit without validated uncertainty or model-selection statistics.",
  ]);
}

function detectSpectrumRegions(spectrum, componentIndex, sourceMode, references, options) {
  const x = spectrum.x ?? [];
  const y = spectrum.y ?? [];
  const finiteAbs = y.filter(Number.isFinite).map(Math.abs);
  const maximum = finiteAbs.length ? Math.max(...finiteAbs) : 0;
  if (!(maximum > 0)) return [];
  const relativeThreshold = clamp(options.relativeThreshold ?? 0.12, 0.01, 0.95);
  const minimumGaussianR2 = clamp(options.minimumGaussianR2 ?? 0.45, -1, 0.99);
  const minimumFwhmNm = Math.max(0, options.minimumFwhmNm ?? 6);
  const smoothed = smoothAbsolute(y);
  const peakIndices = smoothed
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => Number.isFinite(x[index])
      && Number.isFinite(y[index])
      && value >= maximum * relativeThreshold
      && value >= (smoothed[index - 1] ?? -Infinity)
      && value >= (smoothed[index + 1] ?? -Infinity)
      && (value > (smoothed[index - 1] ?? -Infinity) || value > (smoothed[index + 1] ?? -Infinity)))
    .sort((left, right) => right.value - left.value || left.index - right.index);
  if (!peakIndices.length) return [];

  const minimumSeparationNm = Math.max(minimumFwhmNm * 0.5, options.minimumPeakSeparationNm ?? 0);
  const retainedPeaks = peakIndices.filter(({ index }, retainedIndex, peaks) => (
    peaks.slice(0, retainedIndex).every((other) => Math.abs(x[index] - x[other.index]) >= minimumSeparationNm)
  ));
  const regions = retainedPeaks.map(({ index }) => peakRegion(index, x, y, smoothed, maximum, relativeThreshold))
    .filter((indices) => indices.length >= 3)
    .map((indices) => ({ indices, gaussian: gaussianDiagnostics(indices, x, y) }))
    .filter(({ gaussian }) => Number.isFinite(gaussian.rSquared)
      && gaussian.rSquared >= minimumGaussianR2
      && gaussian.fwhmNm >= minimumFwhmNm)
    .sort((left, right) => left.gaussian.centerNm - right.gaussian.centerNm);

  return regions.map(({ indices, gaussian }, regionIndex) => {
    const values = indices.map((index) => y[index]);
    const wavelengths = indices.map((index) => x[index]).filter(Number.isFinite);
    const sign = Math.sign(values.reduce((sum, value) => sum + value, 0)) >= 0 ? "positive" : "negative";
    const overlaps = references.filter((reference) => rangesOverlap(Math.min(...wavelengths), Math.max(...wavelengths), reference.wavelengthMin, reference.wavelengthMax));
    const absorption = overlaps.filter((reference) => reference.techniqueId === "absorption");
    const pl = overlaps.filter((reference) => reference.techniqueId === "pl");
    return {
      componentIndex,
      regionIndex,
      featureCode: `F${componentIndex + 1}.${regionIndex + 1}`,
      componentLabel: spectrum.label ?? `Component ${componentIndex + 1}`,
      lifetimePs: Number.isFinite(spectrum.lifetime) ? spectrum.lifetime : null,
      wavelengthMin: Math.min(...wavelengths),
      wavelengthMax: Math.max(...wavelengths),
      wavelengthCenter: gaussian.centerNm,
      peakWavelength: x[gaussian.peakIndex],
      sign,
      relativeStrength: Math.max(...values.map(Math.abs)) / maximum,
      gaussianShape: gaussian,
      candidateType: classifyCandidate(sign, absorption.length, pl.length),
      supportingReferenceIds: overlaps.map((reference) => reference.id),
      supportSummary: supportSummary(sign, absorption, pl),
      status: "suggested-not-confirmed",
      source: `${sourceMode} component ${componentIndex + 1}`,
    };
  });
}

function smoothAbsolute(values) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return Number.NaN;
    const neighbors = [
      { value: values[index - 1], weight: 0.25 },
      { value, weight: 0.5 },
      { value: values[index + 1], weight: 0.25 },
    ].filter((item) => Number.isFinite(item.value));
    const weight = neighbors.reduce((sum, item) => sum + item.weight, 0);
    return neighbors.reduce((sum, item) => sum + Math.abs(item.value) * item.weight, 0) / weight;
  });
}

function peakRegion(peakIndex, x, y, smoothed, maximum, relativeThreshold) {
  const sign = Math.sign(y[peakIndex]);
  const floor = Math.max(maximum * relativeThreshold * 0.35, smoothed[peakIndex] * 0.12);
  let left = peakIndex;
  let right = peakIndex;
  while (left > 0 && Number.isFinite(x[left - 1]) && Math.sign(y[left - 1]) === sign && smoothed[left - 1] >= floor) left -= 1;
  while (right < y.length - 1 && Number.isFinite(x[right + 1]) && Math.sign(y[right + 1]) === sign && smoothed[right + 1] >= floor) right += 1;
  if (left === peakIndex && left > 0 && Math.sign(y[left - 1]) === sign) left -= 1;
  if (right === peakIndex && right < y.length - 1 && Math.sign(y[right + 1]) === sign) right += 1;
  return Array.from({ length: right - left + 1 }, (_, offset) => left + offset);
}

function gaussianDiagnostics(indices, x, y) {
  const peakIndex = indices.reduce((best, index) => Math.abs(y[index]) > Math.abs(y[best]) ? index : best, indices[0]);
  const sign = Math.sign(y[peakIndex]) || 1;
  const leftIndex = indices[0];
  const rightIndex = indices.at(-1);
  const leftValue = y[leftIndex];
  const rightValue = y[rightIndex];
  const span = x[rightIndex] - x[leftIndex];
  const baselineAt = (wavelength) => span
    ? leftValue + ((wavelength - x[leftIndex]) / span) * (rightValue - leftValue)
    : (leftValue + rightValue) / 2;
  const weights = indices.map((index) => Math.max(0, sign * (y[index] - baselineAt(x[index]))));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (!(weightSum > 0)) return { rSquared: null, centerNm: x[peakIndex], fwhmNm: 0, sigmaNm: 0, peakIndex, pointCount: indices.length, truncated: leftIndex === 0 || rightIndex === x.length - 1 };
  const centerNm = indices.reduce((sum, index, offset) => sum + x[index] * weights[offset], 0) / weightSum;
  const variance = indices.reduce((sum, index, offset) => sum + ((x[index] - centerNm) ** 2) * weights[offset], 0) / weightSum;
  const sigmaNm = Math.sqrt(Math.max(variance, 1e-12));
  const amplitude = y[peakIndex] - baselineAt(x[peakIndex]);
  const observed = indices.map((index) => y[index]);
  const predicted = indices.map((index) => baselineAt(x[index]) + amplitude * Math.exp(-0.5 * ((x[index] - centerNm) / sigmaNm) ** 2));
  const observedMean = mean(observed);
  const total = observed.reduce((sum, value) => sum + (value - observedMean) ** 2, 0);
  const residual = observed.reduce((sum, value, offset) => sum + (value - predicted[offset]) ** 2, 0);
  return {
    rSquared: total > 0 ? 1 - residual / total : null,
    centerNm,
    fwhmNm: 2.35482 * sigmaNm,
    sigmaNm,
    peakIndex,
    pointCount: indices.length,
    truncated: leftIndex === 0 || rightIndex === x.length - 1,
  };
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
    limitations,
    recomputePolicy: "derived on every render from the current analysis, fit, and explicit one-hop evidence connections",
  };
}

function rangesOverlap(leftMin, leftMax, rightMin, rightMax) {
  return Math.max(leftMin, rightMin) <= Math.min(leftMax, rightMax);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
