const GAUSSIAN_FWHM_FACTOR = 2.354820045;

export const MULTI_GAUSSIAN_SCHEMA = "specflowlab.multi_gaussian_fit.v1";

export function fitMultiGaussianSpectrum(xValues, yValues, options = {}) {
  const finitePoints = pairedFinitePoints(xValues, yValues);
  const points = decimatePoints(finitePoints, Math.max(50, options.maximumFitPoints ?? 360));
  if (points.length < 7) return unavailable("At least seven finite wavelength points are required.");

  const x = points.map((point) => point.x);
  const y = points.map((point) => point.y);
  const spacing = medianPositiveSpacing(x);
  const span = x.at(-1) - x[0];
  if (!(spacing > 0) || !(span > 0)) return unavailable("A strictly increasing wavelength range is required.");

  const minimumFwhmNm = Math.max(options.minimumFwhmNm ?? spacing * 1.5, spacing * 1.2);
  const minimumSigma = minimumFwhmNm / GAUSSIAN_FWHM_FACTOR;
  const maximumSigma = Math.max(minimumSigma, span / 2);
  const maximumPeaks = clampInteger(options.maximumPeaks ?? 6, 1, 12);
  const minimumSnr = Math.max(1, options.minimumSnr ?? 4);
  const minimumBicImprovement = Math.max(0, options.minimumBicImprovement ?? 6);
  const baseline = solveMixture(x, y, []);
  const signalScale = Math.max(...y) - Math.min(...y);
  const initialNoise = robustNoise(baseline.residuals, signalScale);
  const seeds = discoverSeeds(x, baseline.residuals, initialNoise, {
    minimumSigma,
    maximumSigma,
    minimumSeedSnr: Math.max(1.5, Math.min(minimumSnr * 0.55, 3)),
    maximumSeeds: Math.max(maximumPeaks * 3, 8),
  });

  let model = { ...baseline, peaks: [], bic: informationCriterion(baseline.sse, x.length, 2) };
  for (const seed of seeds) {
    if (model.peaks.length >= maximumPeaks) break;
    if (model.peaks.some((peak) => {
      const distance = Math.abs(peak.centerNm - seed.centerNm);
      const signedSeparation = peak.sign === seed.sign
        ? Math.max(minimumSigma, Math.max(peak.sigmaNm, seed.sigmaNm) * GAUSSIAN_FWHM_FACTOR * 0.55)
        : minimumSigma * 0.7;
      return distance < signedSeparation;
    })) continue;
    const candidate = optimizeMixture(x, y, [...model.peaks, seed], { minimumSigma, maximumSigma, spacing });
    const addedPeak = candidate.peaks.reduce((closest, peak) => (
      Math.abs(peak.centerNm - seed.centerNm) < Math.abs(closest.centerNm - seed.centerNm) ? peak : closest
    ), candidate.peaks[0]);
    const candidateNoise = Math.max(initialNoise, robustNoise(candidate.residuals, signalScale));
    const improvement = model.bic - candidate.bic;
    if (!addedPeak || addedPeak.amplitudeAbs / candidateNoise < minimumSnr || improvement < minimumBicImprovement) continue;
    model = candidate;
  }

  if (!model.peaks.length) {
    return {
      schema: MULTI_GAUSSIAN_SCHEMA,
      status: "no-supported-peaks",
      peaks: [],
      diagnostics: {
        ...diagnostics(model, initialNoise, x.length),
        inputPointCount: finitePoints.length,
        fitPointPolicy: fitPointPolicy(finitePoints.length, points.length),
      },
    };
  }

  model = optimizeMixture(x, y, model.peaks, { minimumSigma, maximumSigma, spacing });
  const finalNoise = Math.max(initialNoise, robustNoise(model.residuals, signalScale));
  const peaks = model.peaks
    .map((peak, index) => describePeak(peak, index, model, x, y, finalNoise, minimumFwhmNm))
    .filter((peak) => peak.fwhmNm >= minimumFwhmNm
      && peak.amplitudeSnr >= minimumSnr
      && (options.includeEdgePeaks || !peak.qualityFlags.includes("edge-clipped")))
    .sort((left, right) => left.centerNm - right.centerNm);

  return {
    schema: MULTI_GAUSSIAN_SCHEMA,
    status: peaks.length ? "fit" : "no-supported-peaks",
    peaks,
    diagnostics: {
      ...diagnostics(model, finalNoise, x.length),
      inputPointCount: finitePoints.length,
      fitPointPolicy: fitPointPolicy(finitePoints.length, points.length),
    },
  };
}

