const MIN_COMMON_TIMES = 6;
const MIN_PROBE_ROWS = 2;

export function prepareMergePlan(datasetA, datasetB, options = {}) {
  const inputs = [datasetA, datasetB].map(validateDataset);
  const ordered = inputs.slice().sort((left, right) =>
    spectralCenter(left.analysis) - spectralCenter(right.analysis));
  const [low, high] = ordered;
  const reference = inputs.find((dataset) => dataset.id === options.referenceId) ?? low;
  const moving = reference.id === inputs[0].id ? inputs[1] : inputs[0];
  const overlap = spectralOverlap(low.analysis, high.analysis);
  const usesTreatedTimeAxes = options.alignmentMode === "treated-time-axis";
  const estimated = usesTreatedTimeAxes
    ? {
        shiftPs: 0,
        correlation: Number.NaN,
        derivativeCorrelation: Number.NaN,
        atBoundary: false,
        method: "treated-analysis-time-axes; no additional time-zero shift",
      }
    : estimateTimeShift(reference.analysis, moving.analysis, overlap, {
        maxShiftPs: options.maxShiftPs,
      });
  const timeShiftPs = usesTreatedTimeAxes
    ? 0
    : Number.isFinite(options.timeShiftPs) ? Number(options.timeShiftPs) : estimated.shiftPs;
  const commonTimeAxis = reference.analysis.timeAxis.filter((time) =>
    time + timeShiftPs >= moving.analysis.timeAxis[0]
      && time + timeShiftPs <= moving.analysis.timeAxis.at(-1));
  if (commonTimeAxis.length < MIN_COMMON_TIMES) {
    throw new Error("The aligned datasets have fewer than six common time points.");
  }

  const lowShiftPs = low.id === moving.id ? timeShiftPs : 0;
  const highShiftPs = high.id === moving.id ? timeShiftPs : 0;
  const lowMatrix = resampleMatrix(low.analysis, commonTimeAxis, lowShiftPs);
  const highMatrix = resampleMatrix(high.analysis, commonTimeAxis, highShiftPs);
  const amplitude = estimatePositiveScale(low, high, lowMatrix, highMatrix, overlap, commonTimeAxis);
  const seam = estimateSeam(low, high, lowMatrix, highMatrix, overlap, commonTimeAxis, amplitude.scale);
  const warnings = [];

  if (usesTreatedTimeAxes) {
    if (!overlap) warnings.push("The wavelength ranges do not overlap; amplitude matching and seam diagnostics are unavailable.");
  } else {
    if (!overlap) warnings.push("The wavelength ranges do not overlap; automatic time alignment could not use a shared spectral region.");
    if (!Number.isFinite(estimated.correlation)) warnings.push("Automatic time alignment is unavailable; verify the time shift manually.");
    else if (estimated.correlation < 0.65) warnings.push("The automatic time alignment has low overlap-trace correlation; verify it manually.");
    if (estimated.atBoundary) warnings.push("The best automatic time shift lies at the search boundary; increase the search range or enter a manual shift.");
  }
  if (!Number.isFinite(amplitude.scale)) warnings.push("A positive overlap amplitude scale could not be estimated; scaling is disabled.");
  else if (amplitude.correlation < 0.6) warnings.push("The overlap amplitude match is weak; consider disabling amplitude scaling.");
  if (overlap && overlap.max - overlap.min < 5) warnings.push("The wavelength overlap is narrower than 5 nm, so seam diagnostics are weak.");

  const seamWavelength = Number.isFinite(seam.wavelength)
    ? seam.wavelength
    : overlap ? (overlap.min + overlap.max) / 2 : (low.analysis.spectralAxis.at(-1) + high.analysis.spectralAxis[0]) / 2;

  return {
    low,
    high,
    reference,
    moving,
    overlap,
    commonTimeAxis,
    lowMatrix,
    highMatrix,
    lowShiftPs,
    highShiftPs,
    timeShiftPs,
    timeAlignment: {
      ...estimated,
      appliedShiftPs: timeShiftPs,
      referenceId: reference.id,
      movingId: moving.id,
      convention: "moving signal sampled at reference_time + shift_ps",
      alignmentMode: usesTreatedTimeAxes ? "treated-time-axis" : "overlap-or-manual-shift",
    },
    amplitudeScale: amplitude,
    seam: { ...seam, wavelength: seamWavelength },
    recommendedRanges: {
      low: {
        min: low.analysis.spectralAxis[0],
        max: overlap ? seamWavelength : low.analysis.spectralAxis.at(-1),
      },
      high: {
        min: overlap ? seamWavelength : high.analysis.spectralAxis[0],
        max: high.analysis.spectralAxis.at(-1),
      },
    },
    warnings,
  };
}

