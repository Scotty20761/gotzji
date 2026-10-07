/* global process, URL */
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(packageRoot, 'dist');
const output = path.join(source, 'product-runtime');
await mkdir(output, { recursive: true });
const sourceEntries = await readdir(source, { withFileTypes: true });
const allowed = new Set(sourceEntries.filter((entry) => entry.isFile() && (/\.(?:js|mjs)$/.test(entry.name) || entry.name === 'product-library-weekly-wrapper.py')).map((entry) => entry.name));
allowed.add('product-runtime-manifest.json');
for (const entry of await readdir(output)) if (!allowed.has(entry)) throw new Error(`STALE_PRODUCT_RUNTIME_OUTPUT: ${entry}`);
for (const entry of sourceEntries) {
  if (entry.isFile() && (/\.(?:js|mjs)$/.test(entry.name) || entry.name === 'product-library-weekly-wrapper.py')) await copyFile(path.join(source, entry.name), path.join(output, entry.name));
}
for (const name of ['product-server', 'fixture-worker', 'grace-broker', 'grace-stdio', 'grace-verifier', 'product-broker', 'product-native-broker', 'product-browser-broker', 'product-library-broker']) {
  await build({ entryPoints: [path.join(source, `${name}.mjs`)], outfile: path.join(output, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', target: 'node24', conditions: ['import'], external: ['electron'], banner: { js: "import { createRequire as __gotzjiCreateRequire } from 'node:module'; const require = __gotzjiCreateRequire(import.meta.url);" }, logLevel: 'warning' });
}
const files = [];
for (const name of (await readdir(output)).sort()) {
  if (name === 'product-runtime-manifest.json') continue;
  const file = path.join(output, name); const info = await stat(file);
  if (!info.isFile()) throw new Error('PRODUCT_RUNTIME_UNEXPECTED_DIRECTORY');
  files.push({ relativePath: name, sizeBytes: info.size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
}
const version = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
const manifest = { schemaVersion: 1, product: 'gotzji', version, catalogVersion: 1, storeSchemaVersion: 1, entrypoint: 'product-server.mjs', files };
await writeFile(path.join(output, 'product-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`gotzji owned host runtime bundled: ${files.length} verified files\n`);
