import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateChirpModel, chirpArrival } from '../src/lib/chirp-model.js';
import { chirpFixture } from './chirp-fixture.js';

const smooth = w => 0.1 + 0.2 * ((w - 550) / 150) ** 2;

test('a widening nonuniform time grid can locate a delayed edge using its local sampling interval', () => {
  const input = chirpFixture({ dt: 0.025, arrival: () => 0.9, shape: t => 0.5 * (1 + Math.tanh(t / 0.08)) });
  const selected = input.timeAxis.flatMap((t, i) => t < 0.55 || i % 5 === 0 ? [i] : []);
  input.timeAxis = selected.map(i => input.timeAxis[i]);
  input.matrix = input.matrix.map(row => selected.map(i => row[i]));
  const m = estimateChirpModel(input, { approximateZeroTimePs: 0 });
  assert.equal(m.accepted, true, m.reason);
  assert.equal(m.selectedDegree, 1);
  assert.ok(Math.abs(chirpArrival(m, 550) - 0.9) < 0.08);
  assert.ok(m.anchors[0].localStepPs > 0.1);
});
