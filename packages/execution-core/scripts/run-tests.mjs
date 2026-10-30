/* global process, URL, console */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_IO_THREADPOOL_SIZE } from '../src/product-runtime-settings.mjs';

// libuv reads this at process startup; setting it inside Vitest is too late.
const require = createRequire(import.meta.url);
const entry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const child = spawnSync(process.execPath, [entry, 'run', '--fileParallelism=false', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: 'inherit',
  env: { ...process.env, UV_THREADPOOL_SIZE: PRODUCT_IO_THREADPOOL_SIZE },
});
if (child.error) console.error(child.error);
process.exit(child.status ?? 1);
