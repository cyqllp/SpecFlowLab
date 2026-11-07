import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateChirpModel, chirpArrival } from '../src/lib/chirp-model.js';
import { chirpFixture } from './chirp-fixture.js';

const smooth = w => 0.1 + 0.2 * ((w - 550) / 150) ** 2;

test('distributed minority of stronger unrelated edges is reported without biasing a supported fit', () => {
  const input = chirpFixture({ count: 101, arrival: (w, i) => smooth(w) + (i % 10 === 5 ? 0.3 : 0) });
  const m = estimateChirpModel(input, { approximateZeroTimePs: 0.2 });
  assert.equal(m.accepted, true, m.reason);
  assert.ok(m.inlierFraction >= 0.8 && m.inlierFraction < 0.95);
  assert.ok(m.residualP95 > m.alignmentTolerancePs);
  assert.ok(m.heldOutP95 > 2 * m.alignmentTolerancePs);
  for (const w of [400, 475, 550, 625, 700]) assert.ok(Math.abs(chirpArrival(m, w) - smooth(w)) < 0.02);
});

test('a concentrated conflicting wavelength region cannot be discarded as outliers', () => {
  const input = chirpFixture({ count: 101, arrival: (w, i) => smooth(w) + (i >= 40 && i <= 55 ? 0.3 : 0) });
  const m = estimateChirpModel(input, { approximateZeroTimePs: 0.2 });
  assert.equal(m.accepted, false);
  assert.equal(m.consensusDistributed, false);
});

test('missing anchors at one spectral edge trigger expanded arrival search', () => {
  const input = chirpFixture({ count: 101, arrival: (w) => w > 650 ? 0.8 : 0 });
  const m = estimateChirpModel(input, { approximateZeroTimePs: 0 });
  assert.ok(m.searchWindowsPs.length > 1);
  assert.equal(m.accepted, false, 'a discontinuity must not qualify as smooth dispersion');
});

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

test('incompatible qualified arrival windows require review instead of choosing a different feature', () => {
  const input = chirpFixture({ shape: t => 0.05 * (1 + Math.tanh(t / 0.03)) + 0.5 * (1 + Math.tanh((t - 0.8) / 0.03)) });
  const m = estimateChirpModel(input, { approximateZeroTimePs: 0 });
  assert.equal(m.accepted, false);
  assert.equal(m.candidateDisagreement, true);
  assert.ok(m.qualifiedCandidateCount > 1);
  assert.equal(m.testedCandidateCount, 15);
  assert.equal(m.searchWindowsPs.length, 5);
  assert.match(m.reason, /disagree/);
});
