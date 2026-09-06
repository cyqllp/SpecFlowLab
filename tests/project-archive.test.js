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
import { upsertEvidenceConnection } from "../src/lib/evidence-graph/connections.js";
import { migrateEvidenceGraph } from "../src/lib/evidence-graph/schema.js";
import { upsertFeatureAssignment, upsertFeatureSignature } from "../src/lib/evidence-graph/entities.js";
import { createManualSignature } from "../src/lib/feature-monitor/signatures.js";

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
  assert.deepEqual(dataset.fit.uncertainty, fit.uncertainty);
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

test("project archive round-trips evidence graph metadata without changing numerical datasets", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "evidence-a.csv");
  source.rawText = rawText;
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const project = buildProject({ source, baseAnalysis, analysis: Parser.cloneAnalysisDataset(baseAnalysis), fit: null });
  const second = structuredClone(project.datasets[0]);
  second.id = "dataset-2";
  second.projectLabel = "Evidence comparison";
  second.source.fileName = "evidence-b.csv";
  second.sampleNote = "参照样品 beta";
  project.datasets.push(second);
  project.datasets[0].evidenceMetadata = {
    technique: { id: "fsta", label: "" },
    measurementRole: "primary",
    sampleId: "sample-01",
    preparationId: "prep-01",
    speciesStateIds: [],
    conditions: { solvent: "toluene", temperature: "298 K" },
  };
  project.datasets[1].evidenceMetadata = {
    technique: { id: "absorption", label: "" },
    measurementRole: "reference",
    sampleId: "sample-01",
    preparationId: "prep-01",
    speciesStateIds: [],
    conditions: { solvent: "toluene", temperature: null },
  };
  project.evidenceGraph = upsertEvidenceConnection(
    migrateEvidenceGraph(null, project.datasets, { createdAt: project.savedAt }),
    {
      fromId: "dataset-1",
      toId: "dataset-2",
      type: "same-sample",
      rationale: "Recorded as aliquots from the same prepared sample",
    },
    project.datasets,
    { createdAt: project.savedAt },
  );
  const matricesBefore = project.datasets.map((dataset) => structuredClone(dataset.analysis.matrix));

  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), Parser);

  assert.equal(restored.evidenceGraph.schema, "specflowlab.evidence_graph.v1");
  assert.equal(restored.evidenceGraph.relationships[0].type, "same-sample");
  assert.equal(restored.evidenceGraph.annotations.find((item) => item.targetId === "dataset-2").text, "参照样品 beta");
  assert.equal(restored.datasets[0].evidenceMetadata.conditions.solvent, "toluene");
  assert.equal(restored.datasets[1].evidenceMetadata.technique.id, "absorption");
  assert.deepEqual(restored.datasets.map((dataset) => dataset.analysis.matrix), matricesBefore);
});

test("project archive round-trips user feature assignments as feature entities", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "feature-a.csv");
  source.rawText = rawText;
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const project = buildProject({ source, baseAnalysis, analysis: Parser.cloneAnalysisDataset(baseAnalysis), fit: null });
  project.evidenceGraph = upsertFeatureAssignment(
    migrateEvidenceGraph(null, project.datasets, { createdAt: project.savedAt }),
    {
      id: "feature-candidate:dataset-1:eas:c02:r01",
      featureCode: "F2.1",
      componentIndex: 1,
      wavelengthMin: 473,
      wavelengthMax: 598,
      wavelengthCenter: 535.6,
      candidateType: "Negative feature: GSB or SE candidate",
      datasetId: "dataset-1",
      mode: "EAS",
    },
    "GSB",
    "consistent with reference ground-state bleach",
    project.datasets,
    { createdAt: project.savedAt },
  );

  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), Parser);
  const entity = restored.evidenceGraph.entities.find((item) => item.id === "feature-candidate:dataset-1:eas:c02:r01");

  assert.ok(entity);
  assert.equal(entity.kind, "feature");
  assert.equal(entity.assignment, "GSB");
  assert.equal(entity.note, "consistent with reference ground-state bleach");
  assert.equal(entity.datasetId, "dataset-1");
  assert.equal(restored.datasets[0].analysis.matrix.length, project.datasets[0].analysis.matrix.length);
});

