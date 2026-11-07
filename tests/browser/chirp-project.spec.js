import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import '../../src/lib/parser-core.js';
import { readProjectArchive, hydrateProjectArchive } from '../../src/lib/project-archive.js';
import { treatmentStatus } from '../../src/lib/treatment-status.js';

// Opt-in private-data check; neither the path nor measurements enter the repo.
const projectPath = process.env.SPECFLOWLAB_CHIRP_PROJECT;
test('real project folder correction preserves sources and materializes qualified results', async ({ page }, testInfo) => {
  test.skip(!projectPath, 'Set SPECFLOWLAB_CHIRP_PROJECT to a local .sflproj for this read-only integration check.');
  const P = globalThis.SpecFlowLabParser;
  const originalBytes = await readFile(projectPath);
  const original = hydrateProjectArchive(readProjectArchive(originalBytes), P);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  await page.setViewportSize({ width: 1480, height: 920 });
  await page.goto('/');
  await page.locator('#project-input').setInputFiles(projectPath);
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  while (await page.locator('.folder-node.collapsed').count()) await page.locator('.folder-node.collapsed .folder-toggle').first().click();
  for (const folder of original.folders) {
    const dataset = original.datasets.find(item => item.folderId === folder.id);
    await page.locator(`.dataset-activate[data-dataset-id="${dataset.id}"]`).click();
    await page.locator('[data-action="chirp"]').click();
    await page.locator('#chirp-scope').selectOption('folder');
    await page.locator('#chirp-zero-time').fill(String(folder.chirpZeroTimePs));
    await page.locator('[data-action="confirm-chirp"]').click();
    await expect(page.locator('[data-action="chirp"]')).toBeEnabled();
  }
  const pending = page.waitForEvent('download');
  await page.locator('[data-action="save-project"]').click();
  let saved = hydrateProjectArchive(readProjectArchive(await readFile(await (await pending).path())), P);
  for (const before of original.datasets) {
    const after = saved.datasets.find(item => item.id === before.id);
    const folder = original.folders.find(item => item.id === before.folderId);
    const recalculated = P.applyAnalysisTreatments(before.baseAnalysis, { chirp: true, baseline: folder.treatments.baseline, approximateZeroTimePs: folder.chirpZeroTimePs });
    const retainsPrevious = treatmentStatus(recalculated, 'Chirp') === 'skipped' && treatmentStatus(before.analysis, 'Chirp') === 'applied';
    const expectedMatrix = retainsPrevious ? before.analysis.matrix : recalculated.matrix;
    // Node and Chromium can differ in transcendental last bits. Preserve the
    // missing-value mask exactly and compare recomputations numerically.
    let maxDifference = 0, maskMismatches = 0;
    expect(after.analysis.matrix.length).toBe(expectedMatrix.length);
    after.analysis.matrix.forEach((row, i) => {
      expect(row.length).toBe(expectedMatrix[i].length);
      row.forEach((value, j) => {
        const expected = expectedMatrix[i][j];
        if (Number.isFinite(value) !== Number.isFinite(expected)) maskMismatches++;
        else if (Number.isFinite(value)) maxDifference = Math.max(maxDifference, Math.abs(value - expected));
      });
    });
    expect(maskMismatches, `${before.projectLabel}: missing-value mask`).toBe(0);
    expect(maxDifference, `${before.projectLabel}: matrix recomputation`).toBeLessThan(retainsPrevious ? Number.MIN_VALUE : 1e-12);
    expect(treatmentStatus(after.analysis, 'Chirp')).toBe(retainsPrevious ? 'review-required' : treatmentStatus(recalculated, 'Chirp'));
    expect(after.source.rawBytes).toEqual(before.source.rawBytes);
    expect(after.baseAnalysis.matrix).toEqual(before.baseAnalysis.matrix);
    if (retainsPrevious) expect(after.analysis.provenance.at(-1).attemptedModel.algorithm).toBe(recalculated.chirp.model.algorithm);
  }
  // A calibration range can recover a dataset without cropping the displayed
  // matrix. This remains opt-in and checks no sample-specific names into git.
  const manuals = original.datasets.filter(dataset => {
    if (treatmentStatus(saved.datasets.find(d => d.id === dataset.id).analysis, 'Chirp') === 'applied') return false;
    const hint = original.folders.find(f => f.id === dataset.folderId).chirpZeroTimePs;
    return P.applyChirpCorrection(dataset.baseAnalysis, { approximateZeroTimePs: hint, fitRange: { min: 400, max: 700 } }).chirp.model.accepted;
  });
  for (const [manualIndex, manual] of manuals.entries()) {
    await page.locator(`.dataset-activate[data-dataset-id="${manual.id}"]`).click();
    await page.locator('[data-action="chirp"]').click();
    await page.locator('#chirp-scope').selectOption('dataset');
    await page.locator('.chirp-fitting-range summary').click();
    await page.locator('#chirp-fit-min').fill('400');
    await page.locator('#chirp-fit-max').fill('700');
    await page.locator('[data-action="confirm-chirp"]').click();
    await expect(page.locator('[data-action="chirp"]')).toHaveText('Chirp · Predicted');
    const download = page.waitForEvent('download');
    await page.locator('[data-action="save-project"]').click();
    const bytes = await readFile(await (await download).path());
    const revised = hydrateProjectArchive(readProjectArchive(bytes), P);
    const corrected = revised.datasets.find(d => d.id === manual.id);
    expect(corrected.analysis.spectralAxis).toEqual(manual.analysis.spectralAxis);
    expect(corrected.analysis.matrix.length).toBe(manual.analysis.matrix.length);
    expect(corrected.chirpSettings.fitRange).toEqual({ min: 400, max: 700 });
    expect(corrected.analysis.chirp.model.extrapolation.validated).toBe(false);
    expect(corrected.analysis.chirp.curve.at(-1).support).toBe('predicted');
    for (const sibling of saved.datasets.filter(d => d.id !== manual.id)) {
      expect(digest(Buffer.from(new Float64Array(revised.datasets.find(d => d.id === sibling.id).analysis.matrix.flat()).buffer))).toBe(digest(Buffer.from(new Float64Array(sibling.analysis.matrix.flat()).buffer)));
    }
    await page.locator('#project-input').setInputFiles({ name: 'prediction-check.sflproj', mimeType: 'application/zip', buffer: bytes });
    await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
    await expect(page.locator('[data-action="chirp"]')).toHaveText('Chirp · Predicted');
    await page.screenshot({ path: testInfo.outputPath(`real-project-chirp-prediction-${manualIndex}.png`) });
    await page.locator('[data-action="chirp"]').click();
    await expect(page.locator('#chirp-fit-min')).toHaveValue('400');
    await expect(page.locator('#chirp-fit-max')).toHaveValue('700');
    await expect(page.locator('.chirp-prediction-note')).toContainText('not independently validated');
    if (corrected.analysis.chirp.model.outsideAnchorCheck.conflictingCount) {
      await expect(page.locator('.chirp-prediction-note')).toContainText('disagree with this prediction');
    }
    await page.locator('.modal-shell [data-action="close-modal"]').last().click();
    saved = revised;
  }
  const review = saved.datasets.find(item => treatmentStatus(item.analysis, 'Chirp') === 'skipped');
  if (review) {
    await page.locator(`.dataset-activate[data-dataset-id="${review.id}"]`).click();
    await page.locator('[data-action="chirp"]').click();
    await page.locator('.chirp-diagnostics summary').click();
    await page.screenshot({ path: testInfo.outputPath('real-project-chirp-diagnostics.png') });
  }
  expect(digest(await readFile(projectPath))).toBe(digest(originalBytes));
});
