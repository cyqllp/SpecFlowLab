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

test('full treated matrix and chirp metadata survive archive round-trip', () => {
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
