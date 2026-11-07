import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/lib/parser-core.js';
import { chirpFixture, chirpCsv } from './chirp-fixture.js';
import { estimateChirpModel } from '../src/lib/chirp-model.js';
import { createProjectArchive, readProjectArchive, hydrateProjectArchive } from '../src/lib/project-archive.js';
import { inspectAiInvestigation } from '../src/lib/ai-investigation/package.js';

const P = globalThis.SpecFlowLabParser;
const arrival = w => 0.1 + 0.001 * (w - 400);
const step = t => 0.5 * (1 + Math.tanh(t / 0.03));
const weakTail = () => chirpFixture({ count: 101, arrival, shape: (t, i) => i >= 80 ? 0 : step(t) });

test('a supported blue trend predicts a weak red tail without cropping or changing source values', () => {
  const input = weakTail(), before = structuredClone(input);
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2 });
  assert.equal(result.chirp.model.accepted, true, result.chirp.model.reason);
  assert.equal(result.chirp.model.fitRangeMode, 'auto-red-tail');
  assert.equal(result.chirp.model.extrapolation.validated, false);
  assert.equal(result.chirp.model.extrapolation.ranges[0].side, 'red');
  assert.ok(result.chirp.model.selectedDegree <= 2);
  assert.deepEqual(result.spectralAxis, input.spectralAxis);
  assert.deepEqual(result.timeAxis, input.timeAxis);
  assert.equal(result.matrix.length, input.matrix.length);
  assert.equal(result.chirp.curve.at(-1).support, 'predicted');
  assert.ok(Math.abs(result.chirp.curve.at(-1).shift - arrival(700)) < 0.015);
  assert.deepEqual(input, before);
});

test('an explicit calibration range fits only those rows and labels both predicted edges', () => {
  const input = chirpFixture({ count: 101, arrival });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2, fitRange: { min: 450, max: 640 } });
  assert.equal(result.chirp.model.accepted, true, result.chirp.model.reason);
  assert.deepEqual(result.chirp.model.extrapolation.ranges.map(r => r.side), ['blue', 'red']);
  assert.ok(result.chirp.model.anchors.every(a => input.spectralAxis[a.index] === a.wavelength));
  assert.equal(result.chirp.curve.length, 101);
  assert.equal(result.chirp.curve[0].support, 'predicted');
  assert.ok(Math.abs(result.chirp.curve.at(-1).shift - arrival(700)) < 0.015);
});

test('a tiny or malformed calibration range cannot authorize long-range extrapolation', () => {
  const input = chirpFixture({ count: 101, arrival });
  for (const fitRange of [{ min: 480, max: 550 }, { min: 600, max: 500 }, { min: 500, max: 501 }]) {
    const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2, fitRange });
    assert.equal(result.chirp.model.accepted, false);
    assert.deepEqual(result.matrix, input.matrix);
  }
});

test('a rapidly diverging quadratic tail is rejected even within the distance limit', () => {
  const input = chirpFixture({ count: 151, arrival: w => 0.1 + 0.4 * ((w - 500) / 100) ** 2 });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.3, fitRange: { min: 400, max: 600 } });
  assert.equal(result.chirp.model.accepted, false);
  assert.match(result.chirp.model.reason, /diverges/);
  assert.deepEqual(result.matrix, input.matrix);
});

test('conflicting measured red arrivals cannot be silently relabeled as a weak tail', () => {
  const input = chirpFixture({ count: 101, arrival: (w, i) => arrival(w) + (i >= 80 ? 0.7 : 0) });
  const result = estimateChirpModel(input, { approximateZeroTimePs: 0.2 });
  assert.equal(result.accepted, false);
  assert.equal(result.extrapolation, undefined);
});

