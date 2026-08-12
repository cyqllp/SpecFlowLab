import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import { selectRepresentativeTimeIndices, selectRepresentativeWavelengthIndices } from "../src/lib/ai-investigation/coordinate-selection.js";
import { validateAiGoal } from "../src/lib/ai-investigation/goals.js";
import { createAiInvestigationPackage, inspectAiInvestigation } from "../src/lib/ai-investigation/package.js";
import { AI_INVESTIGATION_SCHEMA, AI_INVESTIGATION_SPEC_SCHEMA, assertSafeAiPath } from "../src/lib/ai-investigation/schema.js";
import { defaultAiScope, resolveAiScope } from "../src/lib/ai-investigation/scope.js";
import { upsertEvidenceConnection } from "../src/lib/evidence-graph/connections.js";
import { migrateEvidenceGraph } from "../src/lib/evidence-graph/schema.js";

test("AI investigation defaults multi-dataset work to the current folder", () => {
  const project = buildProject();
  assert.deepEqual(defaultAiScope(project), { kind: "current-folder", datasetIds: [] });
  assert.deepEqual(resolveAiScope(project, { kind: "current-folder" }).map((item) => item.id), ["dataset-a", "dataset-b"]);
  project.datasets.push({ ...project.datasets[1], id: "dataset-c", folderId: "folder-2" });
  assert.deepEqual(resolveAiScope(project, { kind: "current-folder" }).map((item) => item.id), ["dataset-a", "dataset-b"]);
});

test("goal eligibility is explicit and never triggers an automatic fit", () => {
  const project = buildProject();
  assert.deepEqual(validateAiGoal("compare", project.datasets), []);
  assert.match(validateAiGoal("fit-quality", [project.datasets[1]])[0], /requires at least one fitted dataset/i);
  assert.match(validateAiGoal("compare", [project.datasets[0]])[0], /requires at least 2 datasets/i);
});

test("representative coordinates are deterministic, physical, and deduplicated", () => {
  const dataset = buildProject().datasets[0];
  const firstTimes = selectRepresentativeTimeIndices(dataset, { selectedTimeIndex: 2, limit: 6 });
  const secondTimes = selectRepresentativeTimeIndices(dataset, { selectedTimeIndex: 2, limit: 6 });
  const wavelengths = selectRepresentativeWavelengthIndices(dataset, { selectedWavelengthIndex: 1, limit: 6 });
  assert.deepEqual(firstTimes, secondTimes);
  assert.equal(new Set(firstTimes.map((item) => item.index)).size, firstTimes.length);
  assert.equal(firstTimes[0].index, 2);
  assert.equal(wavelengths[0].index, 1);
});

