import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import "../src/lib/parser-core.js";
import {
  ORIGIN_BUNDLE_SCHEMA,
  createOriginBundle,
} from "../src/lib/origin-bundle.js";
import { buildUfsFixture } from "./ufs-fixture.js";

const Parser = globalThis.SpecFlowLabParser;

test("Origin bundle carries exact source, treated arrays, selections, and plot-ready fit data", () => {
  const project = buildProject();
  const archive = createOriginBundle(project, {
    createdAt: "2026-07-29T08:00:00.000Z",
  });
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const dataset = manifest.datasets[0];

  assert.equal(manifest.bundleSchema, ORIGIN_BUNDLE_SCHEMA);
  assert.equal(manifest.createdAt, "2026-07-29T08:00:00.000Z");
  assert.equal(strFromU8(entries[dataset.source.entry]), project.datasets[0].source.rawText);
  assert.deepEqual(decodeFloat64(entries[dataset.analysis.timeAxis.entry]), [-1, 0, 1]);
  assert.deepEqual(decodeFloat64(entries[dataset.analysis.spectralAxis.entry]), [500, 510]);

  const treated = decodeFloat64(entries[dataset.analysis.matrix.entry]);
  assert.equal(treated.length, 6);
  assert.equal(Number.isNaN(treated[4]), true);
  assert.equal(Number.isNaN(treated[5]), true);
  assert.deepEqual(dataset.selection, {
    timeIndex: 2,
    wavelengthIndex: 1,
    timeValue: 1,
    wavelengthValue: 510,
  });

  assert.deepEqual(dataset.fit.das.labels, ["DAS 1", "DAS 2"]);
  assert.deepEqual(dataset.fit.eas.lifetimes, [0.5, 12]);
  assert.deepEqual(
    decodeFloat64(entries[dataset.fit.residualMatrix.entry]),
    [0.1, 0.2, 0.3, -0.1, -0.2, -0.3],
  );
  assert.equal(dataset.plotPlan.some((plot) => plot.id === "residual-heatmap"), true);
  assert.equal("fittedMatrix" in dataset.fit.metadata, false);
});

test("Origin bundle rejects a treated matrix that disagrees with its axes", () => {
  const project = buildProject();
  project.datasets[0].analysis.matrix[0].pop();
  assert.throws(
    () => createOriginBundle(project),
    /treated matrix column count/i,
  );
});

test("Origin bundle preserves UFS raw bytes and provides a CSV compatibility matrix", () => {
  const project = buildProject();
  const rawBytes = buildUfsFixture();
  project.datasets[0].source = Parser.parseSpectroscopyUfs(rawBytes, "origin-fixture.ufs");
  project.datasets[0].sampleNote = Parser.buildUfsDatasetNote(project.datasets[0].source);

  const archive = createOriginBundle(project, {
    createdAt: "2026-07-29T08:00:00.000Z",
  });
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const descriptor = manifest.datasets[0].source;

  assert.equal(descriptor.format, "ufs");
  assert.deepEqual(entries[descriptor.rawEntry], rawBytes);
  assert.match(strFromU8(entries[descriptor.entry]), /^0,-1,0\.1,10\r\n/);
  assert.match(manifest.datasets[0].sampleNote, /Operator: SpecFlowLab test/);
});

test("Origin output completely excludes IRF-limited component spectra and lifetimes", () => {
  const project = buildProject();
  project.state.fitting.hideIrfLimited = true;
  project.datasets[0].fit.irfLimited = [true, false];
  const archive = createOriginBundle(project, {
    createdAt: "2026-07-29T08:00:00.000Z",
  });
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const dataset = manifest.datasets[0];

  assert.equal(dataset.fit.metadata.originHideIrfLimited, true);
  assert.equal(dataset.fit.metadata.componentCount, 1);
  assert.deepEqual(dataset.fit.metadata.lifetimes, [12]);
  assert.equal(dataset.fit.metadata.excludedIrfLimitedComponentCount, 1);
  assert.equal(dataset.fit.das.rows, 1);
  assert.deepEqual(dataset.fit.das.componentIndices, [1]);
  assert.deepEqual(
    decodeFloat64(entries[dataset.fit.das.entry]),
    [0.003, 0.004],
  );
  assert.equal(
    dataset.plotPlan.find((plot) => plot.id === "das").componentFilter,
    "exclude-irf-limited",
  );
  assert.deepEqual(
    dataset.plotPlan.find((plot) => plot.id === "treated-heatmap"),
    {
      id: "treated-heatmap",
      kind: "virtual-matrix-heatmap",
      source: "analysis.matrix",
      x: "spectral",
      y: "time",
      yScale: "log10",
      yMinimum: 0.1,
      z: "signal",
    },
  );
});

