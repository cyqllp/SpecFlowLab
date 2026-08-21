export const GLOBAL_ANALYSIS_SCHEMA = "specflowlab.global_analysis.v2";

const SQRT_TWO = Math.sqrt(2);
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);
const MIN_POSITIVE = 1e-300;

export function fitVariableProjectionGlobal(analysis, componentCount, options = {}) {
  validateAnalysis(analysis);
  const count = clampInteger(componentCount, 1, 6, 1);
  const irfFwhm = Math.max(0, Number(options.irfFwhm) || 0);
  const fitIndexes = analysis.timeAxis
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => Number.isFinite(time))
    .map(({ index }) => index);
  if (fitIndexes.length < count + 5) throw new Error("Not enough finite time points for fitting.");

  const fitTimes = fitIndexes.map((index) => analysis.timeAxis[index]);
  const minimumLifetime = estimateLifetimeLowerBound(fitTimes);
  const maximumLifetime = estimateLifetimeUpperBound(fitTimes, minimumLifetime);
  const requested = Array.isArray(options.lifetimes) ? options.lifetimes.map(Number) : [];
  const fixedMask = normalizeFixedMask(requested, options.fixedLifetimes, count);
  const initialLifetimes = normalizeLifetimes(fitTimes, count, requested, minimumLifetime, maximumLifetime, fixedMask);
  const modelOptions = resolveModelOptions(fitTimes, irfFwhm, options);
  const rowWeights = buildSpectralWeights(analysis, fitIndexes, fitTimes, modelOptions, options.weighting ?? "robust-noise");
  const objective = createObjective(analysis, fitIndexes, fitTimes, irfFwhm, fixedMask, minimumLifetime, maximumLifetime, modelOptions, rowWeights);
  const optimized = optimizeMultiStart(objective, initialLifetimes, fixedMask, {
    minimumLifetime,
    maximumLifetime,
    maximumIterations: clampInteger(options.maximumIterations, 8, 120, 55),
    startCount: clampInteger(options.optimizerStarts, 1, 5, 3),
  });
  const lifetimes = optimized.lifetimes;
  const solved = solveConditional(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, modelOptions, rowWeights, true);
  const uncertainty = estimateLifetimeUncertainty(
    analysis,
    fitIndexes,
    fitTimes,
    lifetimes,
    irfFwhm,
    fixedMask,
    minimumLifetime,
    maximumLifetime,
    modelOptions,
    rowWeights,
    solved,
    optimized,
  );
  const irfLimited = lifetimes.map((lifetime) => lifetime <= Math.max(minimumLifetime, irfFwhm * 1.05));
  const amplitudeRanges = lifetimes.map((_, componentIndex) => {
    const values = solved.amplitudes.map((row) => row[componentIndex]).filter(Number.isFinite);
    return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: Number.NaN, max: Number.NaN };
  });
  const dasSpectra = buildDasSpectra(analysis.spectralAxis, lifetimes, solved.amplitudes);
  const easSpectra = buildSequentialEasPreview(analysis.spectralAxis, lifetimes, solved.amplitudes);
  const rangeSensitivity = options.rangeSensitivity === false
    ? { status: "not-evaluated", maximumRelativeShift: Number.NaN, variants: [] }
    : assessRangeSensitivity(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, fixedMask, modelOptions, rowWeights, {
      minimumLifetime,
      maximumLifetime,
      maximumIterations: clampInteger(options.rangeSensitivityIterations, 5, 30, 14),
    });
  const hasFixedLifetimes = fixedMask.some(Boolean);
  const convergenceWarnings = buildConvergenceWarnings(optimized, solved, rangeSensitivity, uncertainty);

  return {
    schema: GLOBAL_ANALYSIS_SCHEMA,
    model: "separable-global-exponential-v2",
    componentCount: count,
    irfFwhm,
    preZeroModel: modelOptions.preZeroLabel,
    coherentArtifactOrder: modelOptions.artifactOrder,
    lifetimeBasis: hasFixedLifetimes
      ? "variable projection with user-fixed components"
      : "variable projection with bounded multistart quasi-Newton refinement",
    lifetimeIterations: optimized.iterations,
    lifetimeEvaluations: optimized.evaluations,
    lifetimeRmseStart: Math.sqrt(Math.exp(optimized.startScore)),
    fixedLifetimes: fixedMask,
    irfLimited,
    irfArtifactModel: modelOptions.artifactLabel,
    lifetimes,
    amplitudes: solved.amplitudes,
    preZeroCoefficients: solved.preZeroCoefficients,
    artifactCoefficients: solved.artifactCoefficients,
    artifactAmplitudes: solved.artifactAmplitudes,
    amplitudeRanges,
    dasSpectra,
    easSpectra,
    easSemantics: "sequential EAS preview derived from DAS; no target topology was fitted",
    fittedMatrix: solved.fittedMatrix,
    residualMatrix: solved.residualMatrix,
    fitPointCount: solved.finiteCount,
    rmse: solved.finiteCount ? Math.sqrt(solved.sse / solved.weightSum) : Number.NaN,
    unweightedRmse: solved.finiteCount ? Math.sqrt(solved.unweightedSse / solved.finiteCount) : Number.NaN,
    explainedVariance: solved.sst > 0 ? 1 - solved.sse / solved.sst : Number.NaN,
    weighting: options.weighting ?? "robust-noise",
    linearSolver: "column-pivoted QR with reorthogonalization",
    designRank: solved.minimumRank,
    designParameterCount: solved.parameterCount,
    designConditionEstimate: solved.maximumConditionEstimate,
    convergence: {
      converged: optimized.converged,
      termination: optimized.termination,
      iterations: optimized.iterations,
      evaluations: optimized.evaluations,
      starts: optimized.starts,
      bestStart: optimized.bestStart,
      gradientNorm: optimized.gradientNorm,
      stepNorm: optimized.stepNorm,
      nearBestLifetimeSpread: optimized.nearBestLifetimeSpread,
      warnings: convergenceWarnings,
    },
    uncertainty,
    rangeSensitivity,
  };
}