function pairedFinitePoints(xValues = [], yValues = []) {
  return xValues
    .map((x, index) => ({ x, y: yValues[index], sourceIndex: index }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((left, right) => left.x - right.x || left.sourceIndex - right.sourceIndex);
}

function decimatePoints(points, maximumPoints) {
  if (points.length <= maximumPoints) return points;
  const result = [];
  for (let start = 0; start < points.length; start += points.length / maximumPoints) {
    const left = Math.floor(start);
    const right = Math.min(points.length, Math.max(left + 1, Math.floor(start + points.length / maximumPoints)));
    const bucket = points.slice(left, right);
    result.push({
      x: bucket.reduce((sum, point) => sum + point.x, 0) / bucket.length,
      y: bucket.reduce((sum, point) => sum + point.y, 0) / bucket.length,
      sourceIndex: bucket[Math.floor(bucket.length / 2)].sourceIndex,
    });
  }
  return result;
}

function discoverSeeds(x, residuals, noise, options) {
  const smoothed = residuals.map((value, index) => {
    const values = [residuals[index - 1], value, residuals[index + 1]].filter(Number.isFinite);
    return values.reduce((sum, entry) => sum + entry, 0) / values.length;
  });
  const seeds = [];
  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const magnitude = Math.abs(smoothed[index]);
    if (magnitude < noise * options.minimumSeedSnr) continue;
    if (magnitude < Math.abs(smoothed[index - 1]) || magnitude < Math.abs(smoothed[index + 1])) continue;
    const sign = Math.sign(smoothed[index]) || 1;
    const halfHeight = magnitude * 0.5;
    let left = index;
    let right = index;
    while (left > 0 && Math.sign(smoothed[left - 1]) === sign && Math.abs(smoothed[left - 1]) >= halfHeight) left -= 1;
    while (right < smoothed.length - 1 && Math.sign(smoothed[right + 1]) === sign && Math.abs(smoothed[right + 1]) >= halfHeight) right += 1;
    const estimatedFwhm = Math.max(x[right] - x[left], options.minimumSigma * GAUSSIAN_FWHM_FACTOR);
    seeds.push({
      centerNm: x[index],
      sigmaNm: clamp(estimatedFwhm / GAUSSIAN_FWHM_FACTOR, options.minimumSigma, options.maximumSigma),
      sign,
      seedStrength: magnitude / noise,
    });
  }
  if (!seeds.length) {
    const index = residuals.reduce((best, _value, candidate) => (
      Math.abs(residuals[candidate]) > Math.abs(residuals[best]) ? candidate : best
    ), 0);
    if (Math.abs(residuals[index]) >= noise * options.minimumSeedSnr) {
      seeds.push({ centerNm: x[index], sigmaNm: options.minimumSigma, sign: Math.sign(residuals[index]) || 1, seedStrength: Math.abs(residuals[index]) / noise });
    }
  }
  return seeds
    .sort((left, right) => right.seedStrength - left.seedStrength || left.centerNm - right.centerNm)
    .slice(0, options.maximumSeeds);
}

function optimizeMixture(x, y, initialPeaks, limits) {
  let peaks = initialPeaks.map((peak) => ({
    centerNm: clamp(peak.centerNm, x[0], x.at(-1)),
    sigmaNm: clamp(peak.sigmaNm, limits.minimumSigma, limits.maximumSigma),
    sign: peak.sign < 0 ? -1 : 1,
  }));
  let best = solveMixture(x, y, peaks);
  let centerStep = Math.max(limits.spacing, limits.minimumSigma * 0.7);
  for (let pass = 0; pass < 7; pass += 1) {
    for (let peakIndex = 0; peakIndex < peaks.length; peakIndex += 1) {
      const current = peaks[peakIndex];
      const trials = [
        current,
        { ...current, centerNm: clamp(current.centerNm - centerStep, x[0], x.at(-1)) },
        { ...current, centerNm: clamp(current.centerNm + centerStep, x[0], x.at(-1)) },
        { ...current, sigmaNm: clamp(current.sigmaNm / 1.25, limits.minimumSigma, limits.maximumSigma) },
        { ...current, sigmaNm: clamp(current.sigmaNm * 1.25, limits.minimumSigma, limits.maximumSigma) },
      ];
      for (const trial of trials) {
        const trialPeaks = peaks.map((peak, index) => index === peakIndex ? trial : peak);
        const fitted = solveMixture(x, y, trialPeaks);
        if (fitted.sse + Number.EPSILON < best.sse) {
          peaks = fitted.peaks;
          best = fitted;
        }
      }
    }
    centerStep *= 0.5;
  }
  const parameterCount = 2 + best.peaks.length * 3;
  return { ...best, bic: informationCriterion(best.sse, x.length, parameterCount) };
}

function solveMixture(x, y, peaks) {
  const xMid = (x[0] + x.at(-1)) / 2;
  const xScale = Math.max((x.at(-1) - x[0]) / 2, 1);
  const active = peaks.map((_peak, index) => index);
  let coefficients = null;
  let activeColumns = active.slice();
  while (true) {
    const design = x.map((wavelength) => [
      1,
      (wavelength - xMid) / xScale,
      ...activeColumns.map((index) => peaks[index].sign * gaussian(wavelength, peaks[index].centerNm, peaks[index].sigmaNm)),
    ]);
    coefficients = solveLeastSquares(design, y);
    if (!coefficients) break;
    const negativeColumn = coefficients.slice(2).findIndex((value) => value < 0);
    if (negativeColumn < 0) break;
    activeColumns.splice(negativeColumn, 1);
  }
  if (!coefficients) {
    return { peaks: [], predicted: y.map(() => 0), residuals: y.slice(), sse: y.reduce((sum, value) => sum + value ** 2, 0), rSquared: 0, baseline: { intercept: 0, slope: 0 } };
  }
  const fittedPeaks = activeColumns.map((peakIndex, coefficientIndex) => ({
    ...peaks[peakIndex],
    amplitude: peaks[peakIndex].sign * coefficients[coefficientIndex + 2],
    amplitudeAbs: coefficients[coefficientIndex + 2],
  }));
  const predicted = x.map((wavelength) => coefficients[0]
    + coefficients[1] * ((wavelength - xMid) / xScale)
    + fittedPeaks.reduce((sum, peak) => sum + peak.amplitude * gaussian(wavelength, peak.centerNm, peak.sigmaNm), 0));
  const residuals = y.map((value, index) => value - predicted[index]);
  const sse = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const yMean = mean(y);
  const sst = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  return {
    peaks: fittedPeaks,
    predicted,
    residuals,
    sse,
    rSquared: sst > 0 ? 1 - sse / sst : 0,
    baseline: { intercept: coefficients[0] - coefficients[1] * xMid / xScale, slope: coefficients[1] / xScale },
  };
}

function describePeak(peak, index, model, x, y, noise, minimumFwhmNm) {
  const fwhmNm = peak.sigmaNm * GAUSSIAN_FWHM_FACTOR;
  const regionMin = Math.max(x[0], peak.centerNm - fwhmNm);
  const regionMax = Math.min(x.at(-1), peak.centerNm + fwhmNm);
  const peakIndex = nearestIndex(x, peak.centerNm);
  const target = y.map((value, pointIndex) => value - (model.predicted[pointIndex] - peak.amplitude * gaussian(x[pointIndex], peak.centerNm, peak.sigmaNm)));
  const contribution = x.map((wavelength) => peak.amplitude * gaussian(wavelength, peak.centerNm, peak.sigmaNm));
  const localIndices = x.map((_value, pointIndex) => pointIndex).filter((pointIndex) => x[pointIndex] >= regionMin && x[pointIndex] <= regionMax);
  const localTarget = localIndices.map((pointIndex) => target[pointIndex]);
  const localMean = mean(localTarget);
  const total = localTarget.reduce((sum, value) => sum + (value - localMean) ** 2, 0);
  const residual = localIndices.reduce((sum, pointIndex) => sum + (target[pointIndex] - contribution[pointIndex]) ** 2, 0);
  const flags = [];
  if (regionMin === x[0] || regionMax === x.at(-1)) flags.push("edge-clipped");
  if (fwhmNm <= minimumFwhmNm * 1.05) flags.push("width-at-lower-bound");
  if (model.peaks.some((other, otherIndex) => otherIndex !== index && Math.abs(other.centerNm - peak.centerNm) < Math.max(fwhmNm, other.sigmaNm * GAUSSIAN_FWHM_FACTOR) * 0.75)) flags.push("overlapping");
  return {
    centerNm: peak.centerNm,
    sigmaNm: peak.sigmaNm,
    fwhmNm,
    amplitude: peak.amplitude,
    amplitudeAbs: peak.amplitudeAbs,
    amplitudeSnr: peak.amplitudeAbs / noise,
    area: peak.amplitude * peak.sigmaNm * Math.sqrt(2 * Math.PI),
    sign: peak.sign > 0 ? "positive" : "negative",
    peakIndex,
    wavelengthMin: regionMin,
    wavelengthMax: regionMax,
    pointCount: localIndices.length,
    rSquared: total > 0 ? 1 - residual / total : model.rSquared,
    truncated: flags.includes("edge-clipped"),
    qualityFlags: flags,
  };
}

function diagnostics(model, noise, pointCount) {
  return {
    modelOrder: model.peaks.length,
    baseline: model.baseline,
    rSquared: model.rSquared,
    residualRms: Math.sqrt(model.sse / Math.max(pointCount, 1)),
    robustNoise: noise,
    bic: model.bic ?? informationCriterion(model.sse, pointCount, 2 + model.peaks.length * 3),
    pointCount,
    selectionRule: "forward signed Gaussian addition; minimum amplitude SNR and BIC improvement",
  };
}

function fitPointPolicy(inputPointCount, fitPointCount) {
  return inputPointCount === fitPointCount
    ? "all finite wavelength points fitted"
    : `deterministic adjacent-bin means used for fitting (${fitPointCount} of ${inputPointCount} finite points); reported centers refer to physical wavelength`;
}

function robustNoise(values, signalScale) {
  const secondDifferences = [];
  for (let index = 1; index < values.length - 1; index += 1) {
    secondDifferences.push(values[index - 1] - 2 * values[index] + values[index + 1]);
  }
  const center = median(secondDifferences);
  const mad = median(secondDifferences.map((value) => Math.abs(value - center)));
  const estimate = mad / (0.67448975 * Math.sqrt(6));
  return Math.max(estimate, Math.abs(signalScale) * 1e-6, 1e-12);
}

function informationCriterion(sse, sampleCount, parameterCount) {
  const safeSse = Math.max(sse, Number.EPSILON * Math.max(sampleCount, 1));
  return sampleCount * Math.log(safeSse / sampleCount) + parameterCount * Math.log(sampleCount);
}

function solveLeastSquares(design, values) {
  const width = design[0]?.length ?? 0;
  if (!width || design.length < width) return null;
  const normal = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  for (let row = 0; row < design.length; row += 1) {
    for (let left = 0; left < width; left += 1) {
      rhs[left] += design[row][left] * values[row];
      for (let right = 0; right < width; right += 1) normal[left][right] += design[row][left] * design[row][right];
    }
  }
  return solveLinearSystem(normal, rhs);
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= size; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= size; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[size]);
}

function gaussian(x, center, sigma) {
  return Math.exp(-0.5 * ((x - center) / sigma) ** 2);
}

function medianPositiveSpacing(values) {
  return median(values.slice(1).map((value, index) => value - values[index]).filter((value) => value > 0));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function nearestIndex(values, target) {
  return values.reduce((best, value, index) => Math.abs(value - target) < Math.abs(values[best] - target) ? index : best, 0);
}

function unavailable(reason) {
  return { schema: MULTI_GAUSSIAN_SCHEMA, status: "unavailable", peaks: [], diagnostics: { reason } };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
