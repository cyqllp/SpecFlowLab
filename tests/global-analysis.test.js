import assert from "node:assert/strict";
import test from "node:test";

import "../src/lib/parser-core.js";

const Parser = globalThis.SpecFlowLabParser;

test("variable-projection global analysis recovers lifetimes with structured pre-zero and time-zero signal", () => {
  const truth = [1.8, 38];
  const irfFwhm = 0.24;
  const analysis = syntheticAnalysis({ lifetimes: truth, irfFwhm, noise: 1.2e-5 });
  const fit = Parser.fitGlobalExponentials(analysis, 2, {
    irfFwhm,
    lifetimes: [0.75, 85],
    fixedLifetimes: [false, false],
    optimizerStarts: 3,
    maximumIterations: 55,
  });

  assert.equal(fit.model, "separable-global-exponential-v2");
  assert.match(fit.linearSolver, /pivoted QR/i);
  assert.match(fit.preZeroModel, /smooth negative-time envelope/i);
  assert.match(fit.irfArtifactModel, /first-derivative/i);
  assert.equal(fit.convergence.converged, true, fit.convergence.termination);
  assert.ok(relativeError(fit.lifetimes[0], truth[0]) < 0.08, `${fit.lifetimes[0]} vs ${truth[0]}`);
  assert.ok(relativeError(fit.lifetimes[1], truth[1]) < 0.08, `${fit.lifetimes[1]} vs ${truth[1]}`);
  assert.equal(fit.designRank, fit.designParameterCount);
  assert.ok(fit.explainedVariance > 0.995, `explained=${fit.explainedVariance}`);
  assert.equal(fit.preZeroCoefficients.length, analysis.spectralAxis.length);
  assert.equal(fit.artifactCoefficients.length, analysis.spectralAxis.length);
  assert.ok(Math.abs(fit.fittedMatrix[0][0] - fit.fittedMatrix[0][9]) > 1e-5,
    "pre-zero fit should retain structure rather than impose a constant value");
  assert.equal(fit.rangeSensitivity.variants.length, 2);
  assert.equal(fit.rangeSensitivity.variants.every((variant) => variant.status === "converged"), true);
  assert.match(fit.uncertainty.status, /^available/);
  assert.equal(fit.uncertainty.jacobianRank, 2);
  assert.ok(fit.uncertainty.degreesOfFreedom > 0);
  fit.uncertainty.lifetimes.forEach((estimate, index) => {
    assert.ok(Number.isFinite(estimate.standardError) && estimate.standardError > 0);
    assert.ok(estimate.confidenceInterval95[0] <= fit.lifetimes[index]);
    assert.ok(estimate.confidenceInterval95[1] >= fit.lifetimes[index]);
  });
  fit.uncertainty.correlationMatrix.forEach((row, rowIndex) => {
    assert.ok(Math.abs(row[rowIndex] - 1) < 1e-10);
    row.forEach((value) => assert.ok(Math.abs(value) <= 1 + 1e-10));
  });
  assert.equal(fit.easSemantics.includes("preview"), true);
});

test("global analysis is reasonably stable to modest time-range changes", () => {
  const truth = [2.4, 64];
  const irfFwhm = 0.2;
  const full = syntheticAnalysis({ lifetimes: truth, irfFwhm, noise: 8e-6 });
  const cropped = cropTime(full, -0.7, 310);
  const options = {
    irfFwhm,
    lifetimes: [1.1, 115],
    fixedLifetimes: [false, false],
    optimizerStarts: 3,
    maximumIterations: 55,
    rangeSensitivity: false,
  };
  const fullFit = Parser.fitGlobalExponentials(full, 2, options);
  const croppedFit = Parser.fitGlobalExponentials(cropped, 2, options);

  assert.equal(fullFit.convergence.converged, true, fullFit.convergence.termination);
  assert.equal(croppedFit.convergence.converged, true, croppedFit.convergence.termination);
  fullFit.lifetimes.forEach((lifetime, index) => {
    assert.ok(relativeError(lifetime, croppedFit.lifetimes[index]) < 0.12,
      `component ${index + 1}: full=${lifetime}, cropped=${croppedFit.lifetimes[index]}`);
  });
});

test("fixed lifetimes remain exact and missing matrix values remain missing", () => {
  const analysis = syntheticAnalysis({ lifetimes: [1.5, 25], irfFwhm: 0.18, noise: 0 });
  analysis.matrix[2][8] = Number.NaN;
  analysis.matrix[5][11] = null;
  const fit = Parser.fitGlobalExponentials(analysis, 2, {
    irfFwhm: 0.18,
    lifetimes: [1.5, 25],
    fixedLifetimes: [true, true],
  });

  assert.deepEqual(fit.lifetimes, [1.5, 25]);
  assert.equal(fit.convergence.termination, "all lifetimes fixed");
  assert.equal(fit.uncertainty.status, "fixed");
  assert.equal(fit.uncertainty.lifetimes.every((estimate) => estimate.standardError === null), true);
  assert.equal(Number.isNaN(fit.fittedMatrix[2][8]), true);
  assert.equal(Number.isNaN(fit.fittedMatrix[5][11]), true);
  assert.equal(Number.isNaN(fit.residualMatrix[5][11]), true);
});

