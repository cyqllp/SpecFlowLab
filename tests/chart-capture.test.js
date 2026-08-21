import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import { chartCaptureMetadata, createChartCapture } from "../src/lib/chart-capture/schema.js";
import { createProjectArchive } from "../src/lib/project-archive.js";

test("chart capture freezes PNG bytes, displayed data, view state, and dataset provenance", () => {
  const sourceBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const capture = createChartCapture({
    id: "capture:test",
    createdAt: "2026-08-20T10:00:00.000Z",
    title: "Spectrum at 1 ps",
    plotKey: "spectrum",
    datasetIds: ["dataset-a"],
    datasetLabels: ["Condition A"],
    sourceFingerprint: "fingerprint-a",
    view: { timePs: 1, zoom: { xMin: 500, xMax: 700 } },
    figure: { bytes: sourceBytes, width: 640, height: 310 },
    data: { text: "Series\tWavelength (nm)\tDeltaOD\nMeasured\t500\t0.1\n" },
    provenance: [{ action: "capture-displayed-chart" }],
  });
  sourceBytes[0] = 0;
  const metadata = chartCaptureMetadata(capture);

  assert.equal(capture.figure.bytes[0], 137);
  assert.equal(capture.data.text.includes("Measured"), true);
  assert.deepEqual(metadata.datasetIds, ["dataset-a"]);
  assert.equal("bytes" in metadata.figure, false);
});

test("temporary chart captures do not enter the saved project archive", () => {
  const capture = createChartCapture({
    id: "capture:temporary",
    title: "Temporary spectrum",
    plotKey: "spectrum",
    datasetIds: ["dataset-a"],
    figure: { bytes: Uint8Array.from([1, 2, 3]), width: 10, height: 10 },
    data: { text: "x\ty\n1\t2\n" },
  });
  const archive = createProjectArchive({
    schema: "specflowlab.desktop_preview.v3",
    appVersion: "test",
    savedAt: "2026-08-20T10:00:00.000Z",
    projectContract: {},
    state: {},
    folders: [],
    datasets: [],
    evidenceAssets: [],
    evidenceGraph: null,
    chartCaptures: [capture],
  });
  const manifest = JSON.parse(strFromU8(unzipSync(archive)["manifest.json"]));

  assert.equal("chartCaptures" in manifest, false);
});
