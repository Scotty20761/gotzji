import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  testIgnore: '**/gotzji-desktop.e2e.ts',
  timeout: 30_000,
  workers: 1,
});