function validateAnalysis(analysis) {
  if (!Array.isArray(analysis?.timeAxis) || !Array.isArray(analysis?.spectralAxis) || !Array.isArray(analysis?.matrix)) {
    throw new Error("Global analysis requires time, wavelength, and matrix arrays.");
  }
  if (analysis.matrix.length !== analysis.spectralAxis.length) throw new Error("Spectral axis and matrix row counts do not match.");
}

function resolveModelOptions(times, irfFwhm, options) {
  const negativeCount = times.filter((time) => time < 0).length;
  const spacing = representativeSpacing(times);
  const sigma = irfFwhm > 0 ? irfFwhm / 2.354820045 : Math.max(spacing, 0.01);
  let preZeroOrder = options.preZeroModel === "off" ? -1 : clampInteger(options.preZeroOrder, 0, 1, 1);
  if (negativeCount < 2) preZeroOrder = -1;
  else if (negativeCount < 4) preZeroOrder = 0;
  const artifactOrder = options.includeIrfArtifact === false || !(irfFwhm > 0)
    ? -1
    : clampInteger(options.coherentArtifactOrder, 0, 2, 1);
  return {
    sigma,
    preZeroOrder,
    artifactOrder,
    preZeroLabel: preZeroOrder < 0
      ? "off"
      : preZeroOrder === 0 ? "smooth negative-time envelope" : "smooth negative-time envelope with slope",
    artifactLabel: artifactOrder < 0
      ? "off"
      : artifactOrder === 0
        ? "wavelength-dependent Gaussian time-zero term"
        : artifactOrder === 1
          ? "wavelength-dependent Gaussian and first-derivative time-zero terms"
          : "wavelength-dependent Gaussian and first/second-derivative time-zero terms",
  };
}

function buildDesign(times, lifetimes, irfFwhm, modelOptions) {
  const sigma = modelOptions.sigma;
  const negativeExtent = Math.max(sigma * 4, ...times.filter((time) => time < 0).map((time) => Math.abs(time)), sigma);
  const preZeroCount = modelOptions.preZeroOrder + 1;
  const artifactCount = modelOptions.artifactOrder + 1;
  const rows = times.map((time) => {
    const row = [];
    if (preZeroCount > 0) {
      const gate = 0.5 * erfc(time / (SQRT_TWO * sigma));
      row.push(gate);
      if (modelOptions.preZeroOrder >= 1) row.push((Math.min(time, 0) / negativeExtent) * gate);
    }
    if (artifactCount > 0) {
      const z = time / sigma;
      const gaussian = Math.exp(-0.5 * z * z);
      row.push(gaussian);
      if (modelOptions.artifactOrder >= 1) row.push(z * gaussian);
      if (modelOptions.artifactOrder >= 2) row.push((z * z - 1) * gaussian);
    }
    lifetimes.forEach((lifetime) => row.push(irfConvolvedExponential(time, lifetime, irfFwhm)));
    return row;
  });
  return {
    rows,
    preZeroCount,
    artifactCount,
    componentOffset: preZeroCount + artifactCount,
    parameterCount: preZeroCount + artifactCount + lifetimes.length,
  };
}

function irfConvolvedExponential(time, lifetime, irfFwhm) {
  if (!(lifetime > 0)) return Number.NaN;
  if (!(irfFwhm > 0)) return time >= 0 ? Math.exp(-time / lifetime) : 0;
  const sigma = irfFwhm / 2.354820045;
  const argument = (sigma * sigma / lifetime - time) / (SQRT_TWO * sigma);
  const logValue = Math.log(0.5) + sigma * sigma / (2 * lifetime * lifetime) - time / lifetime + logErfc(argument);
  if (logValue < -745) return 0;
  return Math.exp(Math.min(709, logValue));
}

function createObjective(analysis, fitIndexes, fitTimes, irfFwhm, fixedMask, minimumLifetime, maximumLifetime, modelOptions, rowWeights) {
  const cache = new Map();
  return (candidate) => {
    const lifetimes = projectLifetimes(candidate, fixedMask, minimumLifetime, maximumLifetime);
    const key = lifetimes.map((value) => value.toPrecision(13)).join("|");
    if (cache.has(key)) return cache.get(key);
    const solved = solveConditional(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, modelOptions, rowWeights, false);
    const mse = solved.weightSum > 0 ? solved.sse / solved.weightSum : Infinity;
    const result = {
      lifetimes,
      score: Number.isFinite(mse) && mse > 0 ? Math.log(Math.max(mse, MIN_POSITIVE)) : Infinity,
      rmse: Number.isFinite(mse) ? Math.sqrt(mse) : Infinity,
      rank: solved.minimumRank,
      parameterCount: solved.parameterCount,
    };
    cache.set(key, result);
    return result;
  };
}

