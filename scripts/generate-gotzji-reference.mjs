/* global URL, process, console */
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../docs/parity/lnwjud-5.8.6-live-tools.json', import.meta.url);
const destination = new URL('../apps/desktop/src/renderer/gotzji-tool-baseline.json', import.meta.url);
const captured = JSON.parse(await readFile(source, 'utf8'));
const schemas = JSON.parse(await readFile(new URL('../docs/parity/lnwjud-5.8.6-live-schemas.json', import.meta.url), 'utf8'));
const adapters = JSON.parse(await readFile(new URL('../docs/parity/lnwjud-5.8.6-connected-adapter-tools.json', import.meta.url), 'utf8'));
const statics = JSON.parse(await readFile(new URL('../docs/parity/lnwjud-5.8.6-static-tool-names.json', import.meta.url), 'utf8'));
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
const staticSet = new Set(statics.names);
const staticOnly = statics.names.filter((name) => !unionSet.has(name));
if (statics.baselineVersion !== captured.baselineVersion || statics.names.length !== 286 || staticSet.size !== statics.names.length
  || statics.names.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]+$/u.test(name))
  || statics.counts.staticSourceAndPackageNames !== staticSet.size || statics.counts.observedDesktopInternalRows !== staticSet.size
  || statics.counts.unreconciledDesktopCount !== 0 || statics.counts.callableUnion !== unionSet.size || [...unionSet].some((name) => !staticSet.has(name))
  || staticOnly.length !== 13 || statics.counts.staticOnly !== staticOnly.length
  || JSON.stringify([...staticOnly].sort()) !== JSON.stringify([...statics.staticOnly].sort())
  || statics.compatibilityAliases.length !== 1 || statics.compatibilityAliases.some((alias) => !staticSet.has(alias.name) || !staticSet.has(alias.canonicalName)
    || !/^[a-f0-9]{64}$/u.test(alias.source.sha256) || !/^[a-f0-9]{64}$/u.test(alias.package.sha256))) {
  throw new Error('The frozen source/package name inventory does not reconcile the Desktop and advertised surfaces');
}
const alias = statics.compatibilityAliases[0];
if (alias.name !== 'checkpoint_goal_engineering' || alias.canonicalName !== 'checkpoint_goal'
  || !staticOnly.includes(alias.name) || !unionSet.has(alias.canonicalName)
  || statics.source.tagObject !== 'fc5555fa366c485e1261173aa1c704e02befe984'
  || statics.package.asarSha256 !== 'd62201e34a29c85d31a718992118fe383f293da7ac932ad5437d3eb242e276d4'
  || alias.source.path !== 'packages/mcp-server/src/tools/goal-tools.ts' || alias.source.line !== 716
  || alias.source.sha256 !== 'd7b2ac0ac934f3eaa3969ead2791040d1b008d3adb233511abc5e40ad95d4f9f'
  || alias.package.path !== 'node_modules/@lnwjud/mcp-server/dist/tools/goal-tools.js' || alias.package.line !== 700
  || alias.package.sha256 !== 'af4f2bcfa6bc5be2c5a94d777678802c87d9aa79b6c8631cf0e5abf8dc253f98') {
  throw new Error('The frozen checkpoint compatibility alias proof changed');
}
const tools = captured.tools.map((tool) => ({ id: tool.name, description: tool.description, tags: tool.tags, surface: adapterSet.has(tool.name) ? 'both' : 'runtime-catalog' }));
for (const tool of adapters.tools) if (!runtimeSet.has(tool.id)) tools.push({
  id: tool.id,
  description: tool.description.split('\n\n').slice(1).join('\n\n').split('\n\nexec tool declaration:')[0].replace('This tool is part of plugin `lnwjud`.', '').trim(),
  tags: ['adapter-only'], surface: 'adapter-only',
});
for (const id of staticOnly) {
  const alias = statics.compatibilityAliases.find((entry) => entry.name === id);
  tools.push({ id, description: alias ? `ชื่อเรียกสำรองของ ${alias.canonicalName} ที่พบในชุดโปรแกรมต้นฉบับ ยังไม่มีหลักฐานการประกาศผ่านช่องทางเชื่อมต่อที่เก็บไว้` : 'พบชื่อในชุดโปรแกรมต้นฉบับ ยังไม่มีรายละเอียดสัญญาการเรียกผ่านช่องทางเชื่อมต่อที่เก็บไว้ ต้องเทียบพฤติกรรมและตรวจผลก่อนใช้งาน', tags: ['static-only'], surface: 'static-only' });
}
tools.sort((a, b) => a.id.localeCompare(b.id));
const output = JSON.stringify({
  version: captured.baselineVersion,
  capturedOn: captured.capturedOn,
  referenceUpdatedOn: statics.capturedOn,
  advertisedCallableNames: unionSet.size,
  staticOnlyNames: staticOnly.length,
  source: 'Runtime catalog205 plus connected adapter259; union273 callable names.13additional static-only names reconcile286Desktop reference names, including compatibility aliases. This is not readiness or complete behavior acceptance.',
  tools,
}, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')).replace(/\r\n/gu, '\n') !== output) throw new Error('Run node scripts/generate-gotzji-reference.mjs to refresh the renderer reference');
  console.log(`Reference matches all ${tools.length} reference names (273 advertised,13 static-only).`);
} else {
  await writeFile(destination, output);
  console.log(`Generated the renderer reference from ${tools.length} reference names (273 advertised,13 static-only).`);
}
