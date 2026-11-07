import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import '../../src/lib/parser-core.js';
import { readProjectArchive, hydrateProjectArchive } from '../../src/lib/project-archive.js';
import { treatmentStatus } from '../../src/lib/treatment-status.js';
import { treatmentEnabled } from '../../src/lib/treatment-plan.js';

// Opt-in, read-only private project check.
const projectPath = process.env.SPECFLOWLAB_CHIRP_PROJECT;
test('folder correction applies and local retry survives archive reload', async ({ page }, testInfo) => {
  test.skip(!projectPath, 'Set SPECFLOWLAB_CHIRP_PROJECT to a local project.');
  const P = globalThis.SpecFlowLabParser;
  const originalBytes = await readFile(projectPath);
  const original = hydrateProjectArchive(readProjectArchive(originalBytes), P);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  async function save() {
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="save-project"]').click();
    const bytes = await readFile(await (await pending).path());
    return { bytes, project: hydrateProjectArchive(readProjectArchive(bytes), P) };
  }
  await page.goto('/');
  await page.locator('#project-input').setInputFiles(projectPath);
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  while (await page.locator('.folder-node.collapsed').count()) await page.locator('.folder-node.collapsed .folder-toggle').first().click();
  for (const folder of original.folders) {
    const dataset = original.datasets.find(item => item.folderId === folder.id);
    if (!dataset) continue;
    await page.locator(`.dataset-activate[data-dataset-id="${dataset.id}"]`).click();
    await page.locator('[data-action="chirp"]').click();
    await expect(page.locator('#chirp-scope')).toHaveValue('dataset');
    await page.screenshot({ path: testInfo.outputPath('chirp-dialog.png') });
    await page.locator('#chirp-scope').selectOption('folder');
    await page.locator('[data-action="confirm-chirp"]').click();
    await expect(page.locator('[data-action="chirp"]')).toBeEnabled();
  }
  await page.screenshot({ path: testInfo.outputPath('chirp-corrected-heatmap.png') });
  const first = (await save()).project;
  for (const before of original.datasets) {
    const after = first.datasets.find(item => item.id === before.id);
    expect(treatmentStatus(after.analysis, 'Chirp')).toBe('applied');
    expect(after.source.rawBytes).toEqual(before.source.rawBytes);
    expect(after.baseAnalysis.matrix).toEqual(before.baseAnalysis.matrix);
    const folder = first.folders.find(item => item.id === before.folderId);
    const expected = P.applyAnalysisTreatments(before.baseAnalysis, {
      chirp: true, baseline: treatmentEnabled(after, folder, 'baseline'),
      approximateZeroTimePs: folder.chirpZeroTimePs, referenceWavelength: folder.chirpReferenceWavelength,
    });
    expect(after.analysis.timeAxis).toEqual(expected.timeAxis);
    expect(after.analysis.spectralAxis).toEqual(expected.spectralAxis);
    expect(after.analysis.matrix.length).toBe(expected.matrix.length);
    let maxDifference = 0, maskMismatches = 0;
    after.analysis.matrix.forEach((row, i) => {
      expect(row.length).toBe(expected.matrix[i].length);
      row.forEach((value, j) => {
        const reference = expected.matrix[i][j];
        if (Number.isFinite(value) !== Number.isFinite(reference)) maskMismatches++;
        else if (Number.isFinite(value)) maxDifference = Math.max(maxDifference, Math.abs(value - reference));
      });
    });
    expect(maskMismatches).toBe(0);
    expect(maxDifference).toBeLessThan(1e-12);
  }
  const target = first.datasets[0];
  await page.locator(`.dataset-activate[data-dataset-id="${target.id}"]`).click();
  await page.locator('[data-action="chirp"]').click();
  const oldRef = Number(await page.locator('#chirp-reference').inputValue());
  await page.locator('#chirp-reference').fill(String(oldRef + 10));
  await page.locator('[data-action="confirm-chirp"]').click();
  const { bytes, project: retry } = await save();
  expect(retry.datasets[0].chirpSettings.referenceWavelength).toBe(oldRef + 10);
  expect(retry.datasets[0].fit).toBeNull();
  for (const sibling of first.datasets.slice(1)) {
    const after = retry.datasets.find(d => d.id === sibling.id);
    expect(after.analysis).toEqual(sibling.analysis);
    expect(after.fit).toEqual(sibling.fit);
  }
  await page.locator('#project-input').setInputFiles({ name: 'reopened.sflproj', mimeType: 'application/zip', buffer: bytes });
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  const reopened = await save();
  expect(reopened.project.datasets[0].chirpSettings.referenceWavelength).toBe(oldRef + 10);
  expect(digest(await readFile(projectPath))).toBe(digest(originalBytes));
});
