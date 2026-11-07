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

test('rejected chirp is visibly skipped, survives reload, and range changes retain warnings', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('flat.csv', { shape: () => 0 }));
  await applyChirp(page, 0);
  const button = page.locator('[data-action="chirp"]');
  await expect(button).not.toHaveClass(/active/);
  await expect(button).toHaveText('Chirp · Review');
  await expect(page.locator('.feedback.warning')).toContainText('Review required');
  await expect(page.locator('.project-panel dd').nth(1)).toHaveText('0');
  await page.setViewportSize({ width: 960, height: 640 });
  expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 720 });
  const { bytes, project } = await savedProject(page);
  expect(treatmentStatus(project.datasets[0].analysis, 'Chirp')).toBe('skipped');
  expect(project.datasets[0].analysis.matrix).toEqual(project.datasets[0].baseAnalysis.matrix);
  await page.locator('#project-input').setInputFiles({ name: 'rejected.sflproj', mimeType: 'application/zip', buffer: bytes });
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  await expect(button).toHaveText('Chirp · Review');
  await page.locator('[data-action="apply-range"]').click();
  await expect(page.locator('.feedback.warning')).toContainText('Review required');
  await button.click();
  await expect(page.locator('.modal-shell [role="status"]')).toContainText('Insufficient');
  await page.locator('[data-action="disable-chirp"]').click();
  await expect(button).toHaveText('Chirp');
  expect(treatmentStatus((await savedProject(page)).project.datasets[0].analysis, 'Chirp')).toBe('not-recorded');
});

test('a rejected hint can be retried without turning the requested correction off', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('delayed.csv', { arrival: () => 0.8, shape: t => t >= 0 ? 1 : 0 }));
  await applyChirp(page, -3);
  await expect(page.locator('[data-action="chirp"]')).toHaveText('Chirp · Review');
  await applyChirp(page, 0);
  await expect(page.locator('[data-action="chirp"]')).toHaveClass(/active/);
  await expect(page.locator('.feedback.success')).toContainText('Completed');
  const { project } = await savedProject(page);
  expect(project.folders.find(f => f.id === project.datasets[0].folderId).chirpZeroTimePs).toBe(-3);
  expect(project.datasets[0].chirpSettings.approximateZeroTimePs).toBe(0);
  const analysis = project.datasets[0].analysis;
  expect(treatmentStatus(analysis, 'Chirp')).toBe('applied');
  expect(analysis.chirp.model.searchWindowsPs).toHaveLength(5);
  expect(Math.abs(analysis.chirp.curve[0].shift - 0.8)).toBeLessThan(0.03);
});

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

test('reset and retry preserve unaffected folder data, and a failed new hint retains accepted data and fit', async ({ page }) => {
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
  // Folder changes remain available as an explicit, separate choice.
  await applyChirp(page, -2, 'folder');
  await expect(page.locator('.feedback.warning')).toContainText('previous accepted correction');
  const failed = (await savedProject(page)).project.datasets;
  expect(failed[0].analysis.matrix).toEqual(before.analysis.matrix);
  expect(failed[0].fit).toEqual(before.fit);
  expect(treatmentStatus(failed[0].analysis, 'Chirp')).toBe('review-required');
  expect(treatmentStatus(failed[1].analysis, 'Chirp')).toBe('skipped');
  await rows.nth(0).click();
  await page.locator('[data-action="chirp"]').click();
  await expect(page.locator('.modal-shell [role="status"]')).toContainText('previous accepted correction');
});

test('chirp failure reason is not hidden by baseline skip and persists after reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('flat.csv', { shape: () => 0 }));
  await page.locator('[data-action="baseline"]').click();
  await applyChirp(page, 0, 'dataset');
  await expect(page.locator('.feedback.warning')).toContainText('Insufficient');
  await expect(page.locator('.feedback.warning')).not.toContainText('Resolve chirp time zero');
  const { bytes } = await savedProject(page);
  await page.locator('#project-input').setInputFiles({ name: 'local-retry.sflproj', mimeType: 'application/zip', buffer: bytes });
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  await page.locator('[data-action="chirp"]').click();
  await expect(page.locator('#chirp-scope')).toHaveValue('dataset');
  await expect(page.locator('.modal-shell [role="status"]')).toContainText('Insufficient');
  await expect(page.locator('[data-action="disable-chirp"]')).toBeVisible();
  await page.locator('.chirp-diagnostics summary').click();
  await expect(page.locator('.chirp-diagnostics')).toContainText('Signal anchors');
});

test('resizing preserves the selected chirp scope and edited hint after focus moves', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('scope.csv'));
  await page.locator('[data-action="chirp"]').click();
  await page.locator('#chirp-scope').selectOption('dataset');
  await page.locator('#chirp-zero-time').fill('0.1234');
  await page.locator('.chirp-fitting-range summary').click();
  await page.locator('#chirp-fit-min').fill('420');
  await page.locator('#chirp-fit-max').fill('650');
  await page.locator('[data-action="confirm-chirp"]').focus();
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(page.locator('#chirp-scope')).toHaveValue('dataset');
  await expect(page.locator('#chirp-zero-time')).toHaveValue('0.1234');
  await expect(page.locator('#chirp-fit-min')).toHaveValue('420');
  await expect(page.locator('#chirp-fit-max')).toHaveValue('650');
  await page.locator('.modal-shell [data-action="close-modal"]').last().click();
  await expect(page.locator('[data-action="chirp"]')).not.toHaveClass(/active/);
});