test("Origin bundle preserves merge lineage and marks every spectral plot with its wavelength break", () => {
  const project = buildProject();
  const merge = {
    schema: "specflowlab.dataset_merge.v1",
    sourceDatasets: [
      { id: "vis", label: "VIS", fileName: "vis.csv" },
      { id: "nir", label: "NIR", fileName: "nir.csv" },
    ],
    wavelengthBreaks: [{ left: 510, right: 850 }],
  };
  project.datasets[0].kind = "merged";
  project.datasets[0].merge = merge;
  project.datasets[0].analysis.spectralSegments = [
    { sourceDatasetId: "vis", min: 500, max: 510 },
    { sourceDatasetId: "nir", min: 850, max: 860 },
  ];
  project.datasets[0].analysis.wavelengthBreaks = merge.wavelengthBreaks;

  const archive = createOriginBundle(project, {
    createdAt: "2026-07-29T08:00:00.000Z",
  });
  const entries = unzipSync(archive);
  const dataset = JSON.parse(strFromU8(entries["manifest.json"])).datasets[0];

  assert.equal(dataset.kind, "merged");
  assert.deepEqual(dataset.merge, merge);
  assert.deepEqual(dataset.analysis.metadata.wavelengthBreaks, merge.wavelengthBreaks);
  for (const id of ["treated-heatmap", "selected-spectrum", "residual-heatmap", "das", "eas"]) {
    const plot = dataset.plotPlan.find((item) => item.id === id);
    assert.equal(plot.spectralSegments, "analysis.metadata.spectralSegments");
    assert.equal(plot.wavelengthBreaks, "analysis.metadata.wavelengthBreaks");
  }
});

function buildProject() {
  const spectralAxis = [500, 510];
  const timeAxis = [-1, 0, 1];
  return {
    schema: "specflowlab.desktop_preview.v3",
    appVersion: "test",
    savedAt: "2026-07-29T07:00:00.000Z",
    projectContract: {
      sourceCsvPolicy: "preserved",
      treatedDatasetPolicy: "materialized",
    },
    state: {
      activeIndex: 0,
      selectedTimeIndex: 2,
      selectedWavelengthIndex: 1,
      compare: { selectedIds: ["dataset-1"] },
      fitting: { components: 2, irfFwhm: 0.25 },
    },
    folders: [{ id: "folder-1", name: "VIS" }],
    datasets: [{
      id: "dataset-1",
      folderId: "folder-1",
      projectLabel: "Origin fixture",
      sampleNote: "Bridge round-trip",
      source: {
        fileName: "origin-fixture.csv",
        rawText: "0,-1,0,1\r\n500,1,2,3\r\n510,4,NaN,\r\n",
        metadata: {
          "Time units": "ps",
          "Z axis title": "Delta A",
        },
      },
      analysis: {
        timeAxis,
        spectralAxis,
        matrix: [
          [1, 2, 3],
          [4, Number.NaN, null],
        ],
        selectedRange: { time: [-1, 1], spectral: [500, 510] },
        provenance: [{ label: "Baseline", status: "applied" }],
      },
      fit: {
        model: "global-exponential-preview",
        componentCount: 2,
        irfFwhm: 0.25,
        lifetimes: [0.5, 12],
        irfLimited: [false, false],
        rmse: 0.001,
        explainedVariance: 0.98,
        amplitudes: [[1, 2], [3, 4]],
        artifactAmplitudes: [0, 0],
        fittedMatrix: [
          [0.9, 1.8, 2.7],
          [4.1, 5.2, 6.3],
        ],
        residualMatrix: [
          [0.1, 0.2, 0.3],
          [-0.1, -0.2, -0.3],
        ],
        dasSpectra: [
          { label: "DAS 1", lifetime: 0.5, x: spectralAxis, y: [-0.01, -0.02] },
          { label: "DAS 2", lifetime: 12, x: spectralAxis, y: [0.003, 0.004] },
        ],
        easSpectra: [
          { label: "EAS 1", lifetime: 0.5, x: spectralAxis, y: [-0.02, -0.03] },
          { label: "EAS 2", lifetime: 12, x: spectralAxis, y: [0.005, 0.006] },
        ],
      },
    }],
  };
}

function decodeFloat64(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 8 }, (_, index) => view.getFloat64(index * 8, true));
}
