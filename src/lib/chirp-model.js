// All arrival times refer to the input axis. The fitted intercept and dispersion
// are validated together; the same estimator is used in each held-out block.
export function estimateChirpModel(analysis, options = {}) {
  const requested = options.fitRange;
  if (requested) return fitCalibrationRange(analysis, options, requested, "user-selected");
  const full = estimateChirpCore(analysis, options);
  if (full.accepted || full.candidateDisagreement) return full;
  // Missing red-edge evidence is different from contradictory measured edges.
  // Only a contiguous weak red tail can trigger this automatic fallback.
  const bins = full.wavelengthSupport ?? [];
  let lastSupported = bins.length - 1;
  while (lastSupported >= 0 && bins[lastSupported].anchors < bins[lastSupported].requiredAnchors) lastSupported--;
  if (lastSupported < 0 || lastSupported === bins.length - 1) return full;
  if (bins.slice(0, lastSupported + 1).some(bin => bin.anchors < bin.requiredAnchors || bin.inliers / bin.anchors < 0.7)) return full;
  const predicted = fitCalibrationRange(analysis, options, {
    min: analysis.spectralAxis[0], max: bins[lastSupported].maxNm,
  }, "auto-red-tail", full);
  return predicted.accepted || predicted.outsideAnchorCheck?.conflictingCount
    ? { ...predicted, fullRangeReason: full.reason } : full;
}

function fitCalibrationRange(analysis, options, requested, mode, fullRangeEvidence) {
  if (!Number.isFinite(requested.min) || !Number.isFinite(requested.max) || requested.min >= requested.max) {
    return { ...estimateChirpCore(analysis, options), accepted: false, absoluteOffsetStatus: "review-required", relativeDispersionStatus: "review-required", reason: "The chirp fitting wavelength range must have finite, increasing bounds." };
  }
  const indices = analysis.spectralAxis.flatMap((w, i) => w >= requested.min && w <= requested.max ? [i] : []);
  if (indices.length < 8) return { ...estimateChirpCore(analysis, options), accepted: false, absoluteOffsetStatus: "review-required", relativeDispersionStatus: "review-required", reason: "The chirp fitting range must include at least eight measured wavelengths." };
  const calibration = { ...analysis, spectralAxis: indices.map(i => analysis.spectralAxis[i]), matrix: indices.map(i => analysis.matrix[i]) };
  const range = { min: calibration.spectralAxis[0], max: calibration.spectralAxis.at(-1) };
  const outputRange = { min: analysis.spectralAxis[0], max: analysis.spectralAxis.at(-1) };
  const extrapolates = indices.length !== analysis.spectralAxis.length;
  // A free cubic is unsuitable for a poorly constrained extrapolated tail.
  const fitted = estimateChirpCore(calibration, { ...options, maxDegree: extrapolates ? 2 : 3 });
  const model = { ...fitted, calibrationRange: range, outputRange, requestedFitRange: { ...requested }, fitRangeMode: mode,
    anchors: fitted.anchors.map(a => ({ ...a, index: indices[a.index] })),
    excludedAnchorIndices: fitted.excludedAnchorIndices?.map(i => indices[i]) ?? [],
  };
  if (!model.accepted || !extrapolates) return model;
  const span = range.max - range.min;
  const extension = Math.max(range.min - outputRange.min, outputRange.max - range.max);
  const reject = reason => ({ ...model, accepted: false, reason, absoluteOffsetStatus: "review-required", relativeDispersionStatus: "review-required" });
  if (extension > 0.5 * span) return reject("Prediction extends too far beyond the chirp fitting range; include more supported wavelengths.");
  const predictions = analysis.spectralAxis.map(w => chirpArrival(model, w));
  const training = calibration.spectralAxis.map(w => chirpArrival(model, w));
  const minTime = Math.min(...training), maxTime = Math.max(...training);
  const allowance = Math.max(maxTime - minTime, 2 * model.alignmentTolerancePs);
  if (predictions.some(t => !Number.isFinite(t) || t < minTime - allowance || t > maxTime + allowance)) {
    return reject("The predicted chirp diverges outside the fitting range; choose a wider supported range.");
  }
  const ranges = [];
  if (range.min > outputRange.min) ranges.push({ side: "blue", min: outputRange.min, max: range.min });
  if (range.max < outputRange.max) ranges.push({ side: "red", min: range.max, max: outputRange.max });
  // A sparse tail may still contain contradictory detected arrivals. Preserve
  // that evidence rather than treating low anchor count as no evidence at all.
  const evidence = fullRangeEvidence ?? estimateChirpCore(analysis, options);
  const tolerancePs = 2 * model.alignmentTolerancePs;
  const outside = evidence.anchors.filter(a => a.wavelength < range.min || a.wavelength > range.max)
    .map(a => ({ wavelength: a.wavelength, arrival: a.arrival, predicted: chirpArrival(model, a.wavelength) }));
  const conflicts = outside.filter(a => Math.abs(a.arrival - a.predicted) > tolerancePs);
  const outsideAnchorCheck = { testedCount: outside.length, conflictingCount: conflicts.length, tolerancePs, conflicts };
  const conflictNote = conflicts.length
    ? ` ${conflicts.length} detected arrival anchors outside the fitting range disagree with this prediction by more than ${tolerancePs.toFixed(3)} ps; excluded-region timing requires review.` : "";
  if (conflicts.length && mode === "auto-red-tail") {
    return { ...reject(`Automatic red-tail prediction conflicts with ${conflicts.length} detected arrival anchors outside the fitting range. Inspect these wavelengths and explicitly choose a fitting range to use a predicted correction.`), outsideAnchorCheck };
  }
  return { ...model, outsideAnchorCheck, algorithm: "free-intercept-polynomial-v4-prediction", reason: "qualified-with-prediction",
    relativeDispersionStatus: "predicted-outside-fitting-range",
    extrapolation: { ranges, method: "low-order-polynomial", validated: false,
      warning: "Correction outside the fitting wavelength range is predicted, not independently validated by local arrival anchors." + conflictNote },
  };
}

