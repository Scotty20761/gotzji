/* global process */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { childEnvironment } from './product-security.mjs';

const corepackScript = path.resolve(process.argv[2] ?? '');
const packageFile = path.resolve(process.argv[3] ?? '');
const projectRoot = path.dirname(packageFile);
const scriptName = process.argv[4] ?? '';
if (!process.argv[2] || !process.argv[3] || !path.isAbsolute(corepackScript) || !path.isAbsolute(packageFile) || !['build', 'test', 'lint', 'typecheck'].includes(scriptName)) fail('PROJECT_SCRIPT_ARGUMENT_DENIED');
if (!existsSync(corepackScript) || lstatSync(corepackScript).isSymbolicLink() || !lstatSync(corepackScript).isFile() || realpathSync(corepackScript) !== corepackScript) fail('PROJECT_PACKAGE_MANAGER_CHANGED');
if (path.basename(packageFile) !== 'package.json' || !existsSync(packageFile) || lstatSync(packageFile).isSymbolicLink() || realpathSync(packageFile) !== packageFile) fail('PROJECT_PACKAGE_CHANGED');
let manifest;
try { manifest = JSON.parse(readFileSync(packageFile, 'utf8')); } catch { fail('PROJECT_PACKAGE_INVALID'); }
if (typeof manifest.scripts?.[scriptName] !== 'string' || !manifest.scripts[scriptName].trim()) fail('PROJECT_SCRIPT_NOT_REGISTERED');
const child = spawn(process.execPath, [corepackScript, 'pnpm@10.15.0', 'run', scriptName], {
  cwd: projectRoot, env: childEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'],
});
child.once('error', () => fail('PROJECT_PACKAGE_MANAGER_UNAVAILABLE'));
child.once('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));

function fail(code) { process.stderr.write(`${code}\n`); process.exit(1); }
