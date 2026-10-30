import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const roots: string[] = [];
const documents = ['README.md', 'FULL_README.md', '.github/RELEASE_CHECKLIST.md', 'docs/architecture/TOOL_CONTRACT.md', 'docs/LNWJUD_CAPABILITIES.md'];
const countsBlock = /<!-- BEGIN GENERATED UPSTREAM TOOL COUNTS -->[\s\S]*?<!-- END GENERATED UPSTREAM TOOL COUNTS -->/;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gotzji-tool-catalog-'));
  roots.push(root);
  for (const relative of ['scripts/generate-tool-catalog.mjs', ...documents]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(repositoryRoot, relative), path.join(root, relative));
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const modules = path.join(root, 'packages/mcp-server/dist');
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(modules, 'tool-registry.js'), `
    const tools = ['read_fixture', 'optional_fixture'].map(name => ({name, permission: 'READ', annotations: {readOnlyHint:true}, description: name}));
    export class ToolRegistry {
      constructor(_services, _actor, options) {this.enabled = options?.codexToolsEnabled;}
      listAll() {return tools;}
      list() {return this.enabled ? tools : tools.slice(0,1);}
    }
  `);
  await writeFile(path.join(modules, 'upgrade-catalog.js'), 'export const upgradeCatalogEntry = () => undefined;');
  await writeFile(path.join(modules, 'tool-runtime-fixtures.js'), "export const TOOL_RUNTIME_FIXTURES = {read_fixture:{evidence:{kind:'service_dispatch'}},optional_fixture:{evidence:{kind:'service_dispatch'}}};");
  return root;
}

function run(root: string, check = false): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['scripts/generate-tool-catalog.mjs', ...(check ? ['--check'] : [])], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

describe('owned documentation and retained upstream catalog generation', () => {
  it('regenerates real documentation from the registry without changing owned product claims or acceptance gates', async () => {
    const root = await fixture();
    const before = await Promise.all(['README.md', '.github/RELEASE_CHECKLIST.md'].map(file => readFile(path.join(root, file), 'utf8')));
    const generated = run(root);
    expect(generated.status, String(generated.stderr)).toBe(0);
    expect(run(root, true).status).toBe(0);
    for (const [index, file] of ['README.md', '.github/RELEASE_CHECKLIST.md'].entries()) {
      const after = await readFile(path.join(root, file), 'utf8');
      expect(after).toContain('2 total definitions / 1 advertised by default / all 2');
      expect(after).toContain('They do not count callable gotzji tools');
      expect(after.replace(countsBlock, '')).toBe(before[index]!.replace(countsBlock, ''));
    }
    const contract = await readFile(path.join(root, 'docs/architecture/TOOL_CONTRACT.md'), 'utf8');
    expect(contract).toContain('The current runtime contains 2 definitions, advertises 1');
    expect(contract).toContain('`optional_fixture`');
  });

  it.each(documents)('rejects actual generated-content drift in %s without rewriting', async file => {
    const root = await fixture();
    expect(run(root).status).toBe(0);
    const target = path.join(root, file);
    const source = await readFile(target, 'utf8');
    const changed = file === 'docs/LNWJUD_CAPABILITIES.md'
      ? source.replace('read_fixture', 'drifted_fixture')
      : source.replace('2 total', '999 total');
    expect(changed).not.toBe(source);
    await writeFile(target, changed);
    const checked = run(root, true);
    expect(checked.status).toBe(1);
    expect(String(checked.stderr)).toContain('Tool catalog drift detected');
    expect(await readFile(target, 'utf8')).toBe(changed);
  });

  it.each(['README.md', '.github/RELEASE_CHECKLIST.md'])('rejects a missing owned reference block in %s', async file => {
    const root = await fixture();
    const target = path.join(root, file);
    await writeFile(target, (await readFile(target, 'utf8')).replace(countsBlock, ''));
    const checked = run(root, true);
    expect(checked.status).toBe(1);
    expect(String(checked.stderr)).toContain('Missing current tool-count surface');
  });

  it('still rejects registry definitions without runtime fixture evidence', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'packages/mcp-server/dist/tool-runtime-fixtures.js'), 'export const TOOL_RUNTIME_FIXTURES = {};');
    const checked = run(root, true);
    expect(checked.status).toBe(1);
    expect(String(checked.stderr)).toContain('Runtime evidence is missing for: read_fixture, optional_fixture');
  });
});
