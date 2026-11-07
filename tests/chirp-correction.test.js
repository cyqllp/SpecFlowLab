import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/lib/parser-core.js';
import { chirpFixture, chirpCsv } from './chirp-fixture.js';
import { treatmentStatus, analysisNeedsReview, isAnalysisTreated } from '../src/lib/treatment-status.js';
import { isEligibleForMode } from '../src/lib/dataset-selection.js';
import { inspectAiInvestigation } from '../src/lib/ai-investigation/package.js';
import { createProjectArchive, readProjectArchive, hydrateProjectArchive } from '../src/lib/project-archive.js';

const P = globalThis.SpecFlowLabParser;
const quadratic = w => 0.1 + 0.8 * ((w - 550) / 150) ** 2;
function accepted(result) {
  assert.equal(treatmentStatus(result, 'Chirp'), 'applied', result.chirp?.model.reason);
  assert.equal(result.chirp.model.accepted, true);
}
function error(result, arrival, target = 0) {
  return Math.max(...result.chirp.curve.map(p => Math.abs(p.shift - (arrival(p.wavelength) - target))));
}

test('quadratic chirp recovers known arrival times and validates the applied free-intercept model', () => {
  const input = chirpFixture({ arrival: quadratic });
  const before = structuredClone(input);
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.5 });
  accepted(result);
  assert.ok(error(result, quadratic) < 0.015, `timing error ${error(result, quadratic)} ps`);
  assert.ok(Math.abs(result.chirp.model.referenceTime - 0.1) < 0.01);
  assert.ok(result.chirp.model.residualP95 <= result.chirp.model.alignmentTolerancePs);
  assert.equal(result.chirp.model.heldOutCount, result.chirp.model.support);
  assert.deepEqual(input, before);
});

test('cubic chirp with alternating signal signs and deterministic noise is recovered', () => {
  const arrival = w => { const x = (w - 550) / 150; return 0.1 + 0.2 * x + 0.1 * x * x + 0.1 * x ** 3; };
  const input = chirpFixture({ arrival, shape: (t, i, j) => (i % 2 ? -1 : 1) * (0.5 * (1 + Math.tanh(t / 0.03))) + 0.0002 * Math.sin(i * 5 + j * 7) });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.1 });
  accepted(result);
  assert.ok(error(result, arrival) < 0.02);
});

test('a short but valid negative-time baseline is accepted', () => {
  const result = P.applyChirpCorrection(chirpFixture({ start: -1 }), { approximateZeroTimePs: 0 });
  accepted(result);
  assert.ok(error(result, () => 0) < 0.01);
});

test('nonuniform acquisition times retain accurate shifts without changing the output axis', () => {
  const input = chirpFixture({ arrival: quadratic });
  const selected = input.timeAxis.flatMap((t, i) => t < -1 || t > 1.2 ? (i % 10 === 0 ? [i] : []) : [i]);
  input.timeAxis = selected.map(i => input.timeAxis[i]);
  input.matrix = input.matrix.map(row => selected.map(i => row[i]));
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0.5 });
  accepted(result);
  assert.deepEqual(result.timeAxis, input.timeAxis);
  assert.ok(error(result, quadratic) < 0.015);
});

test('a truly absent baseline stays unchanged and fails qualification', () => {
  const input = chirpFixture({ missing: (_i, _j, t) => t < -0.05 });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0 });
  assert.equal(treatmentStatus(result, 'Chirp'), 'skipped');
  assert.equal(result.chirp.model.heldOutAgreement, false);
  assert.deepEqual(result.matrix, input.matrix);
  assert.equal(isAnalysisTreated(result), false);
});

test('search expands when the first window contains no edge', () => {
  const result = P.applyChirpCorrection(chirpFixture({ arrival: () => 0.8, shape: t => t >= 0 ? 1 : 0 }), { approximateZeroTimePs: 0 });
  accepted(result);
  assert.equal(result.chirp.model.searchWindowsPs.length, 5);
  assert.deepEqual(result.chirp.model.selectedSearchWindowPs, [-1, 1]);
  assert.ok(error(result, () => 0.8) < 0.015);
});