function estimateChirpCore(analysis, options) {
  const attempts = [];
  const degrees = options.maxDegree === 2 ? [1, 2] : [1, 2, 3];
  for (const halfWidth of [0.5, 0.75, 1, 1.5, 2]) {
    for (const degree of degrees) {
      const result = estimateChirpCandidate(analysis, options, halfWidth, degree);
      attempts.push(result);
    }
  }
  const qualified = attempts.filter(a => a.accepted).sort((a, b) => a.selectedDegree - b.selectedDegree);
  if (qualified.length) {
    const result = qualified[0];
    const disagreement = qualified.some(other => analysis.spectralAxis.some(w => Math.abs(chirpArrival(other, w) - chirpArrival(result, w)) > 2 * result.alignmentTolerancePs));
    return { ...result, ...(disagreement ? { accepted: false, reason: "Qualified search windows or polynomial degrees disagree; manual calibration is required.", absoluteOffsetStatus: "review-required", relativeDispersionStatus: "review-required" } : {}),
      candidateDisagreement: disagreement,
      qualifiedCandidateCount: qualified.length, testedCandidateCount: attempts.length,
      selectedSearchWindowPs: result.searchWindowsPs[0],
      searchWindowsPs: attempts.filter((_, i) => i % degrees.length === 0).map(a => a.searchWindowsPs[0]).filter(Boolean),
      attemptedCandidates: attempts.map(a => ({ degree: a.selectedDegree, window: a.searchWindowsPs[0], accepted: a.accepted, reason: a.reason, heldOutP95: a.heldOutP95 })) };
  }
  // Keep the candidate with the most inliers for
  // review; none of these fits may be applied without qualification.
  const result = attempts.slice().sort((a, b) => (b.inlierCount || 0) - (a.inlierCount || 0))[0];
  return { ...result, qualifiedCandidateCount: 0, testedCandidateCount: attempts.length, selectedSearchWindowPs: result.searchWindowsPs[0], searchWindowsPs: attempts.filter((_, i) => i % degrees.length === 0).map(a => a.searchWindowsPs[0]).filter(Boolean),
    attemptedCandidates: attempts.map(a => ({ degree: a.selectedDegree, window: a.searchWindowsPs[0], accepted: a.accepted, reason: a.reason, heldOutP95: a.heldOutP95 })) };
}