export function createMergedAnalysis(plan, options = {}) {
  const lowRange = normalizedRange(options.lowRange ?? plan.recommendedRanges.low);
  const highRange = normalizedRange(options.highRange ?? plan.recommendedRanges.high);
  const lowRows = selectedRows(plan.low, plan.lowMatrix, lowRange, "probe-1");
  const highRows = selectedRows(plan.high, plan.highMatrix, highRange, "probe-2");
  if (lowRows.length < MIN_PROBE_ROWS || highRows.length < MIN_PROBE_ROWS) {
    throw new Error("Each probe must contribute at least two wavelength rows.");
  }

  const selectedOverlap = rangeOverlap(lowRange, highRange);
  const seamWavelength = selectedOverlap
    ? clamp(Number(options.seamWavelength) || plan.seam.wavelength, selectedOverlap.min, selectedOverlap.max)
    : Number.NaN;
  const retainedLow = selectedOverlap ? lowRows.filter((row) => row.wavelength <= seamWavelength) : lowRows;
  const retainedHigh = selectedOverlap ? highRows.filter((row) => row.wavelength > seamWavelength) : highRows;
  if (retainedLow.length < MIN_PROBE_ROWS || retainedHigh.length < MIN_PROBE_ROWS) {
    throw new Error("The selected seam leaves fewer than two rows from one probe.");
  }

  const scaleApplied = options.applyAmplitudeScale !== false && Number.isFinite(plan.amplitudeScale.scale);
  const highScale = scaleApplied ? plan.amplitudeScale.scale : 1;
  const rows = retainedLow.concat(retainedHigh.map((row) => ({
    ...row,
    values: row.values.map((value) => Number.isFinite(value) ? value * highScale : value),
  }))).sort((left, right) => left.wavelength - right.wavelength);
  const spectralAxis = rows.map((row) => row.wavelength);
  const matrix = rows.map((row) => row.values.slice());
  const spectralSegments = buildSpectralSegments(rows, plan);
  const wavelengthBreaks = findWavelengthBreaks(rows, plan.low.analysis.spectralAxis, plan.high.analysis.spectralAxis);
  const diagnostics = seamDiagnostics(rows, plan.commonTimeAxis);
  const warnings = plan.warnings.slice();
  if (diagnostics.normalizedJump > 0.35) warnings.push("The merged seam has a large normalized discontinuity; refine the wavelength ranges or scaling choice.");
  if (wavelengthBreaks.length) warnings.push("The selected wavelength subranges contain a gap; plots will mark a broken wavelength axis.");

  const mergeMetadata = {
    schema: "specflowlab.dataset_merge.v1",
    createdAt: new Date().toISOString(),
    method: "hard-join-selected-wavelength-subranges",
    sourceDatasets: [plan.low, plan.high].map((dataset) => ({
      id: dataset.id,
      label: dataset.label,
      fileName: dataset.source?.fileName ?? "",
      sourceFormat: dataset.source?.sourceFormat ?? "csv",
      wavelengthRangeNm: [dataset.analysis.spectralAxis[0], dataset.analysis.spectralAxis.at(-1)],
      timeRangePs: [dataset.analysis.timeAxis[0], dataset.analysis.timeAxis.at(-1)],
      analysisProvenance: (dataset.analysis.provenance ?? []).map((item) => ({ ...item })),
    })),
    lowProbeId: plan.low.id,
    highProbeId: plan.high.id,
    selectedRangesNm: { low: lowRange, high: highRange },
    overlapRangeNm: plan.overlap,
    seamWavelengthNm: Number.isFinite(seamWavelength) ? seamWavelength : null,
    spectralSegments,
    wavelengthBreaks,
    timeAlignment: plan.timeAlignment,
    commonTimeRangePs: [plan.commonTimeAxis[0], plan.commonTimeAxis.at(-1)],
    commonTimePoints: plan.commonTimeAxis.length,
    resampling: "linear interpolation onto the reference dataset time axis; no extrapolation",
    amplitudeScale: {
      applied: scaleApplied,
      target: "higher-wavelength probe",
      factor: highScale,
      correlation: plan.amplitudeScale.correlation,
      method: "positive least-squares scale through zero over the shared wavelength/time region",
    },
    signalSmoothing: plan.timeAlignment.alignmentMode === "treated-time-axis"
      ? "none; smoothing was used only for seam diagnostics"
      : "none; smoothing was used only for alignment and seam diagnostics",
    seamDiagnostics: diagnostics,
    warnings,
  };
  const timeAxis = plan.commonTimeAxis.slice();
  const provenance = [{
    label: "Merge",
    status: "applied",
    method: mergeMetadata.method,
    range: `${formatNumber(spectralAxis[0])} to ${formatNumber(spectralAxis.at(-1))} nm; ${formatNumber(timeAxis[0])} to ${formatNumber(timeAxis.at(-1))} ps`,
    timeShiftPs: plan.timeShiftPs,
    amplitudeScale: highScale,
    sourceDatasetIds: mergeMetadata.sourceDatasets.map((source) => source.id),
  }];

  return {
    analysis: {
      timeAxis,
      spectralAxis,
      matrix,
      rowRange: { start: 0, end: spectralAxis.length - 1 },
      colRange: { start: 0, end: timeAxis.length - 1 },
      selectedRange: {
        time: { min: timeAxis[0], max: timeAxis.at(-1) },
        spectral: { min: spectralAxis[0], max: spectralAxis.at(-1) },
      },
      excluded: buildMergeExclusions(plan, lowRange, highRange),
      provenance,
      chirp: null,
      spectralSegments,
      wavelengthBreaks,
      merge: mergeMetadata,
    },
    merge: mergeMetadata,
    warnings,
  };
}

