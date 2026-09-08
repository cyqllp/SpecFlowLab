import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FITTING_INPUTS, restoreDefaultFittingInputs } from "../src/lib/fitting-defaults.js";

test("reset fitting inputs restores the three-component automatic defaults without replacing results", () => {
  const fitResult = { lifetimes: [1, 10, 100, 1000] };
  const fitting = {
    components: 5,
    irfFwhm: 0.8,
    preZeroModel: "none",
    optimizerStarts: 9,
    spectrumMode: "DAS",
    lastResult: fitResult,
  };

  restoreDefaultFittingInputs(fitting, "dataset-a");

  Object.entries(DEFAULT_FITTING_INPUTS).forEach(([key, value]) => assert.equal(fitting[key], value));
  assert.deepEqual(fitting.lifetimeValues, ["", "", ""]);
  assert.deepEqual(fitting.fixedLifetimes, [false, false, false]);
  assert.equal(fitting.editorDatasetId, "dataset-a");
  assert.equal(fitting.spectrumMode, "DAS");
  assert.equal(fitting.lastResult, fitResult);
});
