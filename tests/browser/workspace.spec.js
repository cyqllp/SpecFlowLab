import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildUfsFixture } from '../ufs-fixture.js';

const sample = { name: 'fixture.ufs', mimeType: 'application/octet-stream', buffer: Buffer.from(buildUfsFixture()) };
for (const [width, height] of [[960,640], [1024,768], [1220,760], [1366,768], [1480,920]]) {
  test(`import and plot interaction at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    if (width <= 1200) await page.locator('.navigation-toggle').click();
    await page.locator('#file-input').setInputFiles(sample);
    await expect(page.locator('#heatmap')).toBeVisible();
    if (width <= 1200) await page.locator('.navigation-toggle').click();
    const heatmap = page.locator('#heatmap');
    const box = await heatmap.boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 5 });
    await page.mouse.up();
    await page.setViewportSize({ width: width + 40, height });
    await page.locator('[data-action="enlarge-plot"][data-plot-key="spectrum"]').click();
    await expect(page.locator('#expanded-canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}

test('replacement cancel preserves dirty project', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(sample);
  await expect(page.locator('#heatmap')).toBeVisible();
  await page.locator('#project-input').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.locator('.unsaved-dialog button[value="cancel"]').click();
  await expect(page.locator('#heatmap')).toBeVisible();
  await expect(page.locator('.project-panel .state-label')).toContainText('Unsaved');
});

test('save and discard decisions allow opening a valid project', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(sample);
  await expect(page.locator('#heatmap')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="save-project"]').click();
  const download = await downloadPromise;
  const savedProject = { name: 'saved.sflproj', mimeType: 'application/zip', buffer: await readFile(await download.path()) };
  await page.locator('#file-input').setInputFiles({ ...sample, name: 'second.ufs' });
  await expect(page.locator('.project-panel .state-label')).toContainText('Modified');
  await page.locator('#project-input').setInputFiles(savedProject);
  const saveDownload = page.waitForEvent('download');
  await page.locator('.unsaved-dialog button[value="save"]').click();
  await saveDownload;
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
  await expect(page.locator('.project-panel dd').first()).toHaveText('1');
  await page.locator('#file-input').setInputFiles({ ...sample, name: 'third.ufs' });
  await expect(page.locator('.project-panel .state-label')).toContainText('Modified');
  await page.locator('#project-input').setInputFiles(savedProject);
  await page.locator('.unsaved-dialog button[value="discard"]').click();
  await expect(page.locator('.project-panel .state-label')).toContainText('Saved');
});

for (const [width, height] of [[960,640], [1024,768], [1220,760], [1366,768], [1480,920]]) {
  test(`fit dialog controls and focus at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    if (width <= 1200) await page.locator('.navigation-toggle').click();
    await page.locator('#file-input').setInputFiles(sample);
    if (width <= 1200) await page.locator('.navigation-toggle').click();
    const trigger = page.locator('[data-action="global-fit"]');
    await trigger.click();
    const dialog = page.locator('.fit-modal');
    await expect(dialog.locator('#fit-components')).toBeVisible();
    await expect(dialog.locator('#fit-irf')).toBeVisible();
    await expect(dialog.locator('[data-action="run-fit"]')).toBeInViewport();
    await expect(dialog.locator('[role="status"]')).toBeInViewport();
    const label = dialog.locator('[data-action="reset-fit-parameters"]');
    expect(await label.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await dialog.locator('#fit-irf').focus();
    await page.setViewportSize({ width: width + 10, height });
    await expect(dialog.locator('#fit-irf')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test('navigation rerender preserves workspace scroll and focused field', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('/');
  await page.locator('.navigation-toggle').click();
  await page.locator('#file-input').setInputFiles(sample);
  await page.locator('.navigation-toggle').click();
  const workspace = page.locator('.workspace');
  await workspace.evaluate(el => { el.scrollTop = 250; });
  const before = await workspace.evaluate(el => el.scrollTop);
  await page.locator('.navigation-toggle').click();
  expect(await workspace.evaluate(el => el.scrollTop)).toBe(before);
  await expect(page.locator('.navigation-toggle')).toBeFocused();
});

test('Chinese unsaved guard is localized and keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await page.locator('#language-select').selectOption('zh-CN');
  await page.locator('#file-input').setInputFiles(sample);
  await expect(page.locator('#heatmap')).toBeVisible();
  await page.locator('#project-input').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  const dialog = page.locator('.unsaved-dialog');
  await expect(dialog).toContainText('未保存的更改');
  await expect(dialog.locator('[value="discard"]')).toHaveText('不保存');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#heatmap')).toBeVisible();
});

test('completed fit keeps diagnostic scroll through mode switches and rerenders', async ({ page }) => {
  const spectralAxis = Array.from({ length: 25 }, (_, i) => 450 + i * 10);
  const timeAxis = Array.from({ length: 45 }, (_, i) => i * 0.4);
  const matrix = spectralAxis.map(w => timeAxis.map(t => Math.exp(-(((w - 540) / 45) ** 2)) * Math.exp(-t / 2) + .4 * Math.exp(-(((w - 630) / 40) ** 2)) * Math.exp(-t / 9)));
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('/');
  await page.locator('.navigation-toggle').click();
  await page.locator('#file-input').setInputFiles({ name: 'fit.ufs', mimeType: 'application/octet-stream', buffer: Buffer.from(buildUfsFixture({ spectralAxis, timeAxis, matrix })) });
  await expect(page.locator('#heatmap')).toBeVisible();
  await page.locator('.navigation-toggle').click();
  await page.locator('[data-action="global-fit"]').click();
  await page.locator('#fit-components').selectOption('2');
  await page.locator('.fit-numerical-model summary').click();
  await page.locator('#fit-range-sensitivity').uncheck();
  await page.locator('[data-action="run-fit"]').click();
  const diagnostics = page.locator('.fit-diagnostic-grid');
  await expect(diagnostics).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.fit-lifetime-disclosure')).not.toHaveAttribute('open', '');
  await page.locator('.fit-modal [data-action="result-mode"][data-mode="DAS"]').focus();
  await diagnostics.evaluate(el => { el.scrollTop = 150; });
  const before = await diagnostics.evaluate(el => el.scrollTop);
  await page.keyboard.press('Enter');
  expect(await diagnostics.evaluate(el => el.scrollTop)).toBe(before);
  await expect(page.locator('.fit-modal [data-action="result-mode"][data-mode="DAS"]')).toHaveClass(/active/);
  await page.setViewportSize({ width: 970, height: 640 });
  expect(await diagnostics.evaluate(el => el.scrollTop)).toBe(before);
});

for (const [width, height] of [[960, 640], [1480, 920]]) {
  test(`Chinese heatmap axis title fits canvas at ${width}x${height}`, async ({ page }) => {
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      window.axisTitleBounds = [];
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
        if (this.canvas.id === 'heatmap' && text === '波长 (nm)') {
          const metrics = this.measureText(text);
          const transform = this.getTransform();
          window.axisTitleBounds.push({ bottom: (y + metrics.actualBoundingBoxDescent) * transform.d, height: this.canvas.height });
        }
        return original.call(this, text, x, y, ...rest);
      };
    });
    await page.setViewportSize({ width, height });
    await page.goto('/');
    if (width <= 1200) await page.locator('.navigation-toggle').click();
    await page.locator('#language-select').selectOption('zh-CN');
    await page.locator('#file-input').setInputFiles(sample);
    await expect(page.locator('#heatmap')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.axisTitleBounds.length)).toBeGreaterThan(0);
    const bounds = await page.evaluate(() => window.axisTitleBounds.at(-1));
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 2);
  });
}
