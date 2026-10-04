import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/fixture-worker.mjs', import.meta.url), new URL('../dist/fixture-worker.mjs', import.meta.url));
