import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  const parent = await realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('gotzji-reference-') || await realpath(root) !== root) throw new Error('Reference test cleanup scope denied');
    await rm(root, { recursive: true, force: true });
  }
});

it('pins the actual compatibility alias proof rather than accepting shape-valid evidence', async () => {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'gotzji-reference-'))); roots.push(root);
  const files = ['scripts/generate-gotzji-reference.mjs', 'apps/desktop/src/renderer/gotzji-tool-baseline.json', ...['live-tools', 'live-schemas', 'connected-adapter-tools', 'static-tool-names'].map((name) => `docs/parity/lnwjud-5.8.6-${name}.json`)];
  for (const file of files) { const destination = path.join(root, file); await mkdir(path.dirname(destination), { recursive: true }); await cp(path.join(repository, file), destination); }
  const generator = path.join(root, 'scripts/generate-gotzji-reference.mjs');
  expect(execFileSync(process.execPath, [generator, '--check'], { encoding: 'utf8', timeout: 5000 })).toContain('286 reference names');
  const dataPath = path.join(root, 'docs/parity/lnwjud-5.8.6-static-tool-names.json');
  const original = await readFile(dataPath, 'utf8');
  const generatedPath = path.join(root, 'apps/desktop/src/renderer/gotzji-tool-baseline.json');
  const generatedBefore = await readFile(generatedPath, 'utf8');
  type Proof = { name: string; canonicalName: string; source: { path: string; line: number; sha256: string }; package: { path: string; line: number; sha256: string } };
  const changes: readonly ((proof: Proof) => void)[] = [
    (proof): void => { proof.name = 'codex_run'; },
    (proof): void => { proof.canonicalName = 'read_file'; },
    (proof): void => { proof.source.path = 'packages/other.ts'; },
    (proof): void => { proof.source.line++; },
    (proof): void => { proof.source.sha256 = '0'.repeat(64); },
    (proof): void => { proof.package.path = 'node_modules/other.js'; },
    (proof): void => { proof.package.line++; },
    (proof): void => { proof.package.sha256 = '1'.repeat(64); },
  ];
  for (const change of changes) {
    const altered = JSON.parse(original) as { compatibilityAliases: Proof[] };
    change(altered.compatibilityAliases[0]!);
    await writeFile(dataPath, JSON.stringify(altered));
    try {
      execFileSync(process.execPath, [generator], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      throw new Error('Altered alias proof was accepted');
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr)).toContain('The frozen checkpoint compatibility alias proof changed');
    }
  }
  expect(await readFile(generatedPath, 'utf8')).toBe(generatedBefore);
}, 15000);