export function mergePreviewSeries(plan, timeIndex, options = {}) {
  const index = clamp(Math.round(Number(timeIndex) || 0), 0, plan.commonTimeAxis.length - 1);
  const highScale = options.applyAmplitudeScale !== false && Number.isFinite(plan.amplitudeScale.scale)
    ? plan.amplitudeScale.scale
    : 1;
  return {
    timeIndex: index,
    timePs: plan.commonTimeAxis[index],
    series: [
      {
        id: plan.low.id,
        label: plan.low.label,
        points: plan.low.analysis.spectralAxis.map((wavelength, rowIndex) => ({
          x: wavelength,
          y: plan.lowMatrix[rowIndex][index],
        })),
      },
      {
        id: plan.high.id,
        label: plan.high.label,
        points: plan.high.analysis.spectralAxis.map((wavelength, rowIndex) => ({
          x: wavelength,
          y: Number.isFinite(plan.highMatrix[rowIndex][index]) ? plan.highMatrix[rowIndex][index] * highScale : Number.NaN,
        })),
      },
    ],
  };
}

function validateDataset(dataset) {
  const analysis = dataset?.analysis;
  if (!dataset?.id || !analysis) throw new Error("Two valid datasets are required for merging.");
  if (!Array.isArray(analysis.timeAxis) || !Array.isArray(analysis.spectralAxis) || !Array.isArray(analysis.matrix)) {
    throw new Error("A merge input is missing its analysis matrix or axes.");
  }
  if (analysis.timeAxis.length < MIN_COMMON_TIMES || analysis.spectralAxis.length < MIN_PROBE_ROWS) {
    throw new Error("Each merge input needs at least six time points and two wavelengths.");
  }
  if (analysis.matrix.length !== analysis.spectralAxis.length
    || !analysis.matrix.every((row) => row.length === analysis.timeAxis.length)) {
    throw new Error("A merge input matrix does not match its axes.");
  }
  if (!strictlyIncreasing(analysis.timeAxis) || !strictlyIncreasing(analysis.spectralAxis)) {
    throw new Error("Merge input time and wavelength axes must be strictly increasing.");
  }
  return {
    id: dataset.id,
    label: dataset.projectLabel || dataset.source?.fileName?.replace(/\.[^.]+$/, "") || dataset.id,
    source: dataset.source,
    analysis,
  };
}

