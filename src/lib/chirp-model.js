// All arrival times refer to the input axis. The fitted intercept and dispersion
// are validated together; the same estimator is used in each held-out block.
export function estimateChirpModel(analysis, options = {}) {
  const times = analysis.timeAxis;
  const wavelengths = analysis.spectralAxis;
  const hint = Number.isFinite(options.approximateZeroTimePs)
    ? options.approximateZeroTimePs : automaticHint(analysis);
  const base = {
    algorithm: "free-intercept-cubic-v2",
    referenceWavelength: median(wavelengths), referenceTime: hint,
    coefficients: [0, 0, 0], sourceRange: { min: wavelengths[0], max: wavelengths.at(-1) },
    searchWindowsPs: [], anchors: [], accepted: false,
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
  let anchors = [], halfWidth = 0.5;
  for (halfWidth of [0.5, 0.75, 1]) {
    base.searchWindowsPs.push([hint - halfWidth, hint + halfWidth]);
    anchors = analysis.matrix.flatMap((row, index) => {
      const anchor = rowArrival(row, times, hint, halfWidth, step, guard);
      return anchor ? [{ ...anchor, index, wavelength: wavelengths[index] }] : [];
    });
    const boundary = anchors.filter(a => Math.abs(a.arrival - hint) >= halfWidth - Math.max(0.08, step)).length;
    if (anchors.length >= Math.max(8, wavelengths.length * 0.2) && boundary / anchors.length < 0.1) break;
  }
  const coverage = anchors.length / wavelengths.length;
  const span = anchors.length
    ? (Math.max(...anchors.map(a => a.wavelength)) - Math.min(...anchors.map(a => a.wavelength))) / (wavelengths.at(-1) - wavelengths[0]) : 0;
  Object.assign(base, { anchors, support: anchors.length, coverage, wavelengthSpanFraction: span, baselineGuardPs: guard, alignmentTolerancePs: tolerance });
  if (anchors.length < 8 || coverage < 0.2 || span < 0.6) {
    return { ...base, reason: "Insufficient finite pre-arrival baseline or signal support across the wavelength range." };
  }
  const referenceWavelength = median(anchors.map(a => a.wavelength));
  const wavelengthScale = Math.max(1, (wavelengths.at(-1) - wavelengths[0]) / 2);
  const candidate = fitArrivalPolynomial(anchors, referenceWavelength, wavelengthScale, tolerance);
  if (!candidate) return { ...base, reason: "The chirp polynomial is rank deficient or has insufficient inlier support." };
  const residuals = anchors.map(a => a.arrival - chirpArrival(candidate, a.wavelength));
  const sorted = anchors.slice().sort((a, b) => a.wavelength - b.wavelength);
  const heldOutErrors = [];
  for (let block = 0; block < 5; block++) {
    const train = sorted.filter((_, i) => Math.floor(i * 5 / sorted.length) !== block);
    const held = sorted.filter((_, i) => Math.floor(i * 5 / sorted.length) === block);
    const fit = fitArrivalPolynomial(train, referenceWavelength, wavelengthScale, tolerance);
    if (fit) held.forEach(a => heldOutErrors.push(a.arrival - chirpArrival(fit, a.wavelength)));
  }
  const onsetOffsets = anchors.map(a => a.arrival - a.onset);
  const boundaryFraction = anchors.filter(a => Math.abs(a.arrival - hint) >= halfWidth - Math.max(0.08, step)).length / anchors.length;
  const residualP95 = percentile(residuals.map(Math.abs), 0.95);
  const heldOutP95 = percentile(heldOutErrors.map(Math.abs), 0.95);
  const onsetAgreement = percentile(onsetOffsets.map(Math.abs), 0.95) <= 0.3 + step;
  const heldOutAgreement = heldOutErrors.length === anchors.length && heldOutP95 <= 2 * tolerance;
  const predictions = wavelengths.map(w => chirpArrival(candidate, w));
  const supportedPredictions = predictions.every(t => Number.isFinite(t) && Math.abs(t - hint) <= halfWidth + tolerance);
  const accepted = onsetAgreement && heldOutAgreement && residualP95 <= tolerance && boundaryFraction < 0.2 && supportedPredictions;
  return {
    ...base, ...candidate, accepted,
    reason: accepted ? "qualified" : !onsetAgreement ? "Slope and onset timing disagree."
      : !heldOutAgreement ? "Held-out wavelength prediction exceeds the timing tolerance."
        : residualP95 > tolerance ? "Residual chirp exceeds the timing tolerance."
          : "The chirp reaches the search boundary or extrapolates beyond supported arrival times.",
    absoluteOffsetStatus: accepted ? "qualified" : "review-required",
    relativeDispersionStatus: accepted ? "qualified" : "review-required",
    residualP95, residualWidth: width(residuals), rawWidth: width(anchors.map(a => a.arrival)),
    heldOutP95, heldOutMedian: median(heldOutErrors), heldOutWidth: width(heldOutErrors),
    heldOutCount: heldOutErrors.length, heldOutAgreement, boundaryFraction,
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
    let left = i, right = i;
    while (left > 0 && Number.isFinite(row[left - 1]) && times[i] - times[left - 1] <= Math.max(0.12, 2 * step)) left--;
    while (right + 1 < times.length && Number.isFinite(row[right + 1]) && times[right + 1] - times[i] <= Math.max(0.12, 2 * step)) right++;
    if (right - left < 2) continue;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = left; j <= right; j++) {
      const x = times[j] - times[i], w = Math.exp(-0.5 * (x / Math.max(0.05, step)) ** 2);
      sw += w; sx += w * x; sy += w * row[j]; sxx += w * x * x; sxy += w * x * row[j];
    }
    const denominator = sw * sxx - sx * sx;
    const slope = denominator > 0 ? Math.abs((sw * sxy - sx * sy) / denominator) : 0;
    if (slope > 0 && (!best || slope > best.slope * (1 + 1e-9))) best = { index: i, slope, ties: [i] };
    else if (best && Math.abs(slope - best.slope) <= best.slope * 1e-9 && i - best.ties.at(-1) === 1) best.ties.push(i);
  }
  if (!best) return null;
  const k = best.index;
  const baselineEnd = Math.min(hint - guard, times[k] - guard);
  const baseline = row.filter((v, i) => Number.isFinite(v) && times[i] < baselineEnd && times[i] >= baselineEnd - Math.max(0.3, 6 * step));
  if (baseline.length < 3) return null;
  const center = median(baseline), noise = 1.4826 * median(baseline.map(v => Math.abs(v - center)));
  let end = k;
  while (end + 1 < times.length && Number.isFinite(row[end + 1]) && times[end + 1] <= times[k] + guard) end++;
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
      return { arrival: median(best.ties.map(i => times[i])), onset: times[j], baselineEnd, baselineCount: baseline.length };
    }
  }
  return null;
}

function fitArrivalPolynomial(anchors, referenceWavelength, wavelengthScale, tolerance) {
  let samples = anchors;
  // Six training wavelengths allow five-block validation of an eight-row input.
  if (samples.length < 6) return null;
  for (let pass = 0; pass < 4; pass++) {
    const design = samples.map(a => { const x = (a.wavelength - referenceWavelength) / wavelengthScale; return [1, x, x * x, x * x * x]; });
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

// Reorthogonalized QR on a scaled four-column design avoids normal equations.
function leastSquaresQr(rows, values) {
  const q = [], r = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (let j = 0; j < 4; j++) {
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
  for (let i = 3; i >= 0; i--) {
    for (let j = i + 1; j < 4; j++) result[i] -= r[i][j] * result[j];
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
