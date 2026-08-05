import assert from "node:assert/strict";
import test from "node:test";

import {
  createMergedAnalysis,
  mergePreviewSeries,
  prepareMergePlan,
} from "../src/lib/dataset-merge.js";

test("VIS and NIR input order produces the same aligned hard join", () => {
  const { vis, nir, shiftPs, highScale } = buildPair();
  const originalVis = structuredClone(vis.analysis);
  const originalNir = structuredClone(nir.analysis);
  const forward = prepareMergePlan(vis, nir, { maxShiftPs: 2 });
  const reverse = prepareMergePlan(nir, vis, { maxShiftPs: 2 });

  assert.equal(forward.low.id, "vis");
  assert.equal(reverse.low.id, "vis");
  assert.ok(Math.abs(forward.timeShiftPs - shiftPs) <= 0.12,
    `expected ${shiftPs} ps, found ${forward.timeShiftPs} ps`);
  assert.ok(forward.timeAlignment.correlation > 0.75,
    `expected strong correlation, found ${forward.timeAlignment.correlation}`);
  assert.ok(Math.abs(forward.amplitudeScale.scale - highScale) < 0.08,
    `expected scale ${highScale}, found ${forward.amplitudeScale.scale}`);
  assert.equal(reverse.timeShiftPs, forward.timeShiftPs);

  const options = {
    lowRange: { min: 500, max: 800 },
    highRange: { min: 820, max: 1100 },
    applyAmplitudeScale: true,
  };
  const mergedForward = createMergedAnalysis(forward, options);
  const mergedReverse = createMergedAnalysis(reverse, options);
  assert.deepEqual(mergedReverse.analysis.spectralAxis, mergedForward.analysis.spectralAxis);
  assert.deepEqual(mergedReverse.analysis.timeAxis, mergedForward.analysis.timeAxis);
  assert.deepEqual(mergedReverse.analysis.matrix, mergedForward.analysis.matrix);
  assert.deepEqual(vis.analysis, originalVis);
  assert.deepEqual(nir.analysis, originalNir);
});

test("merged analysis uses joint reference time support without extrapolation", () => {
  const { vis, nir } = buildPair();
  const plan = prepareMergePlan(vis, nir, { maxShiftPs: 2 });
  const result = createMergedAnalysis(plan, {
    lowRange: { min: 500, max: 790 },
    highRange: { min: 830, max: 1100 },
  });

  assert.ok(result.analysis.timeAxis.every((time) =>
    time + plan.timeShiftPs >= nir.analysis.timeAxis[0]
      && time + plan.timeShiftPs <= nir.analysis.timeAxis.at(-1)));
  assert.equal(result.analysis.matrix.length, result.analysis.spectralAxis.length);
  assert.ok(result.analysis.matrix.every((row) => row.length === result.analysis.timeAxis.length));
  assert.ok(result.analysis.matrix.flat().every(Number.isFinite));
  assert.equal(result.analysis.spectralSegments.length, 2);
  assert.deepEqual(result.analysis.wavelengthBreaks, [{ left: 790, right: 830 }]);
  assert.equal(result.merge.signalSmoothing, "none; smoothing was used only for alignment and seam diagnostics");
  assert.match(result.analysis.provenance[0].method, /hard-join/);
});

test("overlap seam removes duplicate wavelength rows and preview uses the aligned grid", () => {
  const { vis, nir } = buildPair();
  const plan = prepareMergePlan(vis, nir, { maxShiftPs: 2 });
  const result = createMergedAnalysis(plan, {
    lowRange: { min: 500, max: 840 },
    highRange: { min: 790, max: 1100 },
    seamWavelength: 815,
  });
  const axis = result.analysis.spectralAxis;
  assert.ok(axis.every((value, index) => index === 0 || value > axis[index - 1]));
  assert.ok(axis.filter((value) => value <= 815).every((value) => vis.analysis.spectralAxis.includes(value)));
  assert.ok(axis.filter((value) => value > 815).every((value) => nir.analysis.spectralAxis.includes(value)));
  assert.deepEqual(result.analysis.wavelengthBreaks, []);

  const preview = mergePreviewSeries(plan, 3);
  assert.equal(preview.series.length, 2);
  assert.equal(preview.timePs, plan.commonTimeAxis[3]);
  assert.equal(preview.series[0].points.length, vis.analysis.spectralAxis.length);
  assert.equal(preview.series[1].points.length, nir.analysis.spectralAxis.length);
});

