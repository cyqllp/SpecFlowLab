import assert from "node:assert/strict";
import test from "node:test";

import "../src/lib/parser-core.js";
import { spectroscopySourceToCsv } from "../src/lib/source-data.js";
import { buildUfsFixture } from "./ufs-fixture.js";

const Parser = globalThis.SpecFlowLabParser;

test("UFS Version2 parser preserves axes, NaNs, metadata, and raw bytes", () => {
  const rawBytes = buildUfsFixture();
  const source = Parser.parseSpectroscopyUfs(rawBytes, "sample.ufs");

  assert.equal(source.sourceFormat, "ufs");
  assert.equal(source.ufs.version, "Version2");
  assert.deepEqual(source.spectralAxis, [500, 510]);
  assert.deepEqual(source.timeAxis, [-1, 0.1, 10]);
  assert.equal(Number.isNaN(source.matrix[0][1]), true);
  assert.equal(source.nanCount, 1);
  assert.equal(source.finiteCount, 5);
  assert.equal(source.metadata["Time units"], "ps");
  assert.equal(source.metadata["Z axis title"], "Delta A");
  assert.match(source.metadata["UFS metadata"], /Pump wavelength: 700 nm/);
  assert.deepEqual(source.rawBytes, rawBytes);
  assert.notEqual(source.rawBytes, rawBytes);

  const note = Parser.buildUfsDatasetNote(source);
  assert.match(note, /Ultrafast Systems UFS raw data/);
  assert.match(note, /Spectral axis: Wavelength \(nm\), 2 points/);
  assert.match(note, /Pump wavelength: 700 nm/);

  const csv = spectroscopySourceToCsv(source);
  assert.match(csv, /^0,-1,0\.1,10\r\n/);
  assert.match(csv, /500,1,NaN,3/);
});

test("UFS parser treats zero stored planes as one plane", () => {
  const source = Parser.parseSpectroscopyUfs(buildUfsFixture({ storedPlanes: 0 }), "zero-plane.ufs");
  assert.equal(source.ufs.storedPlanes, 0);
  assert.deepEqual(source.matrix[1], [4, 5, 6]);
});

test("UFS parser rejects dimension mismatches and trailing bytes", () => {
  assert.throws(
    () => Parser.parseSpectroscopyUfs(buildUfsFixture({ rows: 3 }), "bad-dimensions.ufs"),
    /dimensions do not match/i,
  );
  const fixture = buildUfsFixture();
  const trailing = new Uint8Array(fixture.byteLength + 1);
  trailing.set(fixture);
  assert.throws(
    () => Parser.parseSpectroscopyUfs(trailing, "trailing.ufs"),
    /trailing bytes/i,
  );
});
