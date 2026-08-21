import assert from "node:assert/strict";
import test from "node:test";

import "../src/lib/parser-core.js";

const Parser = globalThis.SpecFlowLabParser;

test("legacy AI summary excludes IRF-limited lifetimes and component spectra", () => {
  const source = Parser.parseSpectroscopyCsv("0,0,1\n500,1,0.5\n510,-1,-0.5", "sample.csv");
  const analysis = Parser.createAnalysisDataset(source);
  const fit = {
    componentCount: 2,
    lifetimes: [0.1, 12],
    fixedLifetimes: [false, false],
    irfLimited: [true, false],
    irfFwhm: 0.25,
    preZeroModel: "constant offset",
    irfArtifactModel: "off",
    lifetimeBasis: "test basis",
    rmse: 0.01,
    explainedVariance: 0.99,
    fitPointCount: 4,
    amplitudeRanges: [{ min: -2, max: 2 }, { min: -0.5, max: 0.5 }],
    dasSpectra: [
      { label: "DAS 1", lifetime: 0.1, x: [500, 510], y: [2, -2] },
      { label: "DAS 2", lifetime: 12, x: [500, 510], y: [0.5, -0.5] },
    ],
    easSpectra: [
      { label: "EAS 1", lifetime: 0.1, x: [500, 510], y: [2, -2] },
      { label: "EAS 2", lifetime: 12, x: [500, 510], y: [0.5, -0.5] },
    ],
  };

  const result = Parser.buildAiReadySummary(source, analysis, { fit });

  assert.deepEqual(result.json.global_analysis.lifetimes_ps, [12]);
  assert.equal(result.json.global_analysis.component_count, 1);
  assert.equal(result.json.global_analysis.excluded_irf_limited_component_count, 1);
  assert.deepEqual(result.json.global_analysis.DAS.map((item) => item.component), ["DAS 2"]);
  assert.deepEqual(result.json.global_analysis.EAS.map((item) => item.component), ["EAS 2"]);
  assert.doesNotMatch(result.markdown, /\| C1 \| 0\.100/);
});
