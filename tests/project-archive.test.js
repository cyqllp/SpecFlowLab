import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import "../src/lib/parser-core.js";
import {
  PROJECT_ARCHIVE_SCHEMA,
  createProjectArchive,
  hydrateProjectArchive,
  readProjectArchive,
} from "../src/lib/project-archive.js";
import { buildUfsFixture } from "./ufs-fixture.js";
import { spectroscopySourceToCsv } from "../src/lib/source-data.js";

const Parser = globalThis.SpecFlowLabParser;

test("compressed project archive preserves source, treated data, and reconstructed fit", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "archive-fixture.csv");
  source.rawText = rawText;
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const analysis = Parser.applyBaselineCorrection(baseAnalysis);
  analysis.matrix[4][9] = Number.NaN;
  analysis.matrix[5][10] = null;
  const fit = Parser.fitGlobalExponentials(analysis, 3, {
    irfFwhm: 0.25,
    lifetimes: [0.8, 12, 220],
    fixedLifetimes: [true, true, true],
  });
  const project = buildProject({ source, baseAnalysis, analysis, fit });

  const legacyBytes = new TextEncoder().encode(JSON.stringify(project, null, 2)).byteLength;
  const archive = createProjectArchive(project);
  assert.equal(String.fromCharCode(archive[0], archive[1]), "PK");
  assert.ok(archive.byteLength < legacyBytes * 0.35,
    `archive ${archive.byteLength} bytes should be less than 35% of legacy JSON ${legacyBytes} bytes`);

  const unpacked = readProjectArchive(archive);
  assert.equal(unpacked.archiveSchema, PROJECT_ARCHIVE_SCHEMA);
  const restored = hydrateProjectArchive(unpacked, Parser);
  const dataset = restored.datasets[0];

  assert.equal(dataset.source.rawText, rawText);
  assert.deepEqual(dataset.analysis.timeAxis, analysis.timeAxis);
  assert.deepEqual(dataset.analysis.spectralAxis, analysis.spectralAxis);
  assert.equal(Number.isNaN(dataset.analysis.matrix[4][9]), true);
  assert.equal(Number.isNaN(dataset.analysis.matrix[5][10]), true);
  const expectedAnalysis = analysis.matrix.map((row) =>
    row.map((value) => value === null ? Number.NaN : value));
  assert.deepEqual(dataset.analysis.matrix, expectedAnalysis);
  assert.deepEqual(dataset.fit.lifetimes, fit.lifetimes);
  assert.equal(dataset.fit.fixedLifetimes.every(Boolean), true);
  assert.ok(Math.abs(dataset.fit.rmse - fit.rmse) < 1e-12);
  assert.deepEqual(dataset.fit.fittedMatrix, fit.fittedMatrix);
  assert.deepEqual(dataset.fit.residualMatrix, fit.residualMatrix);
});

test("project archive round-trips exact UFS bytes and rebuilds its source matrix", () => {
  const rawBytes = buildUfsFixture();
  const source = Parser.parseSpectroscopyUfs(rawBytes, "archive-fixture.ufs");
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const analysis = Parser.cloneAnalysisDataset(baseAnalysis);
  const project = buildProject({ source, baseAnalysis, analysis, fit: null });
  project.datasets[0].sampleNote = Parser.buildUfsDatasetNote(source);

  const archive = createProjectArchive(project);
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const descriptor = manifest.datasets[0].source;

  assert.equal(descriptor.format, "ufs");
  assert.match(descriptor.rawEntry, /source\.ufs$/);
  assert.deepEqual(entries[descriptor.rawEntry], rawBytes);
  assert.match(strFromU8(entries[descriptor.entry]), /^0,-1,0\.1,10\r\n/);

  const restored = hydrateProjectArchive(readProjectArchive(archive), Parser);
  const dataset = restored.datasets[0];
  assert.equal(dataset.source.sourceFormat, "ufs");
  assert.deepEqual(dataset.source.rawBytes, rawBytes);
  assert.deepEqual(dataset.source.matrix, source.matrix);
  assert.equal(dataset.source.metadata["UFS version"], "Version2");
  assert.match(dataset.sampleNote, /Pump wavelength: 700 nm/);
});