function solveConditional(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, modelOptions, rowWeights, materialize) {
  const design = buildDesign(fitTimes, lifetimes, irfFwhm, modelOptions);
  const amplitudes = [];
  const preZeroCoefficients = [];
  const artifactCoefficients = [];
  const artifactAmplitudes = [];
  const fittedMatrix = materialize ? analysis.matrix.map((row) => row.map(() => Number.NaN)) : null;
  const residualMatrix = materialize ? analysis.matrix.map((row) => row.map(() => Number.NaN)) : null;
  const factorCache = new Map();
  let sse = 0;
  let unweightedSse = 0;
  let sst = 0;
  let finiteCount = 0;
  let weightSum = 0;
  let minimumRank = design.parameterCount;
  let maximumConditionEstimate = 0;
  let weightedValueSum = 0;
  let weightedValueCount = 0;
  let solvedRowCount = 0;

  analysis.matrix.forEach((row, rowIndex) => {
    const weight = rowWeights[rowIndex] ?? 1;
    fitIndexes.forEach((sourceIndex) => {
      const value = row[sourceIndex];
      if (!Number.isFinite(value)) return;
      weightedValueSum += weight * value;
      weightedValueCount += weight;
    });
  });
  const weightedMean = weightedValueCount > 0 ? weightedValueSum / weightedValueCount : 0;

  analysis.matrix.forEach((row, rowIndex) => {
    const valid = fitIndexes
      .map((sourceIndex, fitIndex) => ({ sourceIndex, fitIndex, value: row[sourceIndex] }))
      .filter(({ value }) => Number.isFinite(value));
    const maskKey = valid.map(({ fitIndex }) => fitIndex).join(",");
    let factor = factorCache.get(maskKey);
    if (!factor && valid.length >= design.parameterCount) {
      factor = factorPivotedQr(valid.map(({ fitIndex }) => design.rows[fitIndex]));
      factorCache.set(maskKey, factor);
    }
    const parameters = factor?.rank === design.parameterCount
      ? solvePivotedQr(factor, valid.map(({ value }) => value))
      : null;
    minimumRank = Math.min(minimumRank, factor?.rank ?? 0);
    maximumConditionEstimate = Math.max(maximumConditionEstimate, factor?.conditionEstimate ?? Infinity);
    const componentValues = parameters ? parameters.slice(design.componentOffset) : Array.from({ length: lifetimes.length }, () => Number.NaN);
    amplitudes.push(componentValues);
    preZeroCoefficients.push(parameters ? parameters.slice(0, design.preZeroCount) : Array.from({ length: design.preZeroCount }, () => Number.NaN));
    const artifact = parameters
      ? parameters.slice(design.preZeroCount, design.preZeroCount + design.artifactCount)
      : Array.from({ length: design.artifactCount }, () => Number.NaN);
    artifactCoefficients.push(artifact);
    artifactAmplitudes.push(artifact[0] ?? Number.NaN);
    if (!parameters) return;
    solvedRowCount += 1;
    const rowWeight = rowWeights[rowIndex] ?? 1;
    valid.forEach(({ sourceIndex, fitIndex, value }) => {
      const fitted = dot(parameters, design.rows[fitIndex]);
      const residual = value - fitted;
      if (materialize) {
        fittedMatrix[rowIndex][sourceIndex] = fitted;
        residualMatrix[rowIndex][sourceIndex] = residual;
      }
      unweightedSse += residual * residual;
      sse += rowWeight * residual * residual;
      sst += rowWeight * (value - weightedMean) ** 2;
      finiteCount += 1;
      weightSum += rowWeight;
    });
  });

  return {
    amplitudes,
    preZeroCoefficients,
    artifactCoefficients,
    artifactAmplitudes,
    fittedMatrix,
    residualMatrix,
    sse,
    unweightedSse,
    sst,
    finiteCount,
    weightSum,
    minimumRank,
    maximumConditionEstimate,
    parameterCount: design.parameterCount,
    solvedRowCount,
  };
}

function estimateLifetimeUncertainty(
  analysis,
  fitIndexes,
  fitTimes,
  lifetimes,
  irfFwhm,
  fixedMask,
  minimumLifetime,
  maximumLifetime,
  modelOptions,
  rowWeights,
  solved,
  optimized,
) {
  const freeIndexes = lifetimes.map((_, index) => index).filter((index) => !fixedMask[index]);
  const baseEntries = lifetimes.map((lifetime, index) => ({
    componentIndex: index,
    lifetime,
    fixed: Boolean(fixedMask[index]),
    standardError: null,
    relativeStandardError: null,
    confidenceInterval95: null,
    atBound: lifetimeAtBound(lifetimes, index, minimumLifetime, maximumLifetime),
  }));
  if (!freeIndexes.length) {
    return {
      status: "fixed",
      method: "not estimated because all lifetimes are fixed",
      confidenceLevel: 0.95,
      degreesOfFreedom: Math.max(0, solved.finiteCount - solved.solvedRowCount * solved.parameterCount),
      residualVariance: null,
      jacobianRank: 0,
      freeParameterCount: 0,
      lifetimes: baseEntries,
      correlationMatrix: [],
      warnings: [],
    };
  }

  const estimatedLinearParameters = solved.solvedRowCount * solved.parameterCount;
  const degreesOfFreedom = solved.finiteCount - estimatedLinearParameters - freeIndexes.length;
  if (!(degreesOfFreedom > 0) || !(solved.weightSum > 0) || !Number.isFinite(solved.sse)) {
    return unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
      "There are not enough residual degrees of freedom for lifetime uncertainty estimation.");
  }

  const derivativeColumns = [];
  for (const componentIndex of freeIndexes) {
    const perturbation = uncertaintyPerturbation(lifetimes, componentIndex, minimumLifetime, maximumLifetime);
    if (!perturbation) {
      return unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
        `Lifetime ${componentIndex + 1} is pinned too tightly by a bound or neighboring component for covariance estimation.`);
    }
    const lowerSolved = solveConditional(
      analysis, fitIndexes, fitTimes, perturbation.lower, irfFwhm, modelOptions, rowWeights, true,
    );
    const upperSolved = solveConditional(
      analysis, fitIndexes, fitTimes, perturbation.upper, irfFwhm, modelOptions, rowWeights, true,
    );
    const lowerResiduals = weightedResidualVector(analysis, fitIndexes, lowerSolved.residualMatrix, rowWeights);
    const upperResiduals = weightedResidualVector(analysis, fitIndexes, upperSolved.residualMatrix, rowWeights);
    if (!lowerResiduals || !upperResiduals || lowerResiduals.length !== upperResiduals.length) {
      return unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
        "The profiled residual Jacobian could not be evaluated for every fitted data point.");
    }
    derivativeColumns.push(upperResiduals.map((value, residualIndex) => (
      value - lowerResiduals[residualIndex]
    ) / perturbation.logSpan));
  }

  const jacobian = Array.from({ length: derivativeColumns[0]?.length ?? 0 }, (_, rowIndex) => (
    derivativeColumns.map((column) => column[rowIndex])
  ));
  if (jacobian.length < freeIndexes.length) {
    return unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
      "The profiled residual Jacobian contains too few rows for covariance estimation.");
  }
  const factor = factorPivotedQr(jacobian);
  if (factor.rank !== freeIndexes.length) {
    return {
      ...unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
        "The lifetime Jacobian is rank deficient; standard errors are not identifiable."),
      jacobianRank: factor.rank,
      jacobianConditionEstimate: factor.conditionEstimate,
    };
  }

  const residualVariance = solved.sse / degreesOfFreedom;
  const covarianceLog = covarianceFromQr(factor, residualVariance);
  if (!covarianceLog) {
    return unavailableUncertainty(baseEntries, freeIndexes.length, degreesOfFreedom,
      "The lifetime covariance matrix could not be constructed from the profiled Jacobian.");
  }
  const correlationMatrix = covarianceToCorrelation(covarianceLog);
  const z95 = 1.959963984540054;
  const entries = baseEntries.map((entry) => ({ ...entry }));
  freeIndexes.forEach((componentIndex, freeIndex) => {
    const varianceLog = covarianceLog[freeIndex][freeIndex];
    const standardErrorLog = varianceLog >= 0 ? Math.sqrt(varianceLog) : Number.NaN;
    const lifetime = lifetimes[componentIndex];
    const standardError = Number.isFinite(standardErrorLog) ? lifetime * standardErrorLog : null;
    entries[componentIndex] = {
      ...entries[componentIndex],
      standardError,
      relativeStandardError: Number.isFinite(standardErrorLog) ? standardErrorLog : null,
      confidenceInterval95: Number.isFinite(standardErrorLog)
        ? [
          Math.max(minimumLifetime, lifetime * Math.exp(-z95 * standardErrorLog)),
          Math.min(maximumLifetime, lifetime * Math.exp(z95 * standardErrorLog)),
        ]
        : null,
    };
  });
  const warnings = [];
  if (!optimized.converged) warnings.push("Uncertainty is conditional on a fit that did not converge.");
  entries.forEach((entry) => {
    if (entry.fixed) return;
    if (entry.atBound) warnings.push(`Lifetime ${entry.componentIndex + 1} is close to a numerical or separation bound; its interval may be truncated.`);
    if (Number.isFinite(entry.relativeStandardError) && entry.relativeStandardError > 0.5) {
      warnings.push(`Lifetime ${entry.componentIndex + 1} has a relative standard error above 50%, indicating weak identifiability.`);
    }
  });
  for (let row = 0; row < correlationMatrix.length; row += 1) {
    for (let column = row + 1; column < correlationMatrix.length; column += 1) {
      if (Math.abs(correlationMatrix[row][column]) > 0.95) {
        warnings.push("At least two free lifetimes have absolute correlation above 0.95; individual intervals may be unreliable.");
        row = correlationMatrix.length;
        break;
      }
    }
  }
  return {
    status: warnings.length ? "available-with-warnings" : "available",
    method: "profiled-residual Jacobian covariance in log-lifetime space",
    confidenceLevel: 0.95,
    standardErrorScale: "weighted residual variance divided by residual degrees of freedom",
    degreesOfFreedom,
    residualVariance,
    estimatedLinearParameterCount: estimatedLinearParameters,
    jacobianRank: factor.rank,
    jacobianConditionEstimate: factor.conditionEstimate,
    freeParameterCount: freeIndexes.length,
    freeComponentIndices: freeIndexes,
    covarianceLogLifetime: covarianceLog,
    correlationMatrix,
    lifetimes: entries,
    warnings,
  };
}

