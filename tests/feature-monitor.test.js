import assert from "node:assert/strict";
import test from "node:test";

import { detectFstaFeatureCandidates } from "../src/lib/feature-monitor/detector.js";
import { buildFeatureTimeMap } from "../src/lib/feature-monitor/compression.js";
import { fitMultiGaussianSpectrum } from "../src/lib/feature-monitor/multigaussian.js";

test("feature monitor waits for global analysis and never labels heatmap signs as assignments", () => {
  const result = detectFstaFeatureCandidates({ id: "ta", evidenceMetadata: { technique: { id: "fsta" } } }, null, []);
  assert.equal(result.status, "awaiting-global-analysis");
  assert.equal(result.candidates.length, 0);
  assert.match(result.limitations[0], /global analysis/i);
});

test("feature monitor reports positive ESA and unresolved negative candidates from current EAS", () => {
  const result = detectFstaFeatureCandidates(fittedDataset(), { relationships: [] }, []);
  assert.equal(result.status, "live");
  assert.equal(result.candidates.some((candidate) => candidate.candidateType === "ESA candidate"), true);
  assert.equal(result.candidates.some((candidate) => candidate.candidateType.includes("GSB or SE")), true);
  assert.equal(result.candidates.every((candidate) => candidate.status === "suggested-not-confirmed"), true);
  assert.equal(result.candidates.every((candidate) => /^F1\.\d+$/.test(candidate.featureCode)), true);
  assert.equal(result.candidates.every((candidate) => candidate.gaussianShape.rSquared >= 0.45), true);
});

test("feature detection can annotate DAS independently from preferred EAS", () => {
  const dataset = fittedDataset();
  dataset.fit.dasSpectra = [{
    label: "DAS 1",
    lifetime: 12,
    x: [500, 510, 520, 530],
    y: [0.9, 0.7, -0.8, -1],
  }];
  const result = detectFstaFeatureCandidates(dataset, { relationships: [] }, [], { spectrumMode: "DAS" });
  assert.equal(result.candidates.every((candidate) => candidate.source.startsWith("DAS")), true);
  assert.equal(result.candidates.every((candidate) => candidate.id.includes(":das:")), true);
});

test("noise-aware multi-Gaussian fitting finds a weak band without a component-maximum gate", () => {
  const x = Array.from({ length: 101 }, (_, index) => 450 + index * 3);
  const y = x.map((wavelength) => (
    Math.exp(-0.5 * ((wavelength - 520) / 16) ** 2)
    + 0.05 * Math.exp(-0.5 * ((wavelength - 670) / 13) ** 2)
  ));
  const dataset = {
    id: "ta",
    evidenceMetadata: { technique: { id: "fsta" } },
    fit: { easSpectra: [{ label: "EAS 1", lifetime: 12, x, y }] },
  };

  const result = detectFstaFeatureCandidates(dataset, { relationships: [] }, [], { minimumSnr: 4 });

  assert.equal(result.detectionMethod, "multi-gaussian");
  assert.equal(result.candidates.some((candidate) => Math.abs(candidate.wavelengthCenter - 670) < 5), true);
  assert.equal(result.candidates.every((candidate) => Number.isFinite(candidate.amplitudeSnr)), true);
});

test("legacy local-threshold behavior remains available as an explicit fallback", () => {
  const x = Array.from({ length: 31 }, (_, index) => 450 + index * 10);
  const y = x.map((wavelength) => Math.exp(-0.5 * ((wavelength - 520) / 16) ** 2)
    + 0.16 * Math.exp(-0.5 * ((wavelength - 670) / 13) ** 2));
  const dataset = { id: "ta", evidenceMetadata: { technique: { id: "fsta" } }, fit: { easSpectra: [{ x, y }] } };
  const result = detectFstaFeatureCandidates(dataset, { relationships: [] }, [], { method: "local-threshold", relativeThreshold: 0.25 });

  assert.equal(result.detectionMethod, "local-threshold");
  assert.equal(result.candidates.some((candidate) => candidate.peakWavelength >= 640), false);
});

