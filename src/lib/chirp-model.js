// Arrival times are on the original input axis. The seed is not a fixed intercept.
export function estimateChirpModel(analysis, options = {}) {
  const times = analysis.timeAxis ?? [], wavelengths = analysis.spectralAxis ?? [];
  const seed = Number.isFinite(options.approximateZeroTimePs) ? options.approximateZeroTimePs : automaticHint(analysis);
  const referenceWavelength = Number.isFinite(options.referenceWavelength) ? options.referenceWavelength : median(wavelengths);
  const base = { algorithm: "free-intercept-polynomial-v5", seedTimePs: seed, referenceWavelength, referenceTime: seed,
    coefficients: [], anchors: [], support: 0, selectedDegree: 0, warnings: [], accepted: true };
  if (!Number.isFinite(seed) || !Number.isFinite(referenceWavelength)) return { ...base, accepted: false, reason: "A finite time seed and reference wavelength are required." };
  const steps = times.slice(1).map((t, i) => ({ dt: t - times[i], time: (t + times[i]) / 2 })).filter(x => x.dt > 0 && Number.isFinite(x.dt));
  const nearSteps = steps.filter(x => Math.abs(x.time - seed) <= 1).map(x => x.dt);
  const step = median(nearSteps.length ? nearSteps : steps.map(x => x.dt)), tolerance = Math.max(0.03, Number.isFinite(step) ? 1.5 * step : 0.03);
  const guard = Math.max(0.15, Number.isFinite(step) ? 3 * step : 0.15);
  let anchors = [], halfWidth = 0.5;
  for (const window of [0.5, 0.75, 1, 1.5, 2]) {
    halfWidth = window;
    const candidates = analysis.matrix.flatMap((row, index) => {
      const candidate = rowArrival(row, times, seed, window, step, guard);
      return candidate ? [{ ...candidate, index, wavelength: wavelengths[index] }] : [];
    });
    const strong = candidates.filter(a => a.baselineBacked);
    anchors = strong.length >= Math.min(4, wavelengths.length) ? strong : candidates;
    const interior = anchors.filter(a => Math.abs(a.arrival - seed) < window - Math.max(0.08, 1.5 * a.localStepPs));
    if (anchors.length >= Math.min(4, wavelengths.length) && interior.length >= 0.8 * anchors.length) break;
  }
  Object.assign(base, { anchors, support: anchors.length, alignmentTolerancePs: tolerance, baselineGuardPs: guard,
    selectedSearchWindowPs: [seed - halfWidth, seed + halfWidth], searchWindowsPs: [[seed - halfWidth, seed + halfWidth]] });
  if (!anchors.length) return { ...base, method: "seed-only", reason: "seed-only", warnings: ["No usable signal arrival was detected; a constant seed-only shift was applied."] };
  if (anchors.some(a => !a.baselineBacked)) base.warnings.push("Some arrivals use finite slopes without baseline or signal-to-noise confirmation.");
  const scale = Math.max(1, (Math.max(...wavelengths) - Math.min(...wavelengths)) / 2);
  const maxDegree = Math.min(3, new Set(anchors.map(a => a.wavelength)).size - 1);
  let chosen = null;
  for (let degree = maxDegree ? 1 : 0; degree <= maxDegree; degree++) {
    const fit = fitArrivalPolynomial(anchors, referenceWavelength, scale, tolerance, degree);
    if (!fit) continue;
    const residualP95 = percentile(anchors.map(a => Math.abs(a.arrival - chirpArrival(fit, a.wavelength))), 0.95);
    const candidate = { ...fit, selectedDegree: degree, residualP95 };
    if (!chosen || candidate.residualP95 < chosen.residualP95) chosen = candidate;
    if (residualP95 <= tolerance * 0.5) { chosen = candidate; break; }
  }
  if (!chosen) {
    chosen = { referenceTime: median(anchors.map(a => a.arrival)), coefficients: [], selectedDegree: 0,
      residualP95: percentile(anchors.map(a => Math.abs(a.arrival - median(anchors.map(b => b.arrival)))), 0.95) };
    base.warnings.push("Polynomial fit was underdetermined; a constant arrival was used.");
  }
  if (chosen.residualP95 > tolerance) base.warnings.push("Arrival residuals exceed the timing heuristic; inspect the correction and retry with different initial values if needed.");
  return { ...base, ...chosen, method: "estimated", reason: "estimated" };
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
    if (!(localStep > 0)) continue;
    let left = i, right = i;
    while (left > 0 && Number.isFinite(row[left - 1]) && times[i] - times[left - 1] <= Math.max(0.12, 2 * localStep)) left--;
    while (right + 1 < times.length && Number.isFinite(row[right + 1]) && times[right + 1] - times[i] <= Math.max(0.12, 2 * localStep)) right++;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = left; j <= right; j++) {
      const x = times[j] - times[i], w = Math.exp(-0.5 * (x / Math.max(0.05, localStep)) ** 2);
      const y = row[j] - row[i];
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    const denominator = sw * sxx - sx * sx;
    const slope = denominator > 0 ? Math.abs((sw * sxy - sx * sy) / denominator) : 0;
    if (slope > 0 && (!best || slope > best.slope * (1 + 1e-9))) best = { index: i, slope, ties: [i], localStep };
    else if (best && Math.abs(slope - best.slope) <= best.slope * 1e-9 && i - best.ties.at(-1) === 1) best.ties.push(i);
  }
  if (!best) return null;
  const k = best.index, baselineEnd = Math.min(hint - guard, times[k] - guard);
  const baseline = row.filter((v, i) => Number.isFinite(v) && times[i] < baselineEnd && times[i] >= baselineEnd - Math.max(0.3, 6 * step));
  const center = median(baseline), noise = 1.4826 * median(baseline.map(v => Math.abs(v - center)));
  let end = k;
  while (end + 1 < times.length && Number.isFinite(row[end + 1]) && times[end + 1] <= times[k] + Math.max(guard, 2.5 * best.localStep)) end++;
  const peak = Math.max(...row.slice(k, end + 1).map(v => Math.abs(v - center)));
  return { arrival: median(best.ties.map(i => times[i])), localStepPs: best.localStep, baselineCount: baseline.length,
    baselineBacked: baseline.length >= 3 && peak >= 10 * Math.max(noise, 1e-15) };
}