function unavailableUncertainty(entries, freeParameterCount, degreesOfFreedom, warning) {
  return {
    status: "unavailable",
    method: "profiled-residual Jacobian covariance in log-lifetime space",
    confidenceLevel: 0.95,
    degreesOfFreedom,
    residualVariance: null,
    jacobianRank: 0,
    freeParameterCount,
    lifetimes: entries,
    correlationMatrix: [],
    warnings: [warning],
  };
}

function uncertaintyPerturbation(lifetimes, componentIndex, minimumLifetime, maximumLifetime) {
  const separationRatio = 1.015;
  const lifetime = lifetimes[componentIndex];
  const lowerBound = componentIndex > 0
    ? Math.max(minimumLifetime, lifetimes[componentIndex - 1] * separationRatio)
    : minimumLifetime;
  const upperBound = componentIndex < lifetimes.length - 1
    ? Math.min(maximumLifetime, lifetimes[componentIndex + 1] / separationRatio)
    : maximumLifetime;
  const logStep = 0.0025;
  const lowerValue = Math.max(lowerBound, lifetime * Math.exp(-logStep));
  const upperValue = Math.min(upperBound, lifetime * Math.exp(logStep));
  const logSpan = Math.log(upperValue) - Math.log(lowerValue);
  if (!(logSpan > 1e-7)) return null;
  const lower = lifetimes.slice();
  const upper = lifetimes.slice();
  lower[componentIndex] = lowerValue;
  upper[componentIndex] = upperValue;
  return { lower, upper, logSpan };
}

function weightedResidualVector(analysis, fitIndexes, residualMatrix, rowWeights) {
  const result = [];
  for (let rowIndex = 0; rowIndex < analysis.matrix.length; rowIndex += 1) {
    const weightScale = Math.sqrt(rowWeights[rowIndex] ?? 1);
    for (const sourceIndex of fitIndexes) {
      if (!Number.isFinite(analysis.matrix[rowIndex][sourceIndex])) continue;
      const residual = residualMatrix?.[rowIndex]?.[sourceIndex];
      if (!Number.isFinite(residual)) return null;
      result.push(weightScale * residual);
    }
  }
  return result;
}

function covarianceFromQr(factor, scale) {
  if (factor.rank !== factor.columnCount || !(scale >= 0)) return null;
  const size = factor.columnCount;
  const inverseR = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  for (let basis = 0; basis < size; basis += 1) {
    const solution = Array.from({ length: size }, () => 0);
    for (let row = size - 1; row >= 0; row -= 1) {
      let value = row === basis ? 1 : 0;
      for (let column = row + 1; column < size; column += 1) value -= factor.r[row][column] * solution[column];
      const diagonal = factor.r[row][row];
      if (!(Math.abs(diagonal) > 1e-15)) return null;
      solution[row] = value / diagonal;
    }
    for (let row = 0; row < size; row += 1) inverseR[row][basis] = solution[row];
  }
  const pivoted = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (
    scale * dot(inverseR[row], inverseR[column])
  )));
  const covariance = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  factor.pivots.forEach((originalRow, pivotedRow) => {
    factor.pivots.forEach((originalColumn, pivotedColumn) => {
      covariance[originalRow][originalColumn] = pivoted[pivotedRow][pivotedColumn];
    });
  });
  return covariance;
}