test("later low-amplitude component spectra are evaluated against local noise", () => {
  const x = Array.from({ length: 151 }, (_, index) => 450 + index * 2);
  const noise = (index) => 0.0008 * Math.sin(index * 12.9898) * Math.cos(index * 5.17);
  const dataset = {
    id: "ta",
    evidenceMetadata: { technique: { id: "fsta" } },
    fit: {
      easSpectra: [
        { label: "EAS 1", x, y: x.map((wavelength, index) => Math.exp(-0.5 * ((wavelength - 520) / 15) ** 2) + noise(index)) },
        { label: "EAS 2", x, y: x.map((wavelength, index) => 0.03 * Math.exp(-0.5 * ((wavelength - 675) / 12) ** 2) + noise(index)) },
      ],
    },
  };
  const result = detectFstaFeatureCandidates(dataset, { relationships: [] }, [], { minimumSnr: 4 });

  assert.equal(result.candidates.some((candidate) => candidate.componentIndex === 0 && Math.abs(candidate.wavelengthCenter - 520) < 4), true);
  assert.equal(result.candidates.some((candidate) => candidate.componentIndex === 1 && Math.abs(candidate.wavelengthCenter - 675) < 4), true);
});

test("multi-Gaussian fitting rejects deterministic noise without a supported peak", () => {
  const x = Array.from({ length: 151 }, (_, index) => 450 + index * 2);
  const y = x.map((_wavelength, index) => 0.008 * Math.sin(index * 12.9898) * Math.cos(index * 5.17));
  const result = fitMultiGaussianSpectrum(x, y, { minimumSnr: 4, minimumFwhmNm: 6 });

  assert.equal(result.status, "no-supported-peaks");
  assert.deepEqual(result.peaks, []);
});

test("multi-Gaussian fitting separates overlapping positive and negative bands", () => {
  const x = Array.from({ length: 161 }, (_, index) => 450 + index * 2);
  const y = x.map((wavelength, index) => 0.8 * Math.exp(-0.5 * ((wavelength - 540) / 18) ** 2)
    - 0.6 * Math.exp(-0.5 * ((wavelength - 580) / 16) ** 2)
    + 0.003 * Math.sin(index * 8.1));
  const result = fitMultiGaussianSpectrum(x, y, { minimumSnr: 4, minimumFwhmNm: 8, maximumPeaks: 5 });

  assert.equal(result.peaks.some((peak) => peak.sign === "positive" && Math.abs(peak.centerNm - 540) < 5), true);
  assert.equal(result.peaks.some((peak) => peak.sign === "negative" && Math.abs(peak.centerNm - 580) < 5), true);
  assert.equal(result.peaks.some((peak) => peak.centerNm < 480), false);
});

test("multi-Gaussian fitting tolerates nonuniform sampling and explicit missing values", () => {
  const x = Array.from({ length: 90 }, (_, index) => 470 + index * (index % 3 === 0 ? 2.2 : 2.7));
  x.sort((left, right) => left - right);
  const y = x.map((wavelength) => 0.4 * Math.exp(-0.5 * ((wavelength - 575) / 17) ** 2));
  y[12] = Number.NaN;
  y[47] = Number.NaN;
  const result = fitMultiGaussianSpectrum(x, y, { minimumSnr: 3, minimumFwhmNm: 6 });

  assert.equal(result.peaks.some((peak) => Math.abs(peak.centerNm - 575) < 6), true);
  assert.equal(result.diagnostics.pointCount, x.length - 2);
});

test("IRF-limited components never create feature candidates or feature-time evolution", () => {
  const dataset = fittedDataset();
  dataset.fit.easSpectra.push({
    label: "EAS 2",
    lifetime: 0.12,
    x: dataset.fit.easSpectra[0].x.slice(),
    y: dataset.fit.easSpectra[0].y.map((value) => -value),
  });
  dataset.fit.irfLimited = [false, true];
  dataset.analysis = {
    spectralAxis: dataset.fit.easSpectra[0].x.slice(),
    timeAxis: [0, 1],
    matrix: dataset.fit.easSpectra[0].y.map((value) => [value, value * 0.5]),
  };

  const monitor = detectFstaFeatureCandidates(dataset, { relationships: [] }, []);
  const compressed = buildFeatureTimeMap(dataset, monitor);
  assert.equal(monitor.candidates.every((candidate) => candidate.componentIndex === 0), true);
  assert.equal(compressed.features.every((feature) => feature.componentIndex === 0), true);
  assert.match(monitor.limitations.join(" "), /IRF-limited components are excluded/i);
});