test('non-polynomial wavelength jumps are rejected despite strong signal', () => {
  const input = chirpFixture({ arrival: (_w, i) => i % 2 ? -0.3 : 0.3 });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 0 });
  assert.equal(result.chirp.model.accepted, false);
  assert.deepEqual(result.matrix, input.matrix);
});

test('each dataset aligns to the same explicit physical target', () => {
  const results = P.applySharedChirpCorrection([0.8, 1.1].map(t => chirpFixture({ arrival: () => t })), { approximateZeroTimePs: 1, targetReferenceTime: 0.2 });
  results.forEach((result, i) => {
    accepted(result);
    assert.ok(error(result, () => [0.8, 1.1][i], 0.2) < 0.015);
  });
});

test('baseline follows the corrected time zero instead of subtracting early signal', () => {
  const input = chirpFixture({ arrival: () => -0.5 });
  const before = structuredClone(input);
  const result = P.applyAnalysisTreatments(input, { chirp: true, baseline: true, approximateZeroTimePs: -0.5 });
  accepted(result);
  assert.equal(treatmentStatus(result, 'Baseline'), 'applied');
  assert.deepEqual(result.provenance.map(p => p.label), ['Chirp', 'Baseline']);
  const pre = result.timeAxis.findIndex(t => t >= -1), post = result.timeAxis.findIndex(t => t >= 1);
  assert.ok(Math.abs(result.matrix[0][pre]) < 1e-5);
  assert.ok(Math.abs(result.matrix[0][post] - 1) < 1e-5);
  assert.deepEqual(input, before);
  assert.deepEqual(P.applyAnalysisTreatments(input, { chirp: true, baseline: true, approximateZeroTimePs: -0.5 }).matrix, result.matrix);
});

test('baseline is skipped when a requested chirp cannot establish time zero', () => {
  const input = chirpFixture({ shape: () => 0 });
  const result = P.applyAnalysisTreatments(input, { chirp: true, baseline: true, approximateZeroTimePs: 0 });
  assert.equal(treatmentStatus(result, 'Baseline'), 'skipped');
  assert.deepEqual(result.matrix, input.matrix);
});

test('baseline without finite pre-zero samples does not subtract signal or claim success', () => {
  for (const input of [chirpFixture({ start: 0 }), chirpFixture({ missing: (i, _j, t) => i === 0 && t < 0 })]) {
    const result = P.applyBaselineCorrection(input);
    assert.equal(treatmentStatus(result, 'Baseline'), 'skipped');
    assert.deepEqual(result.matrix, input.matrix);
  }
});

test('a shift outside the output range preserves the input instead of creating an all-NaN matrix', () => {
  const input = chirpFixture({ start: 40, end: 60, dt: 0.02, arrival: () => 50 });
  const result = P.applyChirpCorrection(input, { approximateZeroTimePs: 50 });
  assert.equal(treatmentStatus(result, 'Chirp'), 'skipped');
  assert.match(result.chirp.model.reason, /outside the output time range/);
  assert.deepEqual(result.matrix, input.matrix);
});

test('zero shifts preserve finite samples immediately after missing data', () => {
  const input = chirpFixture({ dt: 0.125, missing: (_i, j) => j === 4 });
  const result = P.applyChirpCorrection(input, { model: { referenceWavelength: 550, referenceTime: 0, coefficients: [0, 0, 0] } });
  assert.deepEqual(result.matrix, input.matrix);
});

test('an explicit shift with no measured overlap cannot replace the matrix with NaNs', () => {
  const input = chirpFixture();
  const result = P.applyChirpCorrection(input, { model: { referenceWavelength: 550, referenceTime: 100, coefficients: [0, 0, 0] } });
  assert.equal(treatmentStatus(result, 'Chirp'), 'skipped');
  assert.match(result.chirp.model.reason, /insufficient measured time support/);
  assert.deepEqual(result.matrix, input.matrix);
});

test('fractional shifts retain missing brackets and never extrapolate', () => {
  const input = chirpFixture({ dt: 0.125, missing: (_i, j) => j === 4 });
  const result = P.applyChirpCorrection(input, { model: { referenceWavelength: 550, referenceTime: 0.0625, coefficients: [0, 0, 0] } });
  assert.ok(Number.isNaN(result.matrix[0][3]));
  assert.ok(Number.isNaN(result.matrix[0][4]));
  assert.ok(Number.isFinite(result.matrix[0][5]));
  assert.ok(Number.isNaN(result.matrix[0].at(-1)));
});