test("project archive preserves a user-defined signature peak and editor details", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "manual-signature.csv");
  source.rawText = rawText;
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const project = buildProject({ source, baseAnalysis, analysis: Parser.cloneAnalysisDataset(baseAnalysis), fit: null });
  project.datasets[0].treatmentOverrides = { baseline: true, chirp: true };
  const signature = createManualSignature(project.datasets[0], 0, 512.75, 0.02, {
    idSuffix: "archive-test",
    createdAt: project.savedAt,
  });
  project.evidenceGraph = upsertFeatureSignature(
    migrateEvidenceGraph(null, project.datasets, { createdAt: project.savedAt }),
    signature,
    { assignment: "ESA", label: "blue ESA shoulder", note: "clicked on EAS 1" },
    project.datasets,
    { createdAt: project.savedAt },
  );

  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), Parser);
  const entity = restored.evidenceGraph.entities.find((item) => item.id === signature.id);

  assert.equal(entity.signatureSource, "manual");
  assert.equal(entity.wavelengthCenter, 512.75);
  assert.equal(entity.componentIndex, 0);
  assert.equal(entity.assignment, "ESA");
  assert.equal(entity.label, "blue ESA shoulder");
  assert.equal(entity.note, "clicked on EAS 1");
  assert.deepEqual(restored.datasets[0].treatmentOverrides, { baseline: true, chirp: true });
});

test("older archives without feature entities load cleanly", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "legacy-a.csv");
  source.rawText = rawText;
  const baseAnalysis = Parser.createAnalysisDataset(source);
  const project = buildProject({ source, baseAnalysis, analysis: Parser.cloneAnalysisDataset(baseAnalysis), fit: null });
  delete project.evidenceGraph;

  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), Parser);

  assert.equal(restored.evidenceGraph.schema, "specflowlab.evidence_graph.v1");
  assert.equal(restored.evidenceGraph.entities.filter((entity) => entity.kind === "feature").length, 0);
  assert.equal(restored.datasets[0].id, "dataset-1");
});

test("project archive preserves external evidence bytes, citations, and graph nodes", () => {
  const rawText = buildCsvFixture();
  const source = Parser.parseSpectroscopyCsv(rawText, "evidence-source.csv");
  source.rawText = rawText;
  const analysis = Parser.createAnalysisDataset(source);
  const project = buildProject({ source, baseAnalysis: analysis, analysis: Parser.cloneAnalysisDataset(analysis), fit: null });
  const figureBytes = Uint8Array.from([137, 80, 78, 71, 0, 1, 2, 255]);
  project.evidenceAssets = [{
    schema: "specflowlab.evidence_asset.v1",
    id: "asset:figure",
    kind: "figure",
    label: "Imported heatmap",
    techniqueId: "other",
    measurementRole: "supporting",
    note: "Panel linked to the processed result",
    createdAt: project.savedAt,
    source: { kind: "binary", fileName: "heatmap.png", mediaType: "image/png", byteLength: figureBytes.byteLength, rawBytes: figureBytes, sha256: "recorded-checksum" },
    citation: { title: "", authors: "", year: "", doi: "", url: "", figure: "Figure 2", rightsStatus: "user-supplied-private" },
    nativePreview: null,
    provenance: [{ action: "import", exactSourcePreserved: true }],
  }];
  project.evidenceGraph = migrateEvidenceGraph(null, project.datasets, { evidenceAssets: project.evidenceAssets });
  project.evidenceGraph = upsertEvidenceConnection(project.evidenceGraph, {
    fromId: "dataset-1",
    toId: "asset:figure",
    type: "documented-by",
    rationale: "The figure presents this processed dataset",
  }, project.datasets, { evidenceAssets: project.evidenceAssets, createdAt: project.savedAt });
  const matrixBefore = structuredClone(project.datasets[0].analysis.matrix);

  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), Parser);

  assert.deepEqual(restored.evidenceAssets[0].source.rawBytes, figureBytes);
  assert.equal(restored.evidenceAssets[0].citation.figure, "Figure 2");
  assert.equal(restored.evidenceGraph.entities.find((entity) => entity.id === "asset:figure").kind, "figure-evidence");
  assert.equal(restored.evidenceGraph.relationships[0].type, "documented-by");
  assert.deepEqual(restored.datasets[0].analysis.matrix, matrixBefore);
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
