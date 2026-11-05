import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/lib/parser-core.js';

const P = globalThis.SpecFlowLabParser;
test('chirp hint selects a delayed edge and defaults the target to zero without mutating input', () => {
  const timeAxis = Array.from({length: 81}, (_, i) => -1 + i * 0.05);
  const spectralAxis = Array.from({length: 12}, (_, i) => 450 + i * 20);
  const matrix = spectralAxis.map((w, i) => timeAxis.map(t => (t >= 0 ? 0.2 : 0) + (t >= 1 + i * 0.02 ? 1 : 0)));
  const analysis = {timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: {time: {}, spectral: {}}};
  const before = structuredClone(analysis);
  const [guided] = P.applySharedChirpCorrection([analysis], {approximateZeroTimePs: 1.1});
  assert.deepEqual(analysis, before);
  assert.equal(guided.chirp.model.targetReferenceTime, 0);
  assert.equal(P.applySharedChirpCorrection([analysis], {approximateZeroTimePs: 1.1, targetReferenceTime: 0.2})[0].chirp.model.targetReferenceTime, 0.2);
  assert.ok(guided.chirp.model.referenceTime >= 1);
  assert.notDeepEqual(guided.matrix, matrix);
  const [automatic] = P.applySharedChirpCorrection([analysis]);
  assert.equal(automatic.chirp.model.targetReferenceTime, 0);
  assert.ok(automatic.chirp.model.referenceTime < guided.chirp.model.referenceTime);
});

test('guided constant delay moves the edge to zero and preserves missing brackets', () => {
  const timeAxis = Array.from({length: 161}, (_, i) => -2 + i * 0.025);
  const spectralAxis = Array.from({length: 16}, (_, i) => 450 + i * 10);
  const matrix = spectralAxis.map((w, i) => timeAxis.map((t, j) => j >= 8 && j <= 12 ? NaN : (t >= 1.1 ? (i % 2 ? -1 : 1) : 0)));
  const analysis = {timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: {time: {}, spectral: {}}};
  const zero = P.applyChirpCorrection(analysis, {approximateZeroTimePs: 1.1});
  const target = P.applySharedChirpCorrection([analysis], {approximateZeroTimePs: 1.1, targetReferenceTime: 0.2})[0];
  assert.equal(zero.chirp.model.absoluteOffsetStatus, 'qualified');
  assert.equal(zero.chirp.model.relativeDispersionStatus, 'qualified');
  assert.deepEqual(zero.timeAxis, timeAxis);
  assert.ok(Math.abs(zero.chirp.curve[0].shift - 1.1) <= 0.05);
  assert.ok(Math.abs(target.chirp.curve[0].shift - zero.chirp.curve[0].shift + 0.2) < 1e-10);
  assert.ok(zero.matrix[0].some(Number.isNaN));
  assert.deepEqual(P.applyChirpCorrection(analysis, {approximateZeroTimePs: 1.1}).matrix, zero.matrix);
});

test('guided correction skips when baseline support is missing', () => {
  const timeAxis = Array.from({length: 41}, (_, i) => i * 0.05);
  const spectralAxis = Array.from({length: 12}, (_, i) => 450 + i * 10);
  const matrix = spectralAxis.map(() => timeAxis.map(t => t >= 1 ? 1 : 0));
  const analysis = {timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: {time: {}, spectral: {}}};
  const result = P.applyChirpCorrection(analysis, {approximateZeroTimePs: 1});
  assert.equal(result.provenance.at(-1).status, 'skipped');
  assert.equal(result.chirp.model.absoluteOffsetStatus, 'review-required');
  assert.deepEqual(result.matrix, matrix);
});

test('guided fit records bounded search and independent validation evidence', () => {
  const timeAxis = Array.from({length: 241}, (_, i) => -2 + i * 0.02);
  const spectralAxis = Array.from({length: 30}, (_, i) => 400 + i * 10);
  const matrix = spectralAxis.map((_, i) => timeAxis.map(t => t >= 1.05 + i * 0.02 ? 1 : 0));
  const analysis = {timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: {time: {}, spectral: {}}};
  const result = P.applyChirpCorrection(analysis, {approximateZeroTimePs: 1});
  const model = result.chirp.model;
  assert.deepEqual(model.searchWindowsPs[0], [0.5, 1.5]);
  assert.ok(model.searchWindowsPs.length > 1 && model.searchWindowsPs.length <= 3);
  assert.equal(model.heldOutCount, model.support);
  assert.equal(model.heldOutAgreement, true);
  assert.equal(model.onsetAgreement, true);
  assert.ok(Number.isFinite(model.onsetMedian));
});
