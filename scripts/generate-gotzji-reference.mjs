/* global URL, process, console */
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../docs/parity/lnwjud-5.8.6-live-tools.json', import.meta.url);
const destination = new URL('../apps/desktop/src/renderer/gotzji-tool-baseline.json', import.meta.url);
const captured = JSON.parse(await readFile(source, 'utf8'));
const schemas = JSON.parse(await readFile(new URL('../docs/parity/lnwjud-5.8.6-live-schemas.json', import.meta.url), 'utf8'));
const adapters = JSON.parse(await readFile(new URL('../docs/parity/lnwjud-5.8.6-connected-adapter-tools.json', import.meta.url), 'utf8'));
if (captured.baselineVersion !== '5.8.6' || !/^\d{4}-\d{2}-\d{2}$/u.test(captured.capturedOn)
  || !Array.isArray(captured.tools) || captured.tools.length !== captured.expectedTotal
  || new Set(captured.tools.map((tool) => tool.name)).size !== captured.tools.length
  || captured.tools.some((tool) => typeof tool.name !== 'string' || typeof tool.description !== 'string'
    || !Array.isArray(tool.tags) || tool.tags.some((tag) => typeof tag !== 'string'))) {
  throw new Error('The frozen lnwjud reference capture is incomplete or malformed');
}
const schemaIds = schemas.schemas.map((entry) => entry.id);
const adapterIds = adapters.tools.map((entry) => entry.id);
const runtimeIds = captured.tools.map((entry) => entry.name);
const adapterSet = new Set(adapterIds);
const runtimeSet = new Set(runtimeIds);
const unionSet = new Set([...runtimeIds, ...adapterIds]);
const contractSet = new Set([...schemaIds, ...adapterIds]);
if (new Set(schemaIds).size !== 170 || adapterIds.length !== 259 || adapterSet.size !== adapterIds.length
  || unionSet.size !== adapters.coverage.union || unionSet.size !== 273
  || runtimeIds.filter((id) => adapterSet.has(id)).length !== adapters.coverage.overlap
  || adapterIds.filter((id) => !runtimeSet.has(id)).length !== adapters.coverage.adapterOnly
  || runtimeIds.filter((id) => !adapterSet.has(id)).length !== adapters.coverage.runtimeOnly
  || contractSet.size !== unionSet.size || [...contractSet].some((id) => !unionSet.has(id))
  || adapters.tools.some((tool) => typeof tool.description !== 'string' || !tool.description.includes('exec tool declaration:'))) {
  throw new Error('The frozen runtime and connected-adapter surfaces need a complete, explicitly labelled contract union');
}
const tools = captured.tools.map((tool) => ({ id: tool.name, description: tool.description, tags: tool.tags, surface: adapterSet.has(tool.name) ? 'both' : 'runtime-catalog' }));
for (const tool of adapters.tools) if (!runtimeSet.has(tool.id)) tools.push({
  id: tool.id,
  description: tool.description.split('\n\n').slice(1).join('\n\n').split('\n\nexec tool declaration:')[0].replace('This tool is part of plugin `lnwjud`.', '').trim(),
  tags: ['adapter-only'], surface: 'adapter-only',
});
tools.sort((a, b) => a.id.localeCompare(b.id));
const output = JSON.stringify({
  version: captured.baselineVersion,
  capturedOn: captured.capturedOn,
  source: 'Runtime catalog205 plus connected adapter259; union273 callable names including aliases. Installed/source/caller acceptance remains separate.',
  tools,
}, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')).replace(/\r\n/gu, '\n') !== output) throw new Error('Run node scripts/generate-gotzji-reference.mjs to refresh the renderer reference');
  console.log(`Reference matches all ${tools.length} callable names across both frozen surfaces.`);
} else {
  await writeFile(destination, output);
  console.log(`Generated the renderer reference from ${tools.length} callable names across both frozen surfaces.`);
}
