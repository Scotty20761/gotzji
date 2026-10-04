import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/fixture-worker.mjs', import.meta.url), new URL('../dist/fixture-worker.mjs', import.meta.url));
for (const name of ['grace-broker','grace-runtime','grace-stdio','grace-verifier','grace-test-driver']) {
  await copyFile(new URL(`../src/${name}.mjs`, import.meta.url), new URL(`../dist/${name}.mjs`, import.meta.url));
}