test("project archive preserves a derived merge snapshot, lineage, and wavelength break", () => {
  const analysis = {
    timeAxis: [-1, 0, 0.5, 1, 2, 5],
    spectralAxis: [500, 600, 790, 830, 900, 1000],
    matrix: [500, 600, 790, 830, 900, 1000].map((wavelength) =>
      [-1, 0, 0.5, 1, 2, 5].map((time) => wavelength * 1e-7 * Math.exp(-Math.max(0, time)))),
    rowRange: { start: 0, end: 5 },
    colRange: { start: 0, end: 5 },
    selectedRange: { time: { min: -1, max: 5 }, spectral: { min: 500, max: 1000 } },
    excluded: [],
    provenance: [{ label: "Merge", status: "applied" }],
    chirp: null,
    spectralSegments: [
      { parentDatasetId: "vis", minNm: 500, maxNm: 790, startIndex: 0, endIndex: 2 },
      { parentDatasetId: "nir", minNm: 830, maxNm: 1000, startIndex: 3, endIndex: 5 },
    ],
    wavelengthBreaks: [{ left: 790, right: 830 }],
  };
  const merge = {
    schema: "specflowlab.dataset_merge.v1",
    sourceDatasets: [{ id: "vis" }, { id: "nir" }],
    spectralSegments: analysis.spectralSegments,
    wavelengthBreaks: analysis.wavelengthBreaks,
    timeAlignment: { appliedShiftPs: 0.35 },
  };
  analysis.merge = merge;
  const rawText = spectroscopySourceToCsv(analysis);
  const source = Parser.parseSpectroscopyCsv(rawText, "vis-nir.merged.csv");
  source.rawText = rawText;
  source.sourceFormat = "derived-merge";
  source.spectralSegments = analysis.spectralSegments;
  source.wavelengthBreaks = analysis.wavelengthBreaks;
  source.merge = merge;
  const project = buildProject({
    source,
    baseAnalysis: Parser.cloneAnalysisDataset(analysis),
    analysis: Parser.cloneAnalysisDataset(analysis),
    fit: null,
  });
  project.datasets[0].kind = "merged";
  project.datasets[0].merge = merge;

  const archive = createProjectArchive(project);
  const manifest = JSON.parse(strFromU8(unzipSync(archive)["manifest.json"]));
  assert.equal(manifest.datasets[0].source.format, "derived-merge");
  const restored = hydrateProjectArchive(readProjectArchive(archive), Parser).datasets[0];
  assert.equal(restored.kind, "merged");
  assert.equal(restored.source.sourceFormat, "derived-merge");
  assert.deepEqual(restored.merge, merge);
  assert.deepEqual(restored.analysis.spectralSegments, analysis.spectralSegments);
  assert.deepEqual(restored.analysis.wavelengthBreaks, analysis.wavelengthBreaks);
  assert.deepEqual(restored.analysis.matrix, analysis.matrix);
});

test("archive reader rejects non-archive input", () => {
  assert.throws(
    () => readProjectArchive(new TextEncoder().encode('{"schema":"specflowlab"}')),
    /invalid zip data|manifest/i,
  );
});

test("archive reader rejects unsafe entry paths", () => {
  const archive = zipSync({
    "../manifest.json": strToU8(JSON.stringify({ archiveSchema: PROJECT_ARCHIVE_SCHEMA })),
  });
  assert.throws(() => readProjectArchive(archive), /unsafe path/i);
});

function buildProject({ source, baseAnalysis, analysis, fit }) {
  return {
    schema: "specflowlab.desktop_preview.v3",
    appVersion: "test",
    savedAt: "2026-07-29T00:00:00.000Z",
    projectContract: {
      sourceCsvPolicy: "preserved",
      treatedDatasetPolicy: "materialized",
    },
    state: {
      activeIndex: 0,
      selectedTimeIndex: 3,
      selectedWavelengthIndex: 4,
      compare: { selectedIds: ["dataset-1"], styles: {} },
      fitting: { components: 3, irfFwhm: 0.25 },
    },
    folders: [{
      id: "folder-1",
      name: "VIS",
      range: null,
      treatments: { baseline: true, chirp: false },
      collapsed: false,
    }],
    datasets: [{
      id: "dataset-1",
      folderId: "folder-1",
      projectLabel: "Archive fixture",
      sampleNote: "Round-trip test",
      source,
      baseAnalysis,
      analysis,
      fit,
    }],
  };
}

function buildCsvFixture() {
  const times = [-2, -1, -0.5, -0.2, 0, 0.1, 0.2, 0.4, 0.7, 1, 1.5, 2.5, 4, 7, 12, 20, 35, 60, 100, 180, 320, 560, 1000, 1800, 3200, 5500];
  const rows = [`0,${times.join(",")}`];
  for (let rowIndex = 0; rowIndex < 56; rowIndex += 1) {
    const wavelength = 480 + rowIndex * 5;
    const a1 = -0.012 * Math.exp(-(((wavelength - 640) / 70) ** 2));
    const a2 = 0.004 * Math.exp(-(((wavelength - 710) / 48) ** 2));
    const a3 = -0.002 * Math.exp(-(((wavelength - 540) / 80) ** 2));
    const values = times.map((time) => {
      if (time < 0) return 0.00015 + rowIndex * 1e-7;
      return 0.00015
        + a1 * Math.exp(-time / 0.8)
        + a2 * Math.exp(-time / 12)
        + a3 * Math.exp(-time / 220);
    });
    rows.push(`${wavelength},${values.map((value) => value.toPrecision(12)).join(",")}`);
  }
  return `${rows.join("\r\n")}\r\n`;
}