function covarianceToCorrelation(covariance) {
  return covariance.map((row, rowIndex) => row.map((value, columnIndex) => {
    const denominator = Math.sqrt(Math.max(0, covariance[rowIndex][rowIndex] * covariance[columnIndex][columnIndex]));
    return denominator > 0 ? value / denominator : rowIndex === columnIndex ? 1 : 0;
  }));
}

function lifetimeAtBound(lifetimes, componentIndex, minimumLifetime, maximumLifetime) {
  const lifetime = lifetimes[componentIndex];
  const lower = componentIndex > 0 ? lifetimes[componentIndex - 1] * 1.015 : minimumLifetime;
  const upper = componentIndex < lifetimes.length - 1 ? lifetimes[componentIndex + 1] / 1.015 : maximumLifetime;
  return Math.log(lifetime / lower) < 0.01 || Math.log(upper / lifetime) < 0.01;
}

function factorPivotedQr(matrix) {
  const rowCount = matrix.length;
  const columnCount = matrix[0]?.length ?? 0;
  const columns = Array.from({ length: columnCount }, (_, column) => matrix.map((row) => row[column]));
  const pivots = Array.from({ length: columnCount }, (_, index) => index);
  const q = [];
  const r = Array.from({ length: columnCount }, () => Array.from({ length: columnCount }, () => 0));
  const originalScale = Math.max(1, ...columns.map(vectorNorm));
  let rank = 0;
  for (let step = 0; step < columnCount; step += 1) {
    let pivot = step;
    let largestNorm = -1;
    for (let candidate = step; candidate < columnCount; candidate += 1) {
      const norm = vectorNorm(columns[candidate]);
      if (norm > largestNorm) {
        largestNorm = norm;
        pivot = candidate;
      }
    }
    if (pivot !== step) {
      [columns[step], columns[pivot]] = [columns[pivot], columns[step]];
      [pivots[step], pivots[pivot]] = [pivots[pivot], pivots[step]];
      for (let previous = 0; previous < step; previous += 1) {
        [r[previous][step], r[previous][pivot]] = [r[previous][pivot], r[previous][step]];
      }
    }
    let vector = columns[step].slice();
    for (let previous = 0; previous < step; previous += 1) {
      const projection = dot(q[previous], vector);
      r[previous][step] += projection;
      vector = vector.map((value, index) => value - projection * q[previous][index]);
    }
    for (let previous = 0; previous < step; previous += 1) {
      const correction = dot(q[previous], vector);
      r[previous][step] += correction;
      vector = vector.map((value, index) => value - correction * q[previous][index]);
    }
    const diagonal = vectorNorm(vector);
    if (!(diagonal > originalScale * Math.max(rowCount, columnCount) * 1e-12)) break;
    r[step][step] = diagonal;
    q.push(vector.map((value) => value / diagonal));
    rank += 1;
    for (let column = step + 1; column < columnCount; column += 1) {
      const projection = dot(q[step], columns[column]);
      r[step][column] = projection;
      columns[column] = columns[column].map((value, index) => value - projection * q[step][index]);
    }
  }
  const diagonals = Array.from({ length: rank }, (_, index) => Math.abs(r[index][index])).filter((value) => value > 0);
  return {
    q,
    r,
    pivots,
    rank,
    columnCount,
    conditionEstimate: diagonals.length ? Math.max(...diagonals) / Math.min(...diagonals) : Infinity,
  };
}

function solvePivotedQr(factor, values) {
  if (factor.rank !== factor.columnCount) return null;
  const projected = factor.q.map((column) => dot(column, values));
  const pivoted = Array.from({ length: factor.columnCount }, () => 0);
  for (let row = factor.columnCount - 1; row >= 0; row -= 1) {
    let value = projected[row];
    for (let column = row + 1; column < factor.columnCount; column += 1) value -= factor.r[row][column] * pivoted[column];
    const diagonal = factor.r[row][row];
    if (!(Math.abs(diagonal) > 1e-15)) return null;
    pivoted[row] = value / diagonal;
  }
  const result = Array.from({ length: factor.columnCount }, () => 0);
  factor.pivots.forEach((originalIndex, pivotIndex) => {
    result[originalIndex] = pivoted[pivotIndex];
  });
  return result;
}

function optimizeMultiStart(objective, initialLifetimes, fixedMask, config) {
  const freeIndexes = initialLifetimes.map((_, index) => index).filter((index) => !fixedMask[index]);
  const initialEvaluation = objective(initialLifetimes);
  if (!freeIndexes.length) {
    return {
      lifetimes: initialEvaluation.lifetimes,
      converged: true,
      termination: "all lifetimes fixed",
      iterations: 0,
      evaluations: 1,
      starts: [{ lifetimes: initialEvaluation.lifetimes, score: initialEvaluation.score, converged: true }],
      bestStart: 0,
      startScore: initialEvaluation.score,
      gradientNorm: 0,
      stepNorm: 0,
      nearBestLifetimeSpread: 0,
    };
  }
  const starts = buildOptimizerStarts(initialLifetimes, fixedMask, config);
  const results = starts.map((start) => optimizeOneStart(objective, start, fixedMask, freeIndexes, config));
  let bestStart = 0;
  for (let index = 1; index < results.length; index += 1) {
    if (results[index].score < results[bestStart].score) bestStart = index;
  }
  const best = results[bestStart];
  const nearBest = results.filter((result) => result.score - best.score <= Math.log(1.001));
  const nearBestLifetimeSpread = maximumLifetimeSpread(nearBest.map((result) => result.lifetimes));
  return {
    lifetimes: best.lifetimes,
    converged: best.converged,
    termination: best.termination,
    iterations: results.reduce((sum, result) => sum + result.iterations, 0),
    evaluations: results.reduce((sum, result) => sum + result.evaluations, 0),
    starts: results.map((result) => ({
      lifetimes: result.lifetimes,
      rmse: Math.sqrt(Math.exp(result.score)),
      converged: result.converged,
      termination: result.termination,
    })),
    bestStart,
    startScore: initialEvaluation.score,
    gradientNorm: best.gradientNorm,
    stepNorm: best.stepNorm,
    nearBestLifetimeSpread,
  };
}

