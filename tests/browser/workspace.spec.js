import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildUfsFixture } from '../ufs-fixture.js';

const sample = { name: 'fixture.ufs', mimeType: 'application/octet-stream', buffer: Buffer.from(buildUfsFixture()) };
for (const [width, height] of [[960,640], [1024,768], [1220,760], [1366,768]]) {
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
