import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  use: { baseURL: 'http://127.0.0.1:1420', headless: true },
  webServer: { command: 'npm run dev -- --port 1420', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
});
