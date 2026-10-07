import { execFile } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalTemporaryDirectory } from './test-fixtures.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('server-owned project script runner', () => {
  it('runs only a reviewed package lifecycle name and returns the real package-manager exit', async () => {
    const root = await canonicalTemporaryDirectory('gotzji-project-script-'); roots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { lint: `node -e "require('node:fs').writeFileSync('lint.receipt','verified')"` },
    }));
    const runner = fileURLToPath(new URL('./product-project-script.mjs', import.meta.url));
    const corepack = await realpath(path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'));
    await expect(execFileAsync(process.execPath, [runner, corepack, path.join(root, 'package.json'), 'lint'], { windowsHide: true })).resolves.toMatchObject({ stderr: '' });
    expect(await readFile(path.join(root, 'lint.receipt'), 'utf8')).toBe('verified');
    await expect(execFileAsync(process.execPath, [runner, corepack, path.join(root, 'package.json'), 'publish'], { windowsHide: true })).rejects.toMatchObject({ stderr: expect.stringContaining('PROJECT_SCRIPT_ARGUMENT_DENIED') });
  });
});
