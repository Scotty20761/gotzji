import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/gotzji-desktop.e2e.ts',
  timeout: 60_000,
  workers: 1,
});
