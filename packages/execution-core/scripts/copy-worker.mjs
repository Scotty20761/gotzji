/* global URL */
import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/fixture-worker.mjs', import.meta.url), new URL('../dist/fixture-worker.mjs', import.meta.url));
await copyFile(new URL('../src/product-library-weekly-wrapper.py', import.meta.url), new URL('../dist/product-library-weekly-wrapper.py', import.meta.url));
for (const name of ['grace-broker','grace-runtime','grace-stdio','grace-verifier','grace-test-driver','fingerprints','phase-r-runner','phase-r-validator','phase-r-daemon','phase-r-frontend','phase-r-local-qualification','phase-r-host-identity','product-host-ownership','product-server','product-broker','product-runner','product-project-script','product-security','process-identity','product-native-broker','product-native-manager','product-browser-broker','product-browser-manager','product-library-broker','product-library-manager','product-library-final-memo','product-library-spoke-policy']) {
  await copyFile(new URL(`../src/${name}.mjs`, import.meta.url), new URL(`../dist/${name}.mjs`, import.meta.url));
}