function optimizeOneStart(objective, initialLifetimes, fixedMask, freeIndexes, config) {
  let lifetimes = initialLifetimes.slice();
  let current = objective(lifetimes);
  const dimension = freeIndexes.length;
  let inverseHessian = identityMatrix(dimension);
  let trustRadius = 0.6;
  let gradientResult = finiteDifferenceGradient(objective, current.lifetimes, freeIndexes);
  let gradient = gradientResult.gradient;
  let evaluations = gradientResult.evaluations + 1;
  let iterations = 0;
  let stepNorm = Infinity;
  let stableIterations = 0;
  let termination = "maximum iterations reached";
  let converged = false;

  while (iterations < config.maximumIterations) {
    const gradientNorm = vectorNorm(gradient);
    if (gradientNorm < 2e-4) {
      converged = true;
      termination = "projected gradient tolerance reached";
      break;
    }
    let direction = scaleVector(matrixVector(inverseHessian, gradient), -1);
    if (!(dot(direction, gradient) < 0) || direction.some((value) => !Number.isFinite(value))) {
      direction = scaleVector(gradient, -1);
      inverseHessian = identityMatrix(dimension);
    }
    const directionNorm = vectorNorm(direction);
    if (directionNorm > trustRadius) direction = scaleVector(direction, trustRadius / directionNorm);
    const baseLogs = freeIndexes.map((index) => Math.log(current.lifetimes[index]));
    let accepted = null;
    let acceptedStep = null;
    let scale = 1;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const trial = current.lifetimes.slice();
      freeIndexes.forEach((index, freeIndex) => {
        trial[index] = Math.exp(baseLogs[freeIndex] + direction[freeIndex] * scale);
      });
      const evaluated = objective(trial);
      evaluations += 1;
      const actualStep = freeIndexes.map((index) => Math.log(evaluated.lifetimes[index]) - baseLogs[freeIndexes.indexOf(index)]);
      if (evaluated.score <= current.score + 1e-4 * dot(gradient, actualStep)) {
        accepted = evaluated;
        acceptedStep = actualStep;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) {
      trustRadius *= 0.35;
      inverseHessian = identityMatrix(dimension);
      iterations += 1;
      if (trustRadius < 8e-4) {
        termination = "trust region collapsed without an improving step";
        break;
      }
      continue;
    }
    const previousScore = current.score;
    const previousGradient = gradient;
    current = accepted;
    lifetimes = current.lifetimes;
    stepNorm = vectorNorm(acceptedStep);
    gradientResult = finiteDifferenceGradient(objective, lifetimes, freeIndexes);
    gradient = gradientResult.gradient;
    evaluations += gradientResult.evaluations;
    const gradientChange = gradient.map((value, index) => value - previousGradient[index]);
    const curvature = dot(acceptedStep, gradientChange);
    if (curvature > 1e-10) inverseHessian = bfgsInverseUpdate(inverseHessian, acceptedStep, gradientChange, curvature);
    else inverseHessian = identityMatrix(dimension);
    const relativeImprovement = Math.abs(previousScore - current.score) / Math.max(1, Math.abs(previousScore));
    stableIterations = relativeImprovement < 1e-8 || stepNorm < 2e-4 ? stableIterations + 1 : 0;
    if (stableIterations >= 3) {
      converged = true;
      termination = "objective and step tolerances reached";
      break;
    }
    trustRadius = Math.min(1.0, trustRadius * 1.25);
    iterations += 1;
  }
  return {
    lifetimes,
    score: current.score,
    converged,
    termination,
    iterations,
    evaluations,
    gradientNorm: vectorNorm(gradient),
    stepNorm,
  };
}

function finiteDifferenceGradient(objective, lifetimes, freeIndexes) {
  const gradient = [];
  let evaluations = 0;
  const step = 0.0025;
  freeIndexes.forEach((index) => {
    const plus = lifetimes.slice();
    const minus = lifetimes.slice();
    plus[index] *= Math.exp(step);
    minus[index] *= Math.exp(-step);
    const positive = objective(plus);
    const negative = objective(minus);
    evaluations += 2;
    const denominator = Math.log(positive.lifetimes[index]) - Math.log(negative.lifetimes[index]);
    gradient.push(Math.abs(denominator) > 1e-12 ? (positive.score - negative.score) / denominator : 0);
  });
  return { gradient, evaluations };
}

function assessRangeSensitivity(analysis, fitIndexes, fitTimes, lifetimes, irfFwhm, fixedMask, modelOptions, rowWeights, config) {
  const positivePositions = fitTimes.map((time, position) => ({ time, position })).filter(({ time }) => time >= 0);
  if (positivePositions.length < Math.max(16, lifetimes.length * 4)) {
    return { status: "insufficient-points", maximumRelativeShift: Number.NaN, variants: [] };
  }
  const earlyDrop = Math.max(1, Math.floor(positivePositions.length * 0.05));
  const lateDrop = Math.max(1, Math.floor(positivePositions.length * 0.1));
  const variants = [
    { name: "later-start", omitted: new Set(positivePositions.slice(0, earlyDrop).map(({ position }) => position)) },
    { name: "earlier-end", omitted: new Set(positivePositions.slice(-lateDrop).map(({ position }) => position)) },
  ].map(({ name, omitted }) => {
    const positions = fitTimes.map((_, position) => position).filter((position) => !omitted.has(position));
    const variantIndexes = positions.map((position) => fitIndexes[position]);
    const variantTimes = positions.map((position) => fitTimes[position]);
    if (variantTimes.length < lifetimes.length + 5) return { name, status: "insufficient-points", lifetimes: [] };
    const objective = createObjective(analysis, variantIndexes, variantTimes, irfFwhm, fixedMask, config.minimumLifetime, config.maximumLifetime, modelOptions, rowWeights);
    const optimized = optimizeMultiStart(objective, lifetimes, fixedMask, {
      ...config,
      startCount: 1,
    });
    return {
      name,
      status: optimized.converged ? "converged" : "not-converged",
      lifetimes: optimized.lifetimes,
      maximumRelativeShift: maximumPairwiseRelativeShift(lifetimes, optimized.lifetimes),
    };
  });
  const maximumRelativeShift = Math.max(0, ...variants.map((variant) => variant.maximumRelativeShift).filter(Number.isFinite));
  const allConverged = variants.every((variant) => variant.status === "converged");
  return {
    status: !allConverged
      ? "indeterminate"
      : maximumRelativeShift <= 0.1 ? "stable" : maximumRelativeShift <= 0.25 ? "sensitive" : "unstable",
    maximumRelativeShift,
    variants,
    method: "refit after omitting 5% of earliest nonnegative points and 10% of latest points",
  };
}