function fitArrivalPolynomial(anchors, referenceWavelength, scale, tolerance, degree) {
  let samples = anchors, lastFit = null;
  for (let pass = 0; pass < 4; pass++) {
    const design = samples.map(a => { const x = (a.wavelength - referenceWavelength) / scale; return Array.from({ length: degree + 1 }, (_, i) => x ** i); });
    const c = leastSquaresQr(design, samples.map(a => a.arrival));
    if (!c) return lastFit;
    const fit = { referenceWavelength, referenceTime: c[0], coefficients: c.slice(1).map((v, i) => v * (100 / scale) ** (i + 1)) };
    lastFit = fit;
    const errors = samples.map(a => a.arrival - chirpArrival(fit, a.wavelength));
    const mid = median(errors), mad = median(errors.map(e => Math.abs(e - mid)));
    const retained = samples.filter((_, i) => Math.abs(errors[i] - mid) <= Math.max(tolerance, 4.5 * mad));
    if (retained.length === samples.length || retained.length < degree + 1) return fit;
    samples = retained;
  }
  return lastFit;
}

function leastSquaresQr(rows, values) {
  if (!rows.length) return null;
  const columns = rows[0].length, q = [], r = Array.from({ length: columns }, () => Array(columns).fill(0));
  for (let j = 0; j < columns; j++) {
    const column = rows.map(row => row[j]);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < j; k++) {
      const dot = column.reduce((sum, v, i) => sum + v * q[k][i], 0);
      r[k][j] += dot; column.forEach((_, i) => { column[i] -= dot * q[k][i]; });
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
  const times = analysis.timeAxis ?? [];
  const arrivals = (analysis.matrix ?? []).flatMap(row => {
    let best = null;
    for (let i = 1; i < times.length; i++) {
      if (![row[i - 1], row[i]].every(Number.isFinite)) continue;
      const dt = times[i] - times[i - 1], slope = dt > 0 ? Math.abs((row[i] - row[i - 1]) / dt) : 0;
      if (slope > 0 && (!best || slope > best.slope)) best = { time: times[i], slope };
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
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : Number.NaN;
}