test("diagnostic .sflai is question-driven, concise, checksummed, and non-mutating", async () => {
  const project = buildProject();
  const before = structuredClone(project);
  const result = await createAiInvestigationPackage(project, buildSpec(), {
    investigationId: "investigation-test",
    createdAt: "2026-08-12T08:00:00.000Z",
  });
  const entries = unzipSync(result.bytes);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const brief = strFromU8(entries["brief.md"]);
  const prompt = strFromU8(entries["prompt.md"]);

  assert.equal(manifest.schema, AI_INVESTIGATION_SCHEMA);
  assert.equal(manifest.question, "Does condition B change the long-lived response?");
  assert.deepEqual(manifest.scope.datasetIds, ["dataset-a", "dataset-b"]);
  assert.deepEqual(manifest.evidence.map((item) => item.id), manifest.evidence.map((_, index) => `E${String(index + 1).padStart(3, "0")}`));
  assert.equal(Object.keys(entries).some((path) => path.startsWith("optional/raw-sources/")), false);
  assert.equal(Object.keys(entries).some((path) => path.includes("treated-matrices")), false);
  assert.doesNotMatch(brief, /Complete Structured JSON/i);
  assert.doesNotMatch(brief, /```json/);
  assert.match(prompt, /Cite E### evidence IDs/);
  assert.match(brief, /legacy-preview/i);
  assert.equal(manifest.omissions.some((item) => item.kind === "residual-svd"), true);
  assert.equal(manifest.evidence.some((item) => item.kind === "feature-monitor"), true);
  const featureEvidence = manifest.evidence.find((item) => item.kind === "feature-monitor");
  const featurePayload = JSON.parse(strFromU8(entries[featureEvidence.files[0]]));
  assert.equal(featurePayload.featureTimeMap.schema, "specflowlab.feature_time_map.v1");
  assert.equal(featurePayload.featureTimeMap.features.every((feature) => feature.status === "suggested-not-confirmed"), true);
  for (const item of manifest.evidence.filter((evidence) => evidence.files[0]?.endsWith(".csv"))) {
    assert.match(strFromU8(entries[item.files[0]]), new RegExp(`(^|[\\r\\n,])"?${item.id}"?(,|\\r?\\n)`));
  }
  const spectrumGroups = Map.groupBy(
    manifest.evidence.filter((item) => item.kind === "spectrum"),
    (item) => item.requestedCoordinates.timePs,
  );
  assert.equal([...spectrumGroups.values()].every((items) => items.length === 2), true);
  const kineticsGroups = Map.groupBy(
    manifest.evidence.filter((item) => item.kind === "kinetics"),
    (item) => item.requestedCoordinates.wavelengthNm,
  );
  assert.equal([...kineticsGroups.values()].every((items) => items.length === 2), true);
  for (const [path, checksum] of Object.entries(manifest.checksums)) {
    assert.ok(entries[path], `missing referenced entry ${path}`);
    assert.equal(createHash("sha256").update(entries[path]).digest("hex"), checksum);
  }
  assert.deepEqual(project, before);
});

test("full evidence preserves exact raw text and IEEE-754 NaN only after opt-in", async () => {
  const project = buildProject();
  const spec = buildSpec({
    evidenceProfile: "full",
    include: { rawSources: true, fullTreatedMatrices: true },
  });
  const result = await createAiInvestigationPackage(project, spec, {
    investigationId: "investigation-full",
    createdAt: "2026-08-12T08:00:00.000Z",
  });
  const entries = unzipSync(result.bytes);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const rawEvidence = manifest.evidence.find((item) => item.kind === "raw-source" && item.datasetIds[0] === "dataset-a");
  const matrixEvidence = manifest.evidence.find((item) => item.kind === "treated-matrix" && item.datasetIds[0] === "dataset-a");
  assert.equal(strFromU8(entries[rawEvidence.files[0]]), project.datasets[0].source.rawText);
  const binaryPath = matrixEvidence.files.find((path) => path.endsWith(".f64"));
  const values = decodeFloat64(entries[binaryPath]);
  assert.equal(Number.isNaN(values[7]), true);
  assert.equal(manifest.privacy.rawSourcesIncluded, true);
  assert.equal(manifest.privacy.fullTreatedMatricesIncluded, true);
});

test("inspection rejects empty questions, ineligible goals, and unsafe package paths", async () => {
  const project = buildProject();
  const preview = await inspectAiInvestigation(project, buildSpec({ question: "", goal: "fit-quality", scope: { kind: "selected-datasets", datasetIds: ["dataset-b"] } }));
  assert.equal(preview.errors.some((error) => /scientific question/i.test(error)), true);
  assert.equal(preview.errors.some((error) => /fitted dataset/i.test(error)), true);
  assert.throws(() => assertSafeAiPath("../escape.json"), /unsafe/i);
  assert.throws(() => assertSafeAiPath("C:/escape.json"), /unsafe/i);
});

test("connected .sflai scope exports only explicit one-hop evidence with reviewable conditions", async () => {
  const project = buildProject();
  project.datasets.push({
    ...structuredClone(project.datasets[1]),
    id: "dataset-c",
    projectLabel: "Unrelated lookalike",
    source: { ...project.datasets[1].source, fileName: "Condition A.csv" },
  });
  project.datasets[0].evidenceMetadata = evidenceMetadata("fsta", "primary", { solvent: "toluene", temperature: "298 K" });
  project.datasets[1].evidenceMetadata = evidenceMetadata("absorption", "reference", { solvent: "toluene", temperature: null });
  project.datasets[2].evidenceMetadata = evidenceMetadata("absorption", "reference", { solvent: "toluene", temperature: "298 K" });
  project.evidenceGraph = upsertEvidenceConnection(
    migrateEvidenceGraph(null, project.datasets),
    {
      fromId: "dataset-a",
      toId: "dataset-b",
      type: "same-sample",
      rationale: "Explicitly recorded aliquots",
    },
    project.datasets,
    { createdAt: "2026-08-12T08:00:00.000Z" },
  );
  const result = await createAiInvestigationPackage(project, buildSpec({
    goal: "multimodal-consistency",
    scope: { kind: "connected-evidence", datasetIds: ["dataset-a"] },
  }), {
    investigationId: "investigation-connected",
    createdAt: "2026-08-12T08:00:00.000Z",
  });
  const entries = unzipSync(result.bytes);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));

  assert.deepEqual(manifest.scope.datasetIds, ["dataset-a", "dataset-b"]);
  assert.equal(manifest.scope.datasetIds.includes("dataset-c"), false);
  assert.equal(manifest.connections[0].type, "same-sample");
  assert.equal(manifest.connectedInclusions["dataset-b"][0].connectionId, manifest.connections[0].id);
  assert.ok(entries["connections/evidence-graph.json"]);
  assert.match(strFromU8(entries["connections/comparability-table.csv"]), /"temperature","unknown"/i);
  assert.match(strFromU8(entries["prompt.md"]), new RegExp(manifest.connections[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("connected external evidence exports metadata and only embeds reviewed exact sources after opt-in", async () => {
  const project = buildProject();
  const sourceBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  project.evidenceAssets = [{
    schema: "specflowlab.evidence_asset.v1",
    id: "asset:figure",
    kind: "figure",
    label: "Literature Figure 4b",
    techniqueId: "other",
    measurementRole: "supporting",
    note: "Qualitative comparison only",
    createdAt: "2026-08-13T00:00:00.000Z",
    source: { kind: "binary", fileName: "figure-4b.png", mediaType: "image/png", byteLength: sourceBytes.byteLength, rawBytes: sourceBytes, sha256: "known-checksum" },
    citation: { title: "Reference article", authors: "A. Author", year: "2026", doi: "10.1000/figure", url: "", figure: "4b", rightsStatus: "permission-confirmed" },
    nativePreview: null,
    provenance: [{ action: "import", exactSourcePreserved: true }],
  }];
  project.evidenceGraph = migrateEvidenceGraph(null, project.datasets, { evidenceAssets: project.evidenceAssets });
  project.evidenceGraph = upsertEvidenceConnection(project.evidenceGraph, {
    fromId: "dataset-a",
    toId: "asset:figure",
    type: "documented-by",
    rationale: "User selected the published panel as qualitative context",
  }, project.datasets, { evidenceAssets: project.evidenceAssets, createdAt: "2026-08-13T00:00:00.000Z" });

  const result = await createAiInvestigationPackage(project, buildSpec({
    goal: "custom",
    scope: { kind: "connected-evidence", datasetIds: ["dataset-a"] },
    evidenceProfile: "full",
    include: { rawSources: true },
  }), { investigationId: "investigation-external", createdAt: "2026-08-13T00:00:00.000Z" });
  const entries = unzipSync(result.bytes);
  const external = result.manifest.evidence.find((item) => item.kind === "external-evidence");

  assert.ok(external);
  assert.equal(external.files.some((path) => path.endsWith("/source.png")), true);
  assert.deepEqual(entries[external.files.find((path) => path.endsWith("/source.png"))], sourceBytes);
  const metadata = JSON.parse(strFromU8(entries[external.files.find((path) => path.endsWith("metadata.json"))]));
  assert.equal(metadata.citation.doi, "10.1000/figure");
  assert.equal(metadata.source.exactSourceEmbeddedSeparately, true);
  assert.equal("rawBytes" in metadata.source, false);
});

function buildSpec(overrides = {}) {
  const base = {
    schema: AI_INVESTIGATION_SPEC_SCHEMA,
    goal: "compare",
    question: "Does condition B change the long-lived response?",
    context: "Matched samples; interpretation remains provisional.",
    desiredOutput: "Evidence-cited comparison with alternatives.",
    scope: { kind: "current-folder", datasetIds: [] },
    evidenceProfile: "diagnostic",
    include: {
      sampleNotes: true,
      sourceFileNames: true,
      instrumentMetadata: true,
      rawSources: false,
      fullTreatedMatrices: false,
      fullResidualMatrices: false,
    },
    privacy: {
      redactAbsolutePaths: true,
      redactOperatorNames: true,
      redactComputerNames: true,
    },
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...(overrides.scope ?? {}) },
    include: { ...base.include, ...(overrides.include ?? {}) },
    privacy: { ...base.privacy, ...(overrides.privacy ?? {}) },
  };
}

function buildProject() {
  return {
    schema: "specflowlab.desktop_preview.v3",
    appVersion: "test",
    activeDatasetId: "dataset-a",
    activeIndex: 0,
    selectedTimeIndex: 2,
    selectedWavelengthIndex: 1,
    state: { featureFinding: { relativeThreshold: 0.1, minimumGaussianR2: 0, minimumFwhmNm: 0 } },
    folders: [
      { id: "folder-1", name: "Conditions" },
      { id: "folder-2", name: "Other" },
    ],
    datasets: [
      buildDataset("dataset-a", "Condition A", true, "=untrusted note"),
      buildDataset("dataset-b", "Condition B", false, "Comparison note 光谱"),
    ],
  };
}

function buildDataset(id, label, fitted, sampleNote) {
  const spectralAxis = [500, 550, 600];
  const timeAxis = [-0.5, 0, 1, 10];
  const matrix = [
    [0, 0.2, 0.1, 0.01],
    [0, -0.4, -0.2, Number.NaN],
    [0, 0.1, 0.04, 0.005],
  ];
  const dataset = {
    id,
    folderId: "folder-1",
    kind: "imported",
    projectLabel: label,
    sampleNote,
    source: {
      fileName: `/Users/private/${id}.csv`,
      rawText: "0,-0.5,0,1,10\r\n500,0,0.2,0.1,0.01\r\n550,0,-0.4,-0.2,NaN\r\n600,0,0.1,0.04,0.005\r\n",
      sourceShape: { rows: 4, cols: 5 },
      metadata: { Operator: "Private Person", Computer: "Lab-PC", Instrument: "TA" },
    },
    analysis: {
      spectralAxis,
      timeAxis,
      matrix,
      provenance: [{ label: "Baseline", status: "applied" }],
      excluded: [],
      chirp: null,
    },
  };
  if (fitted) {
    dataset.fit = {
      componentCount: 2,
      lifetimes: [0.4, 12],
      irfLimited: [true, false],
      irfFwhm: 0.25,
      rmse: 0.01,
      explainedVariance: 0.98,
      fitPointCount: 11,
      lifetimeBasis: "preview coordinate search",
      easSpectra: [
        { label: "EAS 2", componentIndex: 1, lifetime: 12, x: spectralAxis.slice(), y: [-0.2, -1, -0.2] },
      ],
      residualMatrix: [
        [0, 0.01, -0.01, 0.002],
        [0, -0.02, 0.01, Number.NaN],
        [0, 0.003, -0.004, 0.001],
      ],
    };
  }
  return dataset;
}

function evidenceMetadata(techniqueId, measurementRole, conditions) {
  return {
    technique: { id: techniqueId, label: "" },
    measurementRole,
    sampleId: "sample-01",
    preparationId: "prep-01",
    speciesStateIds: [],
    conditions,
  };
}

function decodeFloat64(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 8 }, (_, index) => view.getFloat64(index * 8, true));
}
