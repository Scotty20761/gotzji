import { URL } from 'node:url';
/* global console */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const modules = ['policy', 'cua'];
const sources = await Promise.all(modules.map((name) => readFile(new URL(`../../../packages/capabilities/src/gotzji-browser-provider-${name}.ts`, import.meta.url), 'utf8')));
const bodies = sources.map((source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/^import .+ from '\.\/gotzji-browser-provider-policy\.js';\r?\n/gmu, '').replace(/^export /gmu, ''));
if (bodies.some((body) => /^import /mu.test(body))) throw new Error('Qualification bundle has an unexpected runtime dependency');
const bundle = bodies.join('\n') + '\nvar GotzjiBrowserQualification = { GotzjiBrowserProvider, GotzjiBrowserProviderError, GotzjiBrowserCuaQualificationTransport };\n';
await writeFile(new URL('./gotzji-browser-provider-qualification-bundle.js', import.meta.url), bundle);
console.log(JSON.stringify({ bundleSha256: createHash('sha256').update(bundle).digest('hex'), sourcesSha256: sources.map((source) => createHash('sha256').update(source).digest('hex')), note: 'Exact source classes transpiled only; run exclusively through documented CUA APIs.' }));
