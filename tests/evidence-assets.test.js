import assert from "node:assert/strict";
import test from "node:test";

import { addEvidenceAssetsToArchive, readEvidenceAssetsFromArchive } from "../src/lib/evidence-assets/archive.js";
import {
  createEvidenceAsset,
  createEvidenceAssetFromFile,
  evidenceAssetEntityKind,
  evidenceImportOptions,
  inferEvidenceAsset,
} from "../src/lib/evidence-assets/schema.js";

test("binary figure evidence round-trips exact source bytes", async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const asset = await createEvidenceAssetFromFile(fakeFile("panel-a.png", "image/png", bytes), {
    id: "asset:figure-a",
    label: "Figure 2a",
  });
  const entries = {};
  const descriptors = addEvidenceAssetsToArchive(entries, [asset]);
  const restored = readEvidenceAssetsFromArchive(entries, descriptors)[0];

  assert.equal(evidenceAssetEntityKind(restored), "figure-evidence");
  assert.deepEqual(restored.source.rawBytes, bytes);
  assert.equal(restored.source.byteLength, bytes.byteLength);
  assert.match(restored.source.sha256, /^[a-f0-9]{64}$/);
});

test("one-dimensional spectroscopy preview keeps source rows and missing values explicit", async () => {
  const raw = new TextEncoder().encode("500,0.10\n510,NaN\n520,-0.03\n");
  const asset = await createEvidenceAssetFromFile(fakeFile("absorption.csv", "text/csv", raw), {
    id: "asset:abs",
    techniqueId: "absorption",
  });

  assert.equal(asset.kind, "spectroscopy");
  assert.deepEqual(asset.nativePreview.xAxis.values, [500, 510, 520]);
  assert.equal(Number.isNaN(asset.nativePreview.signal.values[1]), true);
  assert.deepEqual(asset.nativePreview.sourceLineIndices, [0, 1, 2]);
  assert.match(asset.nativePreview.missingValuePolicy, /does not fill or resample/);
  assert.deepEqual(asset.source.rawBytes, raw);
});

test("citation-only literature preserves attribution and rights metadata", () => {
  const asset = createEvidenceAsset({
    id: "asset:paper",
    kind: "literature",
    label: "Reference paper",
    citation: {
      title: "Ultrafast reference",
      authors: "A. Researcher",
      year: "2026",
      doi: "10.1000/example",
      rightsStatus: "citation-only",
    },
  });

  assert.equal(asset.source.kind, "citation");
  assert.equal(asset.source.rawBytes, null);
  assert.equal(asset.citation.doi, "10.1000/example");
  assert.equal(evidenceAssetEntityKind(asset), "literature-source");
});

test("evidence inference distinguishes spectra, figures, manuscripts, and PDFs", () => {
  assert.equal(inferEvidenceAsset("pl.tsv").kind, "spectroscopy");
  assert.equal(inferEvidenceAsset("pl.tsv").techniqueId, "pl");
  assert.equal(inferEvidenceAsset("sample-absorption.csv").techniqueId, "absorption");
  assert.equal(inferEvidenceAsset("scheme.svg").kind, "figure");
  assert.equal(inferEvidenceAsset("draft.docx").kind, "manuscript");
  assert.equal(inferEvidenceAsset("supporting.pdf").kind, "document");
});

test("literature import is file-first and keeps figures distinct from publication files", () => {
  const paper = evidenceImportOptions("reference-paper.pdf", "application/pdf", "literature");
  const figure = evidenceImportOptions("reference-figure.png", "image/png", "literature");

  assert.equal(paper.kind, "literature");
  assert.equal(paper.citation.title, "reference-paper");
  assert.equal(paper.measurementRole, "reference");
  assert.equal(figure.kind, "figure");
  assert.equal(figure.citation.title, "reference-figure");
});

function fakeFile(name, type, bytes) {
  return {
    name,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}
