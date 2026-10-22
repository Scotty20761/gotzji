/* global URL, process, console */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Frozen upstream documents are source evidence, never installed/caller readiness.
const revision = '1a0453ed0ef1de4cdf9ce1ba9edee8da0de8426b';
const full = (await readFile(new URL('../docs/upstream/FULL_README-v5.8.7.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const contract = (await readFile(new URL('../docs/upstream/TOOL_CONTRACT-v5.8.7.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const fullReadmeSha256 = createHash('sha256').update(full).digest('hex');
const contractSha256 = createHash('sha256').update(contract).digest('hex');
if (fullReadmeSha256 !== '04b4c83aaa100d2f361afe043e3ed810e0ec9aa3812c3496169aacc122679822'
  || contractSha256 !== '53310f507e00d069846b6f6752fcd4191d75b642ea3823b3c93c106d5989f4fd') throw new Error('Frozen upstream source bytes changed');
const section = (text, start, end) => {
  const from = text.indexOf(start); const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Frozen upstream tool section is missing');
  return text.slice(from, to);
};
const fullRows = section(full, '<!-- BEGIN GENERATED README TOOL REGISTRY -->', '<!-- END GENERATED README TOOL REGISTRY -->');
const contractRows = section(contract, '<!-- BEGIN GENERATED TOOL REGISTRY -->', '<!-- END GENERATED TOOL REGISTRY -->');
const expression = /^\| (\d+) \| `([a-z][a-z0-9_]+)` \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$/gmu;
const tools = [...fullRows.matchAll(expression)].map((row) => ({ id: row[2], description: row[7].replace(/\\\|/gu, '|'), tags: [row[3], row[4]], surface: 'source-only' }));
const ids = [...contractRows.matchAll(/^\| \d+ \| `([a-z][a-z0-9_]+)` \|/gmu)].map((row) => row[1]);
if (tools.length !== 294 || new Set(tools.map((tool) => tool.id)).size !== 294 || JSON.stringify(tools.map((tool) => tool.id)) !== JSON.stringify(ids)) {
  throw new Error('The two frozen upstream inventories do not agree on all 294 definitions');
}
const output = JSON.stringify({
  version: '5.8.7', referenceUpdatedOn: '2026-10-22', sourceRevision: revision,
  sourceDocuments: { fullReadmeSha256, contractSha256 },
  evidence: 'source-only', tools,
}, null, 2) + '\n';
const destination = new URL('../apps/desktop/src/renderer/gotzji-upstream-baseline.json', import.meta.url);
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')).replace(/\r\n/gu, '\n') !== output) throw new Error('Regenerate the frozen upstream reference');
  console.log('Upstream 5.8.7 reference matches 294 source definitions; execution is not qualified.');
} else {
  await writeFile(destination, output);
  console.log('Generated 294 upstream 5.8.7 source definitions; execution is not qualified.');
}
