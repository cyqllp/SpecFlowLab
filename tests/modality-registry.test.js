import assert from "node:assert/strict";
import test from "node:test";

import { getTechnique, listTechniques, validateNativeModalityRecord } from "../src/lib/modalities/registry.js";

test("modality registry distinguishes transient matrices from native spectra, traces, and tables", () => {
  const registry = listTechniques();
  assert.equal(getTechnique("fsta").nativeShape, "transient-matrix");
  assert.equal(getTechnique("epr").nativeShape, "one-dimensional-spectrum");
  assert.equal(getTechnique("generic-trace").nativeShape, "one-dimensional-trace");
  assert.equal(getTechnique("generic-table").nativeShape, "table");
  assert.ok(registry.some((item) => item.id === "other" && item.nativeShape === "custom"));
});

test("native modality validation rejects silent shape coercion", () => {
  assert.throws(() => validateNativeModalityRecord({
    techniqueId: "epr",
    nativeShape: "transient-matrix",
    axes: [{ name: "field", unit: "mT", values: [320, 330] }],
  }), /must retain its one-dimensional-spectrum native shape/i);
  assert.doesNotThrow(() => validateNativeModalityRecord({
    techniqueId: "generic-spectrum",
    nativeShape: "one-dimensional-spectrum",
    axes: [{ name: "energy", unit: "eV", values: [1.5, null, 2] }],
  }));
});
