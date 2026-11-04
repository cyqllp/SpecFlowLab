import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/lib/parser-core.js';

const P = globalThis.SpecFlowLabParser;
test('chirp hint selects a delayed edge and sets the target without mutating input', () => {
  const timeAxis = Array.from({length: 81}, (_, i) => -1 + i * 0.05);
  const spectralAxis = Array.from({length: 12}, (_, i) => 450 + i * 20);
  const matrix = spectralAxis.map((w, i) => timeAxis.map(t => (t >= 0 ? 0.2 : 0) + (t >= 1 + i * 0.02 ? 1 : 0)));
  const analysis = {timeAxis, spectralAxis, matrix, provenance: [], excluded: [], selectedRange: {time: {}, spectral: {}}};
  const before = structuredClone(analysis);
  const [guided] = P.applySharedChirpCorrection([analysis], {approximateZeroTimePs: 1.1});
  assert.deepEqual(analysis, before);
  assert.equal(guided.chirp.model.targetReferenceTime, 1.1);
  assert.ok(guided.chirp.model.referenceTime >= 1);
  assert.notDeepEqual(guided.matrix, matrix);
  const [automatic] = P.applySharedChirpCorrection([analysis]);
  assert.equal(automatic.chirp.model.targetReferenceTime, 0);
  assert.ok(automatic.chirp.model.referenceTime < guided.chirp.model.referenceTime);
});