test('even sparse contradictory red anchors require an explicit fitting-range choice', () => {
  const input = chirpFixture({ count: 101,
    arrival: (w, i) => arrival(w) + (i >= 99 ? 0.7 : 0),
    shape: (t, i) => i >= 80 && i < 99 ? 0 : step(t),
  });
  const automatic = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2 });
  assert.equal(automatic.chirp.model.accepted, false);
  assert.equal(automatic.chirp.model.outsideAnchorCheck.conflictingCount, 2);
  assert.match(automatic.chirp.model.reason, /prediction conflicts/);
  assert.deepEqual(automatic.matrix, input.matrix);
  const explicit = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2, fitRange: { min: 400, max: 637 } });
  assert.equal(explicit.chirp.model.accepted, true, explicit.chirp.model.reason);
  assert.equal(explicit.chirp.model.outsideAnchorCheck.conflictingCount, 2);
  assert.match(explicit.chirp.model.extrapolation.warning, /2 detected arrival anchors.*disagree/);
});

test('a bounded quadratic turnover is labeled as prediction, not forced monotone', () => {
  const curvedArrival = w => 0.3 - 0.08 * ((w - 620) / 100) ** 2;
  const input = chirpFixture({ count: 101, arrival: curvedArrival });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.2, fitRange: { min: 400, max: 640 } });
  assert.equal(result.chirp.model.accepted, true, result.chirp.model.reason);
  assert.equal(result.chirp.model.selectedDegree, 2);
  assert.equal(result.chirp.model.extrapolation.validated, false);
  assert.ok(Math.abs(result.chirp.curve.at(-1).shift - curvedArrival(700)) < 0.015);
  assert.ok(result.chirp.curve.at(-1).shift < result.chirp.curve[80].shift);
  assert.deepEqual(result.spectralAxis, input.spectralAxis);
});

test('an internal conflicting band remains blocked even with a weak red tail', () => {
  const input = chirpFixture({ count: 101, arrival: (w, i) => arrival(w) + (i >= 35 && i <= 55 ? 0.4 : 0), shape: (t, i) => i >= 80 ? 0 : step(t) });
  assert.equal(estimateChirpModel(input, { approximateZeroTimePs: 0.2 }).accepted, false);
});

test('predicted-region flags and the full treated matrix survive archive round-trip', () => {
  const text = chirpCsv(weakTail()), source = P.parseSpectroscopyCsv(text, 'weak-red.csv');
  source.rawText = text;
  const baseAnalysis = P.createAnalysisDataset(source);
  const analysis = P.applyChirpCorrection(baseAnalysis, { approximateZeroTimePs: 0.2 });
  const project = { schema: 'specflowlab.desktop_preview.v3', folders: [{ id: 'f' }], datasets: [{ id: 'd', folderId: 'f', source, baseAnalysis, analysis, fit: null, chirpSettings: { enabled: true, fitRange: null } }] };
  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), P).datasets[0];
  assert.deepEqual(restored.analysis.matrix, analysis.matrix);
  assert.deepEqual(restored.analysis.chirp, analysis.chirp);
  assert.deepEqual(restored.chirpSettings, project.datasets[0].chirpSettings);
});

test('AI preprocessing distinguishes predicted wavelengths from fitted wavelengths', async () => {
  const analysis = P.applyChirpCorrection(weakTail(), { approximateZeroTimePs: 0.2 });
  const project = { activeIndex: 0, folders: [{ id: 'f', name: 'Test' }], datasets: [{ id: 'd', folderId: 'f', projectLabel: 'Weak red', source: { fileName: 'synthetic.csv', metadata: {} }, analysis, fit: null }] };
  const output = await inspectAiInvestigation(project, { schema: 'specflowlab.ai_investigation_spec.v1', goal: 'preprocessing', question: 'Which regions are predicted?', scope: { kind: 'project' }, evidenceProfile: 'brief' });
  assert.deepEqual(output.errors, []);
  const csv = output.files.find(f => f.path.includes('preprocessing')).text;
  assert.match(csv, /chirp_predicted_ranges_nm_json/);
  assert.match(csv, /not independently validated/);
});
