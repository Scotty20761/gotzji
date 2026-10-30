import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Real processes, SQLite and PowerShell share hosted Windows runners whose stall bursts slowed a 0.3 s
    // SQLite-only test to 7.5 s. Product budgets are unchanged, and local runs keep the strict default.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    hookTimeout: process.env.CI ? 20_000 : 10_000,
  },
});