function estimateChirpCandidate(analysis, options, halfWidth, degree) {
  const times = analysis.timeAxis;
  const wavelengths = analysis.spectralAxis;
  const hint = Number.isFinite(options.approximateZeroTimePs)
    ? options.approximateZeroTimePs : automaticHint(analysis);
  const base = {
    algorithm: "free-intercept-polynomial-v3-consensus",
    referenceWavelength: median(wavelengths), referenceTime: hint,
    coefficients: [0, 0, 0], sourceRange: { min: wavelengths[0], max: wavelengths.at(-1) },
    searchWindowsPs: [], anchors: [], accepted: false, selectedDegree: degree,
    absoluteOffsetStatus: "review-required", relativeDispersionStatus: "review-required",
    qualifiedOffset: 0, heldOutAgreement: false, onsetAgreement: false,
  };
  if (!Number.isFinite(hint) || wavelengths.length < 8) {
    return { ...base, reason: "At least eight signal-bearing wavelengths and an arrival-time estimate are required." };
  }
  const localSteps = times.slice(1).flatMap((t, i) => Math.abs(t - hint) <= 1 && t > times[i] ? [t - times[i]] : []);
  const step = median(localSteps);
  const tolerance = Math.max(0.03, 1.5 * step);
  if (!Number.isFinite(step) || tolerance > 0.15) {
    return { ...base, reason: "Insufficient time resolution near the estimated arrival; inspect the input range." };
  }
  const guard = Math.max(0.15, 3 * step);
  base.searchWindowsPs.push([hint - halfWidth, hint + halfWidth]);
  const anchors = analysis.matrix.flatMap((row, index) => {
      const anchor = rowArrival(row, times, hint, halfWidth, step, guard);
      return anchor ? [{ ...anchor, index, wavelength: wavelengths[index] }] : [];
    });
  const coverage = anchors.length / wavelengths.length;
  const span = anchors.length
    ? (Math.max(...anchors.map(a => a.wavelength)) - Math.min(...anchors.map(a => a.wavelength))) / (wavelengths.at(-1) - wavelengths[0]) : 0;
  Object.assign(base, { anchors, support: anchors.length, coverage, wavelengthSpanFraction: span, baselineGuardPs: guard, alignmentTolerancePs: tolerance });
  if (anchors.length < 8 || coverage < 0.2 || span < 0.6) {
    return { ...base, reason: "Insufficient finite pre-arrival baseline or signal support across the wavelength range." };
  }
  const referenceWavelength = median(anchors.map(a => a.wavelength));
  const wavelengthScale = Math.max(1, (wavelengths.at(-1) - wavelengths[0]) / 2);
  const candidate = fitArrivalPolynomial(anchors, referenceWavelength, wavelengthScale, tolerance, degree);
  if (!candidate) return { ...base, reason: "The chirp polynomial is rank deficient or has insufficient inlier support." };
  const allResiduals = anchors.map(a => a.arrival - chirpArrival(candidate, a.wavelength));
  // A small number of rows may contain a stronger kinetic feature or a noise
  // spike. Reject those rows explicitly, without allowing an unsupported
  // wavelength region to disappear from validation.
  const inliers = anchors.filter((_, i) => Math.abs(allResiduals[i]) <= tolerance);
  const inlierSet = new Set(inliers);
  const inlierFraction = inliers.length / anchors.length;
  const wavelengthBins = Array.from({ length: 5 }, () => []);
  anchors.forEach(a => wavelengthBins[Math.min(4, Math.floor(5 * (a.wavelength - wavelengths[0]) / (wavelengths.at(-1) - wavelengths[0])))].push(a));
  const spectralBinCounts = Array(5).fill(0);
  wavelengths.forEach(w => spectralBinCounts[Math.min(4, Math.floor(5 * (w - wavelengths[0]) / (wavelengths.at(-1) - wavelengths[0])))]++);
  const wavelengthSupport = wavelengthBins.map((bin, i) => ({
    minNm: wavelengths[0] + i * (wavelengths.at(-1) - wavelengths[0]) / 5,
    maxNm: wavelengths[0] + (i + 1) * (wavelengths.at(-1) - wavelengths[0]) / 5,
    channels: spectralBinCounts[i], anchors: bin.length,
    requiredAnchors: Math.max(1, Math.ceil(0.1 * spectralBinCounts[i])),
    inliers: bin.filter(a => inlierSet.has(a)).length,
  }));
  const unsupported = wavelengthSupport.find(bin => bin.anchors < bin.requiredAnchors);
  const inconsistent = wavelengthSupport.find(bin => !bin.anchors || bin.inliers / bin.anchors < 0.7);
  const consensusDistributed = !unsupported && !inconsistent;
  const consensusAgreement = inliers.length >= 8 && inlierFraction >= 0.8 && consensusDistributed;
  const residuals = inliers.map(a => a.arrival - chirpArrival(candidate, a.wavelength));
  const sorted = anchors.slice().sort((a, b) => a.wavelength - b.wavelength);
  const heldOutErrors = [], heldOutAll = [];
  let heldOutBlocksAgree = true;
  for (let block = 0; block < 5; block++) {
    const train = sorted.filter((_, i) => Math.floor(i * 5 / sorted.length) !== block);
    const held = sorted.filter((_, i) => Math.floor(i * 5 / sorted.length) === block);
    const fit = fitArrivalPolynomial(train, referenceWavelength, wavelengthScale, tolerance, degree);
    if (!fit) { heldOutBlocksAgree = false; continue; }
    const errors = held.map(a => a.arrival - chirpArrival(fit, a.wavelength));
    heldOutAll.push(...errors);
    // Held-out membership is decided by the training fit, not by the full fit.
    const consistent = errors.filter(e => Math.abs(e) <= 2 * tolerance);
    if (consistent.length / held.length < 0.7) heldOutBlocksAgree = false;
    heldOutErrors.push(...consistent);
  }
  const onsetOffsets = inliers.map(a => a.arrival - a.onset);
  const boundaryFraction = inliers.filter(a => Math.abs(a.arrival - hint) >= halfWidth - Math.max(0.08, 1.5 * a.localStepPs)).length / inliers.length;
  const residualP95 = percentile(allResiduals.map(Math.abs), 0.95);
  const inlierResidualP95 = percentile(residuals.map(Math.abs), 0.95);
  const heldOutP95 = percentile(heldOutAll.map(Math.abs), 0.95);
  const heldOutInlierP95 = percentile(heldOutErrors.map(Math.abs), 0.95);
  const onsetAgreement = percentile(onsetOffsets.map(Math.abs), 0.95) <= 0.3 + step;
  const heldOutAgreement = heldOutAll.length === anchors.length && heldOutBlocksAgree && heldOutErrors.length / anchors.length >= 0.8;
  const predictions = wavelengths.map(w => chirpArrival(candidate, w));
  const supportedPredictions = predictions.every(t => Number.isFinite(t) && Math.abs(t - hint) <= halfWidth + tolerance);
  const accepted = consensusAgreement && onsetAgreement && heldOutAgreement && boundaryFraction < 0.2 && supportedPredictions;
  return {
    ...base, ...candidate, accepted,
    reason: accepted ? "qualified" : unsupported
      ? `Insufficient signal anchors at ${Math.round(unsupported.minNm)}–${Math.round(unsupported.maxNm)} nm (${unsupported.anchors}; at least ${unsupported.requiredAnchors} required). Review the wavelength range or use a separate calibration.`
      : inconsistent ? `Conflicting arrival times at ${Math.round(inconsistent.minNm)}–${Math.round(inconsistent.maxNm)} nm (${inconsistent.inliers}/${inconsistent.anchors} anchors agree). Inspect this spectral region before correcting.`
      : !consensusAgreement ? "Insufficient wavelength-distributed arrival consensus."
      : !onsetAgreement ? "Slope and onset timing disagree."
      : !heldOutAgreement ? "Held-out wavelength prediction exceeds the timing tolerance."
        : "The chirp reaches the search boundary or extrapolates beyond supported arrival times.",
    absoluteOffsetStatus: accepted ? "qualified" : "review-required",
    relativeDispersionStatus: accepted ? "qualified" : "review-required",
    residualP95, inlierResidualP95, residualWidth: width(allResiduals), rawWidth: width(anchors.map(a => a.arrival)),
    heldOutP95, heldOutInlierP95, heldOutMedian: median(heldOutAll), heldOutWidth: width(heldOutAll),
    heldOutCount: heldOutAll.length, heldOutInlierCount: heldOutErrors.length, heldOutAgreement, boundaryFraction,
    inlierCount: inliers.length, inlierFraction, consensusDistributed, consensusAgreement, wavelengthSupport,
    excludedAnchorIndices: anchors.filter(a => !inlierSet.has(a)).map(a => a.index),
    onsetMedian: median(onsetOffsets), onsetWidth: width(onsetOffsets), onsetCount: onsetOffsets.length, onsetAgreement,
  };
}