function estimateTimeShift(reference, moving, overlap, options = {}) {
  if (!overlap) return { shiftPs: 0, correlation: Number.NaN, derivativeCorrelation: Number.NaN, atBoundary: false, method: "manual-required-no-overlap" };
  const referenceTrace = aggregateOverlapTrace(reference, overlap);
  const movingTrace = aggregateOverlapTrace(moving, overlap);
  if (referenceTrace.finiteRows < 2 || movingTrace.finiteRows < 2) {
    return { shiftPs: 0, correlation: Number.NaN, derivativeCorrelation: Number.NaN, atBoundary: false, method: "manual-required-insufficient-overlap" };
  }
  const maxShiftPs = Math.max(0.05, Number(options.maxShiftPs) || 5);
  const candidates = 201;
  let best = { score: -Infinity, shiftPs: 0, correlation: Number.NaN, derivativeCorrelation: Number.NaN };
  for (let index = 0; index < candidates; index += 1) {
    const shiftPs = -maxShiftPs + (2 * maxShiftPs * index) / (candidates - 1);
    const evaluated = alignmentScore(reference.timeAxis, referenceTrace.values, moving.timeAxis, movingTrace.values, shiftPs);
    if (evaluated.score > best.score) best = { ...evaluated, shiftPs };
  }
  return {
    shiftPs: best.shiftPs,
    correlation: best.correlation,
    derivativeCorrelation: best.derivativeCorrelation,
    score: best.score,
    searchRangePs: [-maxShiftPs, maxShiftPs],
    atBoundary: Math.abs(best.shiftPs) >= maxShiftPs * 0.995,
    method: "overlap RMS-trace correlation with derivative support",
  };
}

function aggregateOverlapTrace(analysis, overlap) {
  const candidates = analysis.spectralAxis
    .map((wavelength, rowIndex) => ({ wavelength, rowIndex, noise: normalizedRoughness(analysis.matrix[rowIndex]) }))
    .filter((item) => item.wavelength >= overlap.min && item.wavelength <= overlap.max)
    .sort((left, right) => left.noise - right.noise)
    .slice(0, 32);
  const normalizedRows = candidates.map(({ rowIndex }) => orientNormalizedRow(normalizeRow(analysis.matrix[rowIndex])));
  const values = analysis.timeAxis.map((_, timeIndex) => {
    const finite = normalizedRows.map((row) => row[timeIndex]).filter(Number.isFinite);
    if (!finite.length) return Number.NaN;
    return median(finite);
  });
  return { values: smoothThree(values), finiteRows: normalizedRows.length };
}

