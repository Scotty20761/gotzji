import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../docs/parity/lnwjud-5.8.6-live-tools.json', import.meta.url);
const destination = new URL('../apps/desktop/src/renderer/gotzji-tool-baseline.json', import.meta.url);
const captured = JSON.parse(await readFile(source, 'utf8'));
if (captured.baselineVersion !== '5.8.6' || !/^\d{4}-\d{2}-\d{2}$/u.test(captured.capturedOn)
  || !Array.isArray(captured.tools) || captured.tools.length !== captured.expectedTotal
  || new Set(captured.tools.map((tool) => tool.name)).size !== captured.tools.length
  || captured.tools.some((tool) => typeof tool.name !== 'string' || typeof tool.description !== 'string'
    || !Array.isArray(tool.tags) || tool.tags.some((tag) => typeof tag !== 'string'))) {
  throw new Error('The frozen lnwjud reference capture is incomplete or malformed');
}
const output = JSON.stringify({
  version: captured.baselineVersion,
  capturedOn: captured.capturedOn,
  source: 'lnwjud live tool_search; 152 category queries plus unfiltered page; 205 unique tools',
  tools: captured.tools.map((tool) => ({ id: tool.name, description: tool.description, tags: tool.tags })),
}, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')).replace(/\r\n/gu, '\n') !== output) throw new Error('Run node scripts/generate-gotzji-reference.mjs to refresh the renderer reference');
  console.log(`Reference matches all ${captured.tools.length} frozen tool definitions.`);
} else {
  await writeFile(destination, output);
  console.log(`Generated the renderer reference from ${captured.tools.length} captured definitions.`);
}