export function chirpArrival(model, wavelength) {
  const x = (wavelength - model.referenceWavelength) / 100;
  return model.referenceTime + model.coefficients.reduce((sum, c, i) => sum + c * x ** (i + 1), 0);
}

function rowArrival(row, times, hint, halfWidth, step, guard) {
  let best = null;
  for (let i = 1; i < times.length - 1; i++) {
    if (Math.abs(times[i] - hint) > halfWidth || ![row[i - 1], row[i], row[i + 1]].every(Number.isFinite)) continue;
    const localStep = Math.max(times[i] - times[i - 1], times[i + 1] - times[i]);
    if (!(localStep > 0) || localStep > 0.15) continue;
    let left = i, right = i;
    while (left > 0 && Number.isFinite(row[left - 1]) && times[i] - times[left - 1] <= Math.max(0.12, 2 * localStep)) left--;
    while (right + 1 < times.length && Number.isFinite(row[right + 1]) && times[right + 1] - times[i] <= Math.max(0.12, 2 * localStep)) right++;
    if (right - left < 2) continue;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = left; j <= right; j++) {
      const x = times[j] - times[i], w = Math.exp(-0.5 * (x / Math.max(0.05, localStep)) ** 2);
      sw += w; sx += w * x; sy += w * row[j]; sxx += w * x * x; sxy += w * x * row[j];
    }
    const denominator = sw * sxx - sx * sx;
    const slope = denominator > 0 ? Math.abs((sw * sxy - sx * sy) / denominator) : 0;
    if (slope > 0 && (!best || slope > best.slope * (1 + 1e-9))) best = { index: i, slope, ties: [i], localStep };
    else if (best && Math.abs(slope - best.slope) <= best.slope * 1e-9 && i - best.ties.at(-1) === 1) best.ties.push(i);
  }
  if (!best) return null;
  const k = best.index;
  const baselineEnd = Math.min(hint - guard, times[k] - guard);
  const baseline = row.filter((v, i) => Number.isFinite(v) && times[i] < baselineEnd && times[i] >= baselineEnd - Math.max(0.3, 6 * step));
  if (baseline.length < 3) return null;
  const center = median(baseline), noise = 1.4826 * median(baseline.map(v => Math.abs(v - center)));
  let end = k;
  while (end + 1 < times.length && Number.isFinite(row[end + 1]) && times[end + 1] <= times[k] + Math.max(guard, 2.5 * best.localStep)) end++;
  const peak = Math.max(...row.slice(k, end + 1).map(v => Math.abs(v - center)));
  if (peak < 10 * Math.max(noise, 1e-15)) return null;
  const extremum = row.slice(k, end + 1).reduce((a, b) => Math.abs(a - center) > Math.abs(b - center) ? a : b);
  const direction = Math.sign(extremum - center) || 1;
  const threshold = Math.max(1e-15, 3 * noise, Math.abs(row[k] - center) * 0.2);
  let start = k;
  while (start > 0 && Number.isFinite(row[start - 1]) && times[start - 1] >= hint - halfWidth) start--;
  for (let j = start; j <= end - 2; j++) {
    // Require a sustained finite departure rather than an isolated noise spike.
    if ([row[j], row[j + 1], row[j + 2]].every(v => Number.isFinite(v) && direction * (v - center) >= threshold)) {
      return { arrival: median(best.ties.map(i => times[i])), onset: times[j], baselineEnd, baselineCount: baseline.length, localStepPs: best.localStep };
    }
  }
  return null;
}