function alignmentScore(referenceTimes, referenceTrace, movingTimes, movingTrace, shiftPs) {
  const pairs = [];
  referenceTimes.forEach((time, index) => {
    if (time < -5 || time > 50) return;
    const left = referenceTrace[index];
    const right = interpolateAt(movingTimes, movingTrace, time + shiftPs);
    if (Number.isFinite(left) && Number.isFinite(right)) pairs.push([left, right, time]);
  });
  if (pairs.length < 8) {
    pairs.length = 0;
    referenceTimes.forEach((time, index) => {
      const left = referenceTrace[index];
      const right = interpolateAt(movingTimes, movingTrace, time + shiftPs);
      if (Number.isFinite(left) && Number.isFinite(right)) pairs.push([left, right, time]);
    });
  }
  if (pairs.length < MIN_COMMON_TIMES) return { score: -Infinity, correlation: Number.NaN, derivativeCorrelation: Number.NaN };
  const correlation = pearson(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]));
  const leftDerivative = [];
  const rightDerivative = [];
  for (let index = 1; index < pairs.length; index += 1) {
    const dt = pairs[index][2] - pairs[index - 1][2];
    if (!(dt > 0)) continue;
    leftDerivative.push((pairs[index][0] - pairs[index - 1][0]) / dt);
    rightDerivative.push((pairs[index][1] - pairs[index - 1][1]) / dt);
  }
  const derivativeCorrelation = pearson(leftDerivative, rightDerivative);
  const score = Number.isFinite(derivativeCorrelation)
    ? 0.78 * correlation + 0.22 * derivativeCorrelation
    : correlation;
  return { score, correlation, derivativeCorrelation };
}

function resampleMatrix(analysis, commonTimeAxis, shiftPs) {
  return analysis.matrix.map((row) =>
    commonTimeAxis.map((time) => interpolateAt(analysis.timeAxis, row, time + shiftPs)));
}

function estimatePositiveScale(low, high, lowMatrix, highMatrix, overlap, timeAxis) {
  if (!overlap) return { scale: Number.NaN, correlation: Number.NaN, pairCount: 0 };
  const pairs = overlapRowPairs(low.analysis.spectralAxis, high.analysis.spectralAxis, overlap);
  let numerator = 0;
  let denominator = 0;
  const lowValues = [];
  const highValues = [];
  const stride = Math.max(1, Math.floor(timeAxis.length / 80));
  const usePostPromptWindow = timeAxis.filter((time) => time >= 1).length >= MIN_COMMON_TIMES;
  pairs.forEach(([lowIndex, highIndex]) => {
    for (let timeIndex = 0; timeIndex < timeAxis.length; timeIndex += stride) {
      if (usePostPromptWindow && timeAxis[timeIndex] < 1) continue;
      const lowValue = lowMatrix[lowIndex][timeIndex];
      const highValue = highMatrix[highIndex][timeIndex];
      if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) continue;
      numerator += lowValue * highValue;
      denominator += highValue * highValue;
      lowValues.push(lowValue);
      highValues.push(highValue);
    }
  });
  const rawScale = denominator > 0 ? numerator / denominator : Number.NaN;
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? clamp(rawScale, 0.05, 20) : Number.NaN;
  return {
    scale,
    unconstrainedScale: rawScale,
    correlation: pearson(lowValues, highValues),
    pairCount: lowValues.length,
    method: "positive least-squares through zero",
  };
}

function estimateSeam(low, high, lowMatrix, highMatrix, overlap, timeAxis, scale) {
  if (!overlap) return { wavelength: Number.NaN, score: Number.NaN, candidates: 0 };
  const pairs = overlapRowPairs(low.analysis.spectralAxis, high.analysis.spectralAxis, overlap);
  let best = { wavelength: Number.NaN, score: Infinity, mismatch: Number.NaN, noise: Number.NaN };
  pairs.forEach(([lowIndex, highIndex]) => {
    const lowRow = lowMatrix[lowIndex];
    const highRow = highMatrix[highIndex].map((value) => Number.isFinite(value) && Number.isFinite(scale) ? value * scale : value);
    const mismatch = normalizedRmse(lowRow, highRow);
    const noise = 0.5 * (normalizedRoughness(lowRow) + normalizedRoughness(highRow));
    const score = mismatch + 0.2 * noise;
    if (Number.isFinite(score) && score < best.score) {
      best = {
        wavelength: (low.analysis.spectralAxis[lowIndex] + high.analysis.spectralAxis[highIndex]) / 2,
        score,
        mismatch,
        noise,
      };
    }
  });
  return { ...best, candidates: pairs.length };
}