test("lifetime standard errors increase when otherwise identical data become noisier", () => {
  const truth = [3.2, 72];
  const quiet = decayOnlyAnalysis({ lifetimes: truth, noise: 1e-5 });
  const noisy = decayOnlyAnalysis({ lifetimes: truth, noise: 7e-5 });
  const options = {
    irfFwhm: 0,
    lifetimes: [1.4, 130],
    fixedLifetimes: [false, false],
    preZeroModel: "off",
    includeIrfArtifact: false,
    weighting: "uniform",
    rangeSensitivity: false,
    optimizerStarts: 3,
    maximumIterations: 70,
  };
  const quietFit = Parser.fitGlobalExponentials(quiet, 2, options);
  const noisyFit = Parser.fitGlobalExponentials(noisy, 2, options);
  const quietErrors = quietFit.uncertainty.lifetimes.map((estimate) => estimate.standardError);
  const noisyErrors = noisyFit.uncertainty.lifetimes.map((estimate) => estimate.standardError);

  assert.match(quietFit.uncertainty.status, /^available/);
  assert.match(noisyFit.uncertainty.status, /^available/);
  quietErrors.forEach((standardError, index) => {
    assert.ok(noisyErrors[index] > standardError * 3,
      `component ${index + 1}: quiet=${standardError}, noisy=${noisyErrors[index]}`);
  });
});

function syntheticAnalysis({ lifetimes, irfFwhm, noise }) {
  const negative = [-1.2, -0.9, -0.68, -0.5, -0.36, -0.25, -0.17, -0.11, -0.07, -0.04, -0.02, 0];
  const positive = Array.from({ length: 72 }, (_, index) => 0.012 * (450 / 0.012) ** (index / 71));
  const timeAxis = [...negative, ...positive];
  const spectralAxis = Array.from({ length: 18 }, (_, index) => 480 + index * 13);
  const sigma = irfFwhm / 2.354820045;
  const matrix = spectralAxis.map((wavelength, rowIndex) => timeAxis.map((time, timeIndex) => {
    const firstAmplitude = 0.0045 * Math.sin((wavelength - 455) / 53) + 0.002;
    const secondAmplitude = -0.0038 * Math.cos((wavelength - 510) / 71) + 0.001;
    const gate = 1 / (1 + Math.exp(time / Math.max(0.015, sigma * 0.75)));
    const preZero = (0.00025 + rowIndex * 8e-6) * gate
      + (0.00012 * Math.sin(rowIndex / 3)) * Math.min(time, 0) * gate;
    const z = time / sigma;
    const gaussian = Math.exp(-0.5 * z * z);
    const coherent = (0.0007 * Math.cos(rowIndex / 4)) * gaussian
      + (0.00045 * Math.sin(rowIndex / 5)) * z * gaussian;
    const kinetics = firstAmplitude * numericConvolution(time, lifetimes[0], sigma)
      + secondAmplitude * numericConvolution(time, lifetimes[1], sigma);
    const deterministicNoise = noise * Math.sin((rowIndex + 1) * 0.731 + (timeIndex + 2) * 1.113);
    return preZero + coherent + kinetics + deterministicNoise;
  }));
  return {
    timeAxis,
    spectralAxis,
    matrix,
    rowRange: { start: 0, end: spectralAxis.length - 1 },
    colRange: { start: 0, end: timeAxis.length - 1 },
    selectedRange: {
      spectral: { min: spectralAxis[0], max: spectralAxis.at(-1) },
      time: { min: timeAxis[0], max: timeAxis.at(-1) },
    },
  };
}

function decayOnlyAnalysis({ lifetimes, noise }) {
  const timeAxis = [0, ...Array.from({ length: 79 }, (_, index) => 0.025 * (600 / 0.025) ** (index / 78))];
  const spectralAxis = Array.from({ length: 24 }, (_, index) => 470 + index * 12);
  const matrix = spectralAxis.map((wavelength, rowIndex) => timeAxis.map((time, timeIndex) => {
    const firstAmplitude = 0.005 * Math.sin((wavelength - 440) / 58) + 0.0025;
    const secondAmplitude = -0.004 * Math.cos((wavelength - 520) / 77) + 0.0012;
    const signal = firstAmplitude * Math.exp(-time / lifetimes[0])
      + secondAmplitude * Math.exp(-time / lifetimes[1]);
    const pseudoNoise = Math.sin((rowIndex + 3) * 12.9898 + (timeIndex + 5) * 78.233) * 43758.5453;
    const centeredNoise = (pseudoNoise - Math.floor(pseudoNoise) - 0.5) * Math.sqrt(12);
    return signal + noise * centeredNoise;
  }));
  return { timeAxis, spectralAxis, matrix };
}

function numericConvolution(time, lifetime, sigma) {
  const radius = sigma * 7;
  const steps = 360;
  const width = 2 * radius / steps;
  let weighted = 0;
  let weightSum = 0;
  for (let index = 0; index <= steps; index += 1) {
    const offset = -radius + index * width;
    const sourceTime = time - offset;
    const gaussian = Math.exp(-0.5 * (offset / sigma) ** 2);
    const quadratureWeight = index === 0 || index === steps ? 0.5 : 1;
    if (sourceTime >= 0) weighted += quadratureWeight * gaussian * Math.exp(-sourceTime / lifetime);
    weightSum += quadratureWeight * gaussian;
  }
  return weighted / weightSum;
}

function cropTime(analysis, minimum, maximum) {
  const indexes = analysis.timeAxis
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => time >= minimum && time <= maximum)
    .map(({ index }) => index);
  return {
    ...analysis,
    timeAxis: indexes.map((index) => analysis.timeAxis[index]),
    matrix: analysis.matrix.map((row) => indexes.map((index) => row[index])),
  };
}

function relativeError(actual, expected) {
  return Math.abs(actual - expected) / Math.abs(expected);
}