test("no spectral overlap records manual alignment requirement", () => {
  const { vis, nir } = buildPair();
  const shiftedNir = structuredClone(nir);
  shiftedNir.analysis.spectralAxis = shiftedNir.analysis.spectralAxis.map((value) => value + 200);
  const plan = prepareMergePlan(vis, shiftedNir, { timeShiftPs: 0.6, maxShiftPs: 2 });
  assert.equal(plan.overlap, null);
  assert.equal(plan.timeShiftPs, 0.6);
  assert.equal(Number.isNaN(plan.timeAlignment.correlation), true);
  assert.ok(plan.warnings.some((warning) => /do not overlap/.test(warning)));
});

test("post-treatment merge uses calibrated analysis time axes without a hidden shift", () => {
  const { vis, nir } = buildPair();
  const plan = prepareMergePlan(vis, nir, {
    alignmentMode: "treated-time-axis",
    timeShiftPs: 1.2,
  });
  const result = createMergedAnalysis(plan, {
    lowRange: { min: 500, max: 790 },
    highRange: { min: 830, max: 1100 },
  });

  assert.equal(plan.timeShiftPs, 0);
  assert.equal(plan.timeAlignment.appliedShiftPs, 0);
  assert.equal(plan.timeAlignment.alignmentMode, "treated-time-axis");
  assert.match(plan.timeAlignment.method, /no additional time-zero shift/);
  assert.equal(plan.commonTimeAxis.length, vis.analysis.timeAxis.length);
  assert.equal(result.merge.signalSmoothing, "none; smoothing was used only for seam diagnostics");
  assert.equal(plan.warnings.some((warning) => /automatic time alignment/i.test(warning)), false);
});

test("non-monotone merge axes are rejected", () => {
  const { vis, nir } = buildPair();
  const invalid = structuredClone(nir);
  invalid.analysis.timeAxis[4] = invalid.analysis.timeAxis[3];
  assert.throws(() => prepareMergePlan(vis, invalid), /strictly increasing/);
});

function buildPair() {
  const times = [-2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 4, 8, 15, 30, 60];
  const visWavelengths = range(500, 850, 10);
  const nirWavelengths = range(780, 1100, 10);
  const shiftPs = 0.6;
  const highScale = 1.5;
  const vis = dataset("vis", "VIS probe", visWavelengths, times, (wavelength, time) =>
    spectralAmplitude(wavelength) * kinetics(time));
  const nir = dataset("nir", "NIR probe", nirWavelengths, times, (wavelength, time) =>
    spectralAmplitude(wavelength) * kinetics(time - shiftPs) / highScale);
  return { vis, nir, shiftPs, highScale };
}

function dataset(id, label, wavelengths, times, signal) {
  const matrix = wavelengths.map((wavelength) => times.map((time) => signal(wavelength, time)));
  return {
    id,
    projectLabel: label,
    source: { fileName: `${id}.csv`, sourceFormat: "csv" },
    analysis: {
      spectralAxis: wavelengths,
      timeAxis: times,
      matrix,
      provenance: [{ label: "Fixture", status: "applied" }],
    },
  };
}

function spectralAmplitude(wavelength) {
  return 0.004
    + 0.008 * Math.exp(-(((wavelength - 810) / 90) ** 2))
    - 0.002 * Math.exp(-(((wavelength - 980) / 80) ** 2));
}

function kinetics(time) {
  const prompt = Math.exp(-0.5 * (time / 0.22) ** 2);
  const decay = time >= 0 ? Math.exp(-time / 7) + 0.25 * Math.exp(-time / 35) : 0;
  return prompt + decay;
}

function range(start, end, step) {
  const values = [];
  for (let value = start; value <= end + step * 0.1; value += step) values.push(value);
  return values;
}