function overlapRowPairs(lowAxis, highAxis, overlap) {
  const highStep = medianStep(highAxis);
  const tolerance = Math.max(1, highStep * 1.5);
  const pairs = [];
  lowAxis.forEach((wavelength, lowIndex) => {
    if (wavelength < overlap.min || wavelength > overlap.max) return;
    const highIndex = nearestIndex(highAxis, wavelength);
    if (Math.abs(highAxis[highIndex] - wavelength) <= tolerance) pairs.push([lowIndex, highIndex]);
  });
  return pairs;
}

function selectedRows(dataset, resampledMatrix, range, probe) {
  return dataset.analysis.spectralAxis.flatMap((wavelength, rowIndex) =>
    wavelength >= range.min && wavelength <= range.max
      ? [{ wavelength, values: resampledMatrix[rowIndex].slice(), probe, sourceRow: rowIndex }]
      : []);
}

function findWavelengthBreaks(rows, lowAxis, highAxis) {
  const threshold = Math.max(5, medianStep(lowAxis) * 3, medianStep(highAxis) * 3);
  const breaks = [];
  for (let index = 1; index < rows.length; index += 1) {
    const left = rows[index - 1];
    const right = rows[index];
    if (left.probe !== right.probe && right.wavelength - left.wavelength > threshold) {
      breaks.push({ left: left.wavelength, right: right.wavelength });
    }
  }
  return breaks;
}

function buildSpectralSegments(rows, plan) {
  const segments = [];
  rows.forEach((row, index) => {
    const parent = row.probe === "probe-1" ? plan.low : plan.high;
    const previous = segments.at(-1);
    if (previous?.parentDatasetId === parent.id) {
      previous.endIndex = index;
      previous.maxNm = row.wavelength;
    } else {
      segments.push({
        parentDatasetId: parent.id,
        parentLabel: parent.label,
        minNm: row.wavelength,
        maxNm: row.wavelength,
        startIndex: index,
        endIndex: index,
      });
    }
  });
  return segments;
}

function seamDiagnostics(rows, timeAxis) {
  const boundary = rows.findIndex((row, index) => index > 0 && row.probe !== rows[index - 1].probe);
  if (boundary < 1) return { normalizedJump: 0, boundaryWavelengthsNm: null, comparedTimePoints: 0 };
  const left = rows[boundary - 1];
  const right = rows[boundary];
  const jump = normalizedRmse(left.values, right.values);
  return {
    normalizedJump: jump,
    boundaryWavelengthsNm: [left.wavelength, right.wavelength],
    comparedTimePoints: timeAxis.length,
  };
}

function buildMergeExclusions(plan, lowRange, highRange) {
  return [
    {
      axis: "Spectral",
      sourceDatasetId: plan.low.id,
      retainedRange: `${formatNumber(lowRange.min)} to ${formatNumber(lowRange.max)} nm`,
      reason: "Rows outside the explicitly selected clean lower-wavelength probe range were excluded from the merged derivative.",
    },
    {
      axis: "Spectral",
      sourceDatasetId: plan.high.id,
      retainedRange: `${formatNumber(highRange.min)} to ${formatNumber(highRange.max)} nm`,
      reason: "Rows outside the explicitly selected clean higher-wavelength probe range were excluded from the merged derivative.",
    },
    {
      axis: "Time",
      sourceDatasetIds: [plan.reference.id, plan.moving.id],
      retainedRange: `${formatNumber(plan.commonTimeAxis[0])} to ${formatNumber(plan.commonTimeAxis.at(-1))} ps`,
      reason: "Only the common aligned time support was retained; no extrapolation was performed.",
    },
  ];
}

function normalizedRoughness(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 4) return 1;
  const second = [];
  for (let index = 1; index < values.length - 1; index += 1) {
    if (Number.isFinite(values[index - 1]) && Number.isFinite(values[index]) && Number.isFinite(values[index + 1])) {
      second.push(values[index + 1] - 2 * values[index] + values[index - 1]);
    }
  }
  const scale = robustScale(finite);
  return scale > 0 ? robustScale(second) / scale : 1;
}