test("only explicitly linked absorption and PL evidence refines negative candidate context", () => {
  const absorption = spectralAsset("asset:abs", "absorption", [490, 500, 510, 520, 530], [0.1, 1, 0.8, 0.3, 0.05]);
  const unrelatedPl = spectralAsset("asset:pl", "pl", [500, 510, 520], [1, 0.8, 0.4]);
  const graph = { relationships: [{ id: "c1", fromId: "ta", toId: "asset:abs" }] };
  const result = detectFstaFeatureCandidates(fittedDataset(), graph, [absorption, unrelatedPl]);
  const negative = result.candidates.find((candidate) => candidate.sign === "negative");

  assert.equal(negative.candidateType, "GSB candidate");
  assert.deepEqual(negative.supportingReferenceIds, ["asset:abs"]);
  assert.equal(result.references.some((reference) => reference.id === "asset:pl"), false);
});

test("feature monitor recomputes classification when a linked PL reference is added", () => {
  const absorption = spectralAsset("asset:abs", "absorption", [490, 500, 510, 520, 530], [0.1, 1, 0.8, 0.3, 0.05]);
  const pl = spectralAsset("asset:pl", "pl", [500, 510, 520, 530], [0.2, 1, 0.9, 0.1]);
  const before = detectFstaFeatureCandidates(fittedDataset(), { relationships: [{ fromId: "ta", toId: "asset:abs" }] }, [absorption, pl]);
  const after = detectFstaFeatureCandidates(fittedDataset(), { relationships: [{ fromId: "ta", toId: "asset:abs" }, { fromId: "ta", toId: "asset:pl" }] }, [absorption, pl]);

  assert.equal(before.candidates.find((candidate) => candidate.sign === "negative").candidateType, "GSB candidate");
  assert.equal(after.candidates.find((candidate) => candidate.sign === "negative").candidateType, "GSB / SE overlap candidate");
  assert.match(after.recomputePolicy, /current analysis.*evidence connections/i);
});

test("feature-time map compresses deterministic wavelength regions into measured-time traces", () => {
  const dataset = fittedDataset();
  const spectrum = dataset.fit.easSpectra[0];
  dataset.analysis = {
    spectralAxis: spectrum.x.slice(),
    timeAxis: [0, 1, 10],
    matrix: spectrum.y.map((value) => [value, value * 0.65, value * 0.2]),
  };
  const monitor = detectFstaFeatureCandidates(dataset, { relationships: [] }, []);
  const compressed = buildFeatureTimeMap(dataset, monitor);

  assert.equal(compressed.status, "live");
  assert.equal(compressed.features.length, 2);
  assert.deepEqual(compressed.features[0].trace.length, dataset.analysis.timeAxis.length);
  assert.equal(compressed.compression.cellReductionFactor, dataset.analysis.spectralAxis.length / compressed.features.length);
  assert.equal(compressed.compression.coveredWavelengthFraction > 0, true);
  assert.equal(Number.isFinite(compressed.compression.reconstructionScore), true);
  assert.match(compressed.limitations[0], /lossy/i);
});

function fittedDataset() {
  const x = Array.from({ length: 17 }, (_, index) => 480 + index * 10);
  const y = x.map((wavelength) => (
    -Math.exp(-0.5 * ((wavelength - 520) / 14) ** 2)
    + 0.78 * Math.exp(-0.5 * ((wavelength - 590) / 17) ** 2)
  ));
  return {
    id: "ta",
    evidenceMetadata: { technique: { id: "fsta" } },
    fit: {
      easSpectra: [{
        label: "EAS 1",
        lifetime: 12,
        x,
        y,
      }],
    },
  };
}

function spectralAsset(id, techniqueId, x, y) {
  return {
    id,
    label: id,
    techniqueId,
    nativePreview: {
      xAxis: { values: x },
      signal: { values: y },
    },
  };
}