test('skipped and retained-review treatments cannot enter the merge workflow', () => {
  for (const analysis of [
    { provenance: [{ label: 'Chirp', status: 'skipped' }] },
    { provenance: [{ label: 'Baseline', status: 'applied' }, { label: 'Chirp', status: 'skipped' }] },
    { provenance: [{ label: 'Chirp', status: 'applied' }, { label: 'Chirp review', status: 'review-required' }] },
  ]) {
    assert.equal(analysisNeedsReview(analysis), true);
    assert.equal(isEligibleForMode({ analysis }, 'merge'), false);
  }
  const retried = { provenance: [{ label: 'Chirp review', status: 'review-required' }, { label: 'Chirp', status: 'applied' }] };
  assert.equal(treatmentStatus(retried, 'Chirp'), 'applied');
});

test('AI preprocessing exports a rejected chirp as skipped', async () => {
  const analysis = P.applyChirpCorrection(chirpFixture({ shape: () => 0 }), { approximateZeroTimePs: 0 });
  const project = { activeIndex: 0, folders: [{ id: 'f', name: 'Test' }], datasets: [{ id: 'd', folderId: 'f', projectLabel: 'Rejected', source: { fileName: 'synthetic.csv', metadata: {} }, analysis, fit: null }] };
  const inspection = await inspectAiInvestigation(project, { schema: 'specflowlab.ai_investigation_spec.v1', goal: 'preprocessing', question: 'Was chirp applied?', scope: { kind: 'project' }, evidenceProfile: 'brief' });
  assert.deepEqual(inspection.errors, []);
  const csv = inspection.files.find(file => file.path.includes('preprocessing')).text;
  assert.match(csv, /"skipped","Chirp:skipped"/);
  assert.doesNotMatch(csv, /"applied"/);
});

test('legacy AI summary reports the current review reason when an older correction is retained', () => {
  const source = P.parseSpectroscopyCsv(chirpCsv(chirpFixture({ count: 12, dt: 0.05 })), 'review.csv');
  const analysis = P.applyChirpCorrection(P.createAnalysisDataset(source), { approximateZeroTimePs: 0 });
  accepted(analysis);
  analysis.provenance.push({ label: 'Chirp review', status: 'review-required', reason: 'The new arrival hint failed; the previous correction was retained.' });
  const fit = P.fitGlobalExponentials(analysis, 1, { lifetimes: [10], fixedLifetimes: [true], irfFwhm: 0 });
  const summary = P.buildAiReadySummary(source, analysis, { fit });
  assert.equal(summary.json.preprocessing.chirp.status, 'review-required');
  assert.match(summary.json.preprocessing.chirp.reason, /new arrival hint failed/);
  assert.ok(summary.json.ai_handoff.uncertainty_notes.some(note => note.includes('requires review')));
});

test('accepted chirp and baseline matrices and diagnostics survive archive round-trip', () => {
  const raw = chirpFixture({ arrival: quadratic });
  const rawText = chirpCsv(raw);
  const source = P.parseSpectroscopyCsv(rawText, 'chirp.csv');
  source.rawText = rawText;
  const baseAnalysis = P.createAnalysisDataset(source);
  const analysis = P.applyAnalysisTreatments(baseAnalysis, { chirp: true, baseline: true, approximateZeroTimePs: 0.5 });
  accepted(analysis);
  const project = { schema: 'specflowlab.desktop_preview.v3', folders: [{ id: 'f', chirpZeroTimePs: 0.5 }], datasets: [{ id: 'd', folderId: 'f', source, baseAnalysis, analysis, fit: null }] };
  project.datasets[0].chirpSettings = { enabled: true, approximateZeroTimePs: 0.5 };
  const restored = hydrateProjectArchive(readProjectArchive(createProjectArchive(project)), P);
  assert.deepEqual(restored.datasets[0].analysis.matrix, analysis.matrix);
  assert.deepEqual(restored.datasets[0].analysis.chirp, analysis.chirp);
  assert.equal(restored.folders[0].chirpZeroTimePs, 0.5);
  assert.deepEqual(restored.datasets[0].chirpSettings, project.datasets[0].chirpSettings);
});