function normalizedRmse(left, right) {
  const differences = [];
  const combined = [];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) continue;
    differences.push(left[index] - right[index]);
    combined.push(left[index], right[index]);
  }
  if (differences.length < 3) return Number.NaN;
  const rmse = Math.sqrt(differences.reduce((sum, value) => sum + value * value, 0) / differences.length);
  const scale = robustScale(combined);
  return scale > 0 ? rmse / scale : rmse;
}

function normalizeRow(row) {
  const finite = row.filter(Number.isFinite);
  const center = median(finite);
  const scale = robustScale(finite);
  return row.map((value) => Number.isFinite(value) && scale > 0 ? (value - center) / scale : Number.NaN);
}

function orientNormalizedRow(row) {
  const dominant = row.filter(Number.isFinite)
    .reduce((best, value) => Math.abs(value) > Math.abs(best) ? value : best, 0);
  const sign = dominant < 0 ? -1 : 1;
  return row.map((value) => Number.isFinite(value) ? value * sign : value);
}

function smoothThree(values) {
  return values.map((value, index) => {
    const neighborhood = [values[index - 1], value, values[index + 1]].filter(Number.isFinite);
    return neighborhood.length ? median(neighborhood) : Number.NaN;
  });
}

function pearson(left, right) {
  const pairs = left.map((value, index) => [value, right[index]])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  if (pairs.length < 3) return Number.NaN;
  const meanLeft = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanRight = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let leftPower = 0;
  let rightPower = 0;
  pairs.forEach(([a, b]) => {
    const da = a - meanLeft;
    const db = b - meanRight;
    numerator += da * db;
    leftPower += da * da;
    rightPower += db * db;
  });
  const denominator = Math.sqrt(leftPower * rightPower);
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function interpolateAt(axis, values, target) {
  if (!Number.isFinite(target) || target < axis[0] || target > axis.at(-1)) return Number.NaN;
  let low = 0;
  let high = axis.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (axis[middle] < target) low = middle + 1;
    else high = middle;
  }
  const right = low;
  if (axis[right] === target || right === 0) return values[right];
  const left = right - 1;
  const y0 = values[left];
  const y1 = values[right];
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return Number.NaN;
  const fraction = (target - axis[left]) / (axis[right] - axis[left]);
  return y0 + fraction * (y1 - y0);
}

function spectralOverlap(left, right) {
  const min = Math.max(left.spectralAxis[0], right.spectralAxis[0]);
  const max = Math.min(left.spectralAxis.at(-1), right.spectralAxis.at(-1));
  return max > min ? { min, max } : null;
}

function rangeOverlap(left, right) {
  const min = Math.max(left.min, right.min);
  const max = Math.min(left.max, right.max);
  return max >= min ? { min, max } : null;
}

function normalizedRange(range) {
  const a = Number(range?.min);
  const b = Number(range?.max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Every wavelength range limit must be finite.");
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function spectralCenter(analysis) {
  return (analysis.spectralAxis[0] + analysis.spectralAxis.at(-1)) / 2;
}

function medianStep(axis) {
  const steps = axis.slice(1).map((value, index) => value - axis[index]).filter((value) => value > 0);
  return median(steps) || 1;
}

function nearestIndex(values, target) {
  let best = 0;
  let distance = Infinity;
  values.forEach((value, index) => {
    const next = Math.abs(value - target);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

function robustScale(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  const center = median(finite);
  const mad = median(finite.map((value) => Math.abs(value - center)));
  return mad > 0 ? 1.4826 * mad : Math.sqrt(finite.reduce((sum, value) => sum + (value - center) ** 2, 0) / finite.length);
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return Number.NaN;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function strictlyIncreasing(values) {
  return values.every((value, index) => Number.isFinite(value) && (index === 0 || value > values[index - 1]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : "-";
}
