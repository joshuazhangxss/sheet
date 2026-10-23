import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1360, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm exec vite -- --host 127.0.0.1 --port 5173', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
