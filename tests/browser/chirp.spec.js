import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import '../../src/lib/parser-core.js';
import { chirpFixture, chirpCsv } from '../chirp-fixture.js';
import { readProjectArchive, hydrateProjectArchive } from '../../src/lib/project-archive.js';
import { treatmentStatus } from '../../src/lib/treatment-status.js';

const P = globalThis.SpecFlowLabParser;
const fixture = (name, options = {}) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(chirpCsv(chirpFixture({ count: 17, dt: 0.025, ...options }))) });
async function applyChirp(page, hint, scope) {
  await page.locator('[data-action="chirp"]').click();
  if (scope) await page.locator('#chirp-scope').selectOption(scope);
  await page.locator('#chirp-zero-time').fill(String(hint));
  await page.locator('[data-action="confirm-chirp"]').click();
  await expect(page.locator('[data-action="chirp"]')).toBeEnabled();
}
async function savedProject(page) {
  const pending = page.waitForEvent('download');
  await page.locator('[data-action="save-project"]').click();
  const bytes = await readFile(await (await pending).path());
  return { bytes, project: hydrateProjectArchive(readProjectArchive(bytes), P) };
}

test('enabling chirp after baseline rebuilds from source and preserves negative-onset amplitude', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('early.csv', { arrival: () => -0.5 }));
  await page.locator('[data-action="baseline"]').click();
  await expect(page.locator('[data-action="baseline"]')).toHaveClass(/active/);
  await applyChirp(page, -0.5);
  await expect(page.locator('[data-action="chirp"]')).toHaveClass(/active/);
  const { project } = await savedProject(page);
  const { analysis, baseAnalysis } = project.datasets[0];
  expect(analysis.provenance.map(p => p.label)).toEqual(['Chirp', 'Baseline']);
  expect(analysis.matrix[0][analysis.timeAxis.findIndex(t => t >= -1)]).toBeCloseTo(0, 5);
  expect(analysis.matrix[0][analysis.timeAxis.findIndex(t => t >= 1)]).toBeCloseTo(1, 5);
  expect(baseAnalysis.matrix[0][baseAnalysis.timeAxis.findIndex(t => t >= -0.25)]).toBeCloseTo(1, 5);
});

test('dataset retry preserves sibling analysis and fit', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(['a.csv', 'b.csv'].map(name => fixture(name, { arrival: () => 0.1 })));
  const rows = page.locator('.dataset-activate');
  await rows.nth(0).click();
  await applyChirp(page, 0.1);
  await page.locator('[data-action="global-fit"]').click();
  await page.locator('#fit-components').selectOption('1');
  await page.locator('.fit-numerical-model summary').click();
  await page.locator('#fit-range-sensitivity').uncheck();
  await page.locator('[data-action="run-fit"]').click();
  await expect(page.locator('.fit-diagnostic-grid')).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('Escape');
  const before = (await savedProject(page)).project.datasets[0];
  expect(before.fit).toBeTruthy();

  await rows.nth(1).click();
  await page.locator('[data-action="reset-dataset"]').click();
  await expect(page.locator('[data-action="chirp"]')).not.toHaveClass(/active/);
  await applyChirp(page, 0.1);
  await expect(page.locator('[data-action="chirp"]')).toHaveClass(/active/);
  const afterRetry = (await savedProject(page)).project.datasets[0];
  expect(afterRetry.analysis).toEqual(before.analysis);
  expect(afterRetry.fit).toEqual(before.fit);

  await page.locator('[data-action="reset-dataset"]').click();
  // A different local hint must not re-fit the already successful sibling.
  await applyChirp(page, -2, 'dataset');
  const localRetry = (await savedProject(page)).project;
  expect(localRetry.datasets[0].analysis).toEqual(before.analysis);
  expect(localRetry.datasets[0].fit).toEqual(before.fit);
  expect(localRetry.datasets[1].chirpSettings.approximateZeroTimePs).toBe(-2);
  await rows.nth(0).click();
  await applyChirp(page, 0.1, 'dataset');
  const ownRetry = (await savedProject(page)).project.datasets[0];
  expect(ownRetry.fit).toBeNull();
});

test('resizing preserves the selected chirp scope and edited hint after focus moves', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('scope.csv'));
  await page.locator('[data-action="chirp"]').click();
  await page.locator('#chirp-scope').selectOption('dataset');
  await page.locator('#chirp-zero-time').fill('0.1234');
  await page.locator('#chirp-reference').fill('620');
  await page.locator('[data-action="confirm-chirp"]').focus();
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(page.locator('#chirp-scope')).toHaveValue('dataset');
  await expect(page.locator('#chirp-zero-time')).toHaveValue('0.1234');
  await expect(page.locator('#chirp-reference')).toHaveValue('620');
  await page.locator('.modal-shell [data-action="close-modal"]').last().click();
  await expect(page.locator('[data-action="chirp"]')).not.toHaveClass(/active/);
});
