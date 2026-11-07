// Read-only audit: no project, source, or matrix files are written.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import '../src/lib/parser-core.js';
import { readProjectArchive, hydrateProjectArchive } from '../src/lib/project-archive.js';
import { chirpCursorSeeds } from '../src/lib/treatment-plan.js';
import { treatmentStatus } from '../src/lib/treatment-status.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/audit-chirp-project.mjs /path/to/project.sflproj');
const bytes = await readFile(path);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const parser = globalThis.SpecFlowLabParser;
const project = hydrateProjectArchive(readProjectArchive(bytes), parser);
const datasets = project.datasets.map(dataset => {
  const input = structuredClone(dataset.baseAnalysis);
  const seeds = chirpCursorSeeds(dataset.analysis, project.state?.selectedTimeIndex ?? 0, project.state?.selectedWavelengthIndex ?? 0);
  const start = performance.now();
  const corrected = parser.applyAnalysisTreatments(dataset.baseAnalysis, {
    chirp: true, baseline: true, approximateZeroTimePs: seeds.time,
    referenceWavelength: seeds.wavelength,
  });
  const elapsedMs = performance.now() - start;
  assert.deepEqual(dataset.baseAnalysis, input, 'The input analysis must not be mutated.');
  const model = corrected.chirp.model;
  return {
    dataset: dataset.projectLabel, inputShape: [input.spectralAxis.length, input.timeAxis.length],
    previous: { status: treatmentStatus(dataset.analysis, 'Chirp'), reason: dataset.analysis.chirp?.model?.reason, heldOutP95Ps: dataset.analysis.chirp?.model?.heldOutP95 },
    revised: {
      status: treatmentStatus(corrected, 'Chirp'), baseline: treatmentStatus(corrected, 'Baseline'),
      reason: model.reason, algorithm: model.algorithm, polynomialDegree: model.selectedDegree,
      anchors: model.support, method: model.method, warnings: model.warnings, seedTimePs: model.seedTimePs, referenceWavelength: model.referenceWavelength,
      tolerancePs: model.alignmentTolerancePs, residualP95Ps: model.residualP95,
      searchWindowsPs: model.searchWindowsPs,
      selectedSearchWindowPs: model.selectedSearchWindowPs,
      inputFiniteCount: model.inputFiniteCount, outputFiniteCount: model.outputFiniteCount,
    },
    elapsedMs: Math.round(elapsedMs),
  };
});
const afterHash = sha256(await readFile(path));
assert.equal(afterHash, sha256(bytes), 'The on-disk input project changed during the audit.');
console.log(JSON.stringify({ sourceSha256: afterHash, inputUnchanged: true, datasets }, null, 2));