function buildConvergenceWarnings(optimized, solved, rangeSensitivity, uncertainty) {
  const warnings = [];
  if (!optimized.converged) warnings.push(`Optimizer did not converge: ${optimized.termination}.`);
  if (solved.minimumRank < solved.parameterCount) warnings.push("The conditional spectral design is rank deficient for at least one wavelength.");
  if (solved.maximumConditionEstimate > 1e8) warnings.push("The conditional spectral design is ill-conditioned; component spectra may be unstable.");
  if (optimized.nearBestLifetimeSpread > 0.2) warnings.push("Near-equivalent starts produced materially different lifetimes, indicating weak identifiability.");
  if (rangeSensitivity.status === "sensitive") warnings.push("Lifetimes changed by more than 10% in the range-sensitivity refits.");
  if (rangeSensitivity.status === "unstable") warnings.push("Lifetimes changed by more than 25% in the range-sensitivity refits; do not interpret this fit as range robust.");
  if (rangeSensitivity.status === "indeterminate") warnings.push("At least one range-sensitivity refit did not converge; range robustness is indeterminate.");
  return [...new Set([...warnings, ...(uncertainty?.warnings ?? [])])];
}

function buildSpectralWeights(analysis, fitIndexes, fitTimes, modelOptions, mode) {
  if (mode === "uniform") return analysis.matrix.map(() => 1);
  const excludedWidth = modelOptions.sigma * 3;
  const noises = analysis.matrix.map((row) => {
    const differences = [];
    for (let index = 1; index < fitIndexes.length - 1; index += 1) {
      if (Math.abs(fitTimes[index]) < excludedWidth) continue;
      const left = Number(row[fitIndexes[index - 1]]);
      const center = Number(row[fitIndexes[index]]);
      const right = Number(row[fitIndexes[index + 1]]);
      if (Number.isFinite(left) && Number.isFinite(center) && Number.isFinite(right)) differences.push(left - 2 * center + right);
    }
    const noise = mad(differences) / Math.sqrt(6);
    return noise > 0 ? noise : Number.NaN;
  });
  const reference = median(noises.filter(Number.isFinite));
  if (!(reference > 0)) return analysis.matrix.map(() => 1);
  return noises.map((noise) => Number.isFinite(noise) && noise > 0
    ? clamp((reference / noise) ** 2, 0.25, 4)
    : 1);
}

function buildOptimizerStarts(initial, fixedMask, config) {
  const starts = [projectLifetimes(initial, fixedMask, config.minimumLifetime, config.maximumLifetime)];
  for (let startIndex = 1; startIndex < config.startCount; startIndex += 1) {
    const shifted = initial.map((value, index) => {
      if (fixedMask[index]) return value;
      const direction = (index + startIndex) % 2 === 0 ? -1 : 1;
      const magnitude = 0.22 + 0.12 * startIndex;
      return value * Math.exp(direction * magnitude);
    });
    starts.push(projectLifetimes(shifted, fixedMask, config.minimumLifetime, config.maximumLifetime));
  }
  return starts;
}

function normalizeFixedMask(requested, fixedLifetimes, count) {
  const explicit = Array.isArray(fixedLifetimes);
  return Array.from({ length: count }, (_, index) => {
    const hasValue = Number.isFinite(requested[index]) && requested[index] > 0;
    return hasValue && (explicit ? Boolean(fixedLifetimes[index]) : true);
  });
}

function normalizeLifetimes(times, count, requested, minimum, maximum, fixedMask) {
  const positive = times.filter((time) => time > 0).sort((left, right) => left - right);
  const start = Math.max(minimum, positive[0] ?? minimum);
  const end = Math.min(maximum, Math.max(positive.at(-1) ?? start * 10, start * 10));
  const defaults = count === 1
    ? [Math.sqrt(start * end)]
    : Array.from({ length: count }, (_, index) => start * (end / start) ** (index / (count - 1)));
  const lifetimes = Array.from({ length: count }, (_, index) => Number.isFinite(requested[index]) && requested[index] > 0
    ? requested[index]
    : defaults[index]);
  return projectLifetimes(lifetimes, fixedMask, minimum, maximum);
}

function projectLifetimes(candidate, fixedMask, minimum, maximum) {
  const ratio = 1.015;
  const projected = candidate.map((value) => clamp(Number(value) || minimum, minimum, maximum));
  for (let pass = 0; pass < projected.length + 2; pass += 1) {
    for (let index = 1; index < projected.length; index += 1) {
      const required = projected[index - 1] * ratio;
      if (projected[index] >= required) continue;
      if (!fixedMask[index]) projected[index] = Math.min(maximum, required);
      else if (!fixedMask[index - 1]) projected[index - 1] = Math.max(minimum, projected[index] / ratio);
    }
    for (let index = projected.length - 2; index >= 0; index -= 1) {
      const allowed = projected[index + 1] / ratio;
      if (projected[index] <= allowed) continue;
      if (!fixedMask[index]) projected[index] = Math.max(minimum, allowed);
      else if (!fixedMask[index + 1]) projected[index + 1] = Math.min(maximum, projected[index] * ratio);
    }
  }
  for (let index = 1; index < projected.length; index += 1) {
    if (!(projected[index] >= projected[index - 1] * ratio * (1 - 1e-10))) {
      throw new Error("Fixed lifetimes must be positive, ordered, and sufficiently separated.");
    }
  }
  return projected;
}