function fitArrivalPolynomial(anchors, referenceWavelength, wavelengthScale, tolerance, degree) {
  let samples = anchors;
  // Six training wavelengths allow five-block validation of an eight-row input.
  if (samples.length < 6) return null;
  for (let pass = 0; pass < 4; pass++) {
    const design = samples.map(a => { const x = (a.wavelength - referenceWavelength) / wavelengthScale; return Array.from({ length: degree + 1 }, (_, i) => x ** i); });
    const c = leastSquaresQr(design, samples.map(a => a.arrival));
    if (!c) return null;
    const fit = { referenceWavelength, referenceTime: c[0], coefficients: c.slice(1).map((v, i) => v * (100 / wavelengthScale) ** (i + 1)) };
    const errors = samples.map(a => a.arrival - chirpArrival(fit, a.wavelength));
    const mid = median(errors), mad = median(errors.map(e => Math.abs(e - mid)));
    const retained = samples.filter((_, i) => Math.abs(errors[i] - mid) <= Math.max(tolerance, 4.5 * mad));
    if (retained.length === samples.length || pass === 3) return fit;
    if (retained.length < 6) return null;
    samples = retained;
  }
  return null;
}

// Reorthogonalized QR on a scaled 2–4 column design avoids normal equations.
function leastSquaresQr(rows, values) {
  const columns = rows[0].length;
  const q = [], r = Array.from({ length: columns }, () => Array(columns).fill(0));
  for (let j = 0; j < columns; j++) {
    const column = rows.map(row => row[j]);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < j; k++) {
      const dot = column.reduce((sum, v, i) => sum + v * q[k][i], 0);
      r[k][j] += dot;
      column.forEach((_, i) => { column[i] -= dot * q[k][i]; });
    }
    r[j][j] = Math.sqrt(column.reduce((sum, v) => sum + v * v, 0));
    if (r[j][j] < 1e-10) return null;
    q.push(column.map(v => v / r[j][j]));
  }
  const result = q.map(column => column.reduce((sum, v, i) => sum + v * values[i], 0));
  for (let i = columns - 1; i >= 0; i--) {
    for (let j = i + 1; j < columns; j++) result[i] -= r[i][j] * result[j];
    result[i] /= r[i][i];
  }
  return result;
}

function automaticHint(analysis) {
  const positive = analysis.timeAxis.filter(t => t > 0);
  const end = positive.length ? Math.min(8, positive[Math.floor(positive.length * 0.16)]) : analysis.timeAxis.at(-1);
  const arrivals = analysis.matrix.flatMap(row => {
    let best = null;
    for (let i = 1; i < analysis.timeAxis.length && analysis.timeAxis[i] <= end; i++) {
      if (![row[i - 1], row[i]].every(Number.isFinite)) continue;
      const dt = analysis.timeAxis[i] - analysis.timeAxis[i - 1];
      const slope = dt > 0 ? Math.abs((row[i] - row[i - 1]) / dt) : 0;
      if (slope > 0 && (!best || slope > best.slope)) best = { time: analysis.timeAxis[i], slope };
    }
    return best ? [best.time] : [];
  });
  return median(arrivals);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.round((sorted.length - 1) * p)] : Infinity;
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : Number.NaN;
}
function width(values) { return percentile(values, 0.95) - percentile(values, 0.05); }