function estimateLifetimeLowerBound(times) {
  const positive = times.filter((time) => Number.isFinite(time) && time > 0).sort((left, right) => left - right);
  const spacings = positive.slice(1).map((time, index) => time - positive[index]).filter((value) => value > 0);
  const candidates = [positive[0] * 0.25, median(spacings) * 0.25].filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1e-4, candidates.length ? Math.min(...candidates) : 0.003);
}

function estimateLifetimeUpperBound(times, minimum) {
  const positive = times.filter((time) => Number.isFinite(time) && time > 0);
  return Math.max(minimum * 100, (positive.at(-1) ?? minimum * 100) * 100);
}

function representativeSpacing(times) {
  const sorted = times.filter(Number.isFinite).slice().sort((left, right) => left - right);
  return Math.max(1e-4, median(sorted.slice(1).map((time, index) => time - sorted[index]).filter((value) => value > 0)) || 0.01);
}

function buildDasSpectra(spectralAxis, lifetimes, amplitudes) {
  return lifetimes.map((lifetime, componentIndex) => ({
    label: `DAS ${componentIndex + 1}`,
    lifetime,
    componentIndex,
    x: spectralAxis.slice(),
    y: amplitudes.map((row) => row[componentIndex]),
  }));
}

function buildSequentialEasPreview(spectralAxis, lifetimes, amplitudes) {
  const coefficients = sequentialConcentrationCoefficients(lifetimes);
  if (!coefficients) return [];
  const valuesByWavelength = amplitudes.map((values) => solveUpperTriangular(coefficients, values));
  return lifetimes.map((lifetime, componentIndex) => ({
    label: `EAS preview ${componentIndex + 1}`,
    lifetime,
    componentIndex,
    x: spectralAxis.slice(),
    y: valuesByWavelength.map((values) => values[componentIndex]),
  }));
}

function sequentialConcentrationCoefficients(lifetimes) {
  const rates = lifetimes.map((lifetime) => 1 / lifetime);
  const coefficients = lifetimes.map(() => Array.from({ length: lifetimes.length }, () => 0));
  for (let species = 0; species < lifetimes.length; species += 1) {
    let numerator = 1;
    for (let index = 0; index < species; index += 1) numerator *= rates[index];
    for (let exponent = 0; exponent <= species; exponent += 1) {
      let denominator = 1;
      for (let index = 0; index <= species; index += 1) if (index !== exponent) denominator *= rates[index] - rates[exponent];
      if (Math.abs(denominator) < 1e-14) return null;
      coefficients[species][exponent] = numerator / denominator;
    }
  }
  return coefficients;
}

function solveUpperTriangular(coefficients, values) {
  const result = Array.from({ length: values.length }, () => Number.NaN);
  for (let row = values.length - 1; row >= 0; row -= 1) {
    let remainder = values[row];
    for (let column = row + 1; column < values.length; column += 1) remainder -= coefficients[column][row] * result[column];
    const diagonal = coefficients[row][row];
    result[row] = Math.abs(diagonal) > 1e-14 ? remainder / diagonal : Number.NaN;
  }
  return result;
}

function bfgsInverseUpdate(matrix, step, gradientChange, curvature) {
  const rho = 1 / curvature;
  const dimension = step.length;
  const left = identityMatrix(dimension);
  const right = identityMatrix(dimension);
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) {
      left[row][column] -= rho * step[row] * gradientChange[column];
      right[row][column] -= rho * gradientChange[row] * step[column];
    }
  }
  const updated = multiplyMatrices(multiplyMatrices(left, matrix), right);
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) updated[row][column] += rho * step[row] * step[column];
  }
  return updated;
}

function maximumLifetimeSpread(collection) {
  if (collection.length < 2) return 0;
  let maximum = 0;
  for (let index = 0; index < collection[0].length; index += 1) {
    const values = collection.map((lifetimes) => lifetimes[index]);
    maximum = Math.max(maximum, (Math.max(...values) - Math.min(...values)) / Math.max(MIN_POSITIVE, median(values)));
  }
  return maximum;
}

function maximumPairwiseRelativeShift(reference, candidate) {
  return Math.max(0, ...reference.map((value, index) => Math.abs(candidate[index] - value) / Math.max(MIN_POSITIVE, value)));
}

function identityMatrix(size) {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
}

function matrixVector(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function multiplyMatrices(left, right) {
  return left.map((row) => right[0].map((_, column) => row.reduce((sum, value, index) => sum + value * right[index][column], 0)));
}

function scaleVector(vector, scale) {
  return vector.map((value) => value * scale);
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function mad(values) {
  if (!values.length) return Number.NaN;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

function median(values) {
  if (!values.length) return Number.NaN;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function erfc(value) {
  if (value < 0) return 2 - erfc(-value);
  const t = 1 / (1 + 0.5 * value);
  let polynomial = 0.17087277;
  polynomial = -0.82215223 + t * polynomial;
  polynomial = 1.48851587 + t * polynomial;
  polynomial = -1.13520398 + t * polynomial;
  polynomial = 0.27886807 + t * polynomial;
  polynomial = -0.18628806 + t * polynomial;
  polynomial = 0.09678418 + t * polynomial;
  polynomial = 0.37409196 + t * polynomial;
  polynomial = 1.00002368 + t * polynomial;
  return t * Math.exp(-value * value - 1.26551223 + t * polynomial);
}

function logErfc(value) {
  if (value < 8) return Math.log(Math.max(MIN_POSITIVE, erfc(value)));
  const inverseSquare = 1 / (value * value);
  const series = Math.max(0.5, 1 - 0.5 * inverseSquare + 0.75 * inverseSquare * inverseSquare);
  return -value * value - Math.log(value) - 0.5 * Math.log(Math.PI) + Math.log(series);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(clamp(numeric, minimum, maximum)) : fallback;
}
