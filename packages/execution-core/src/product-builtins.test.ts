import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCore } from './core.js';
import { ensureProductControlDocuments } from './product-control-policy.js';
import { canonicalTemporaryDirectorySync } from './test-fixtures.js';
import { hash } from './store.js';
import type { ReviewedCommandRegistration } from './types.js';

const roots: string[] = [];
const cores: ExecutionCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; core: ExecutionCore; credential: string; recipe: ReviewedCommandRegistration }> {
  const root = canonicalTemporaryDirectorySync('gotzji-builtins-'); roots.push(root);
  const libraryRoot = path.join(root, 'workspace'); ensureProductControlDocuments(libraryRoot);
  const executable = path.join(root, 'installed-app.exe'); writeFileSync(executable, 'old packaged executable');
  const script = path.join(root, 'reviewed.mjs'); writeFileSync(script, 'old packaged dependency');
  const core = await ExecutionCore.open(path.join(root, 'state'), { product: { executable: process.execPath, libraryRoot } }); cores.push(core);
  const credential = core.enrollAdapter('gotzji-product', 'owner');
  return { root, core, credential, recipe: { recipeId: 'node-check', executable, args: [script], dependencies: [script], timeoutMs: 120000 } };
}

describe('packaged built-in command upgrades', () => {
  it.each(['executable', 'dependency'] as const)('reopens after changed %s bytes without rewriting a legacy recipe or its project binding', async (changed) => {
    const f = await fixture();
    const legacy = f.core.registerReviewedCommand(f.credential, f.recipe);
    const previousBuiltin = f.core.registerBuiltinCommand(f.credential, f.recipe);
    const original = f.core.recipeReview(f.credential, legacy.recipeId!);
    const project = path.join(f.root, 'project'); mkdirSync(project);
    f.core.registerProject(f.credential, { projectId: 'project', displayName: 'Project', rootPath: project, recipeIds: [legacy.recipeId!] });
    f.core.close();
    const target = changed === 'executable' ? f.recipe.executable : f.recipe.dependencies[0]!;
    writeFileSync(target, 'new packaged bytes');
    const core = await ExecutionCore.open(path.join(f.root, 'state'), { product: { executable: process.execPath, libraryRoot: path.join(f.root, 'workspace') } }); cores.push(core);
    // This is the same trusted registration caller used by product-server at startup.
    const current = core.registerBuiltinCommand(f.credential, f.recipe);
    expect(current.recipeId).not.toBe(legacy.recipeId);
    expect(current.recipeId).not.toBe(previousBuiltin.recipeId);
    expect(core.registerBuiltinCommand(f.credential, f.recipe).recipeId).toBe(current.recipeId);
    expect(core.recipeReview(f.credential, legacy.recipeId!)).toEqual(original);
    expect(core.listProjects(f.credential)[0]?.recipeIds).toEqual([legacy.recipeId]);
    expect(core.catalog(f.credential).find((entry) => entry.recipeId === legacy.recipeId)).toMatchObject({ state: 'unsupported', reason: 'BUILTIN_RECIPE_SUPERSEDED' });
    expect(core.catalog(f.credential).find((entry) => entry.recipeId === previousBuiltin.recipeId)).toMatchObject({ state: 'unsupported', reason: 'BUILTIN_RECIPE_SUPERSEDED' });
    expect(core.catalog(f.credential).find((entry) => entry.recipeId === current.recipeId)).toMatchObject({ state: 'available' });
    expect(() => core.prepareOperation(f.credential, { requestId: 'unapproved', projectId: 'project', operation: 'command.run', commandId: current.recipeId! })).toThrow();
    expect(() => core.prepareOperation(f.credential, { requestId: 'old-pins', projectId: 'project', operation: 'command.run', commandId: legacy.recipeId! })).toThrow();
    core.bindProjectRecipe(f.credential, { projectId: 'project', recipeId: current.recipeId! });
    expect(core.prepareOperation(f.credential, { requestId: 'reviewed', projectId: 'project', operation: 'command.run', commandId: current.recipeId! }).preparationId).toBeTruthy();
    expect(await core.list(f.credential)).toEqual([]);
  });

  it('reuses an unchanged built-in revision and retains the normal immutable-recipe rejection', async () => {
    const f = await fixture();
    const first = f.core.registerBuiltinCommand(f.credential, f.recipe);
    expect(f.core.registerBuiltinCommand(f.credential, f.recipe).recipeId).toBe(first.recipeId);
    expect(f.core.recipeReview(f.credential, first.recipeId!).executableSha256).toBe(hash(readFileSync(f.recipe.executable)));
    expect(() => f.core.registerReviewedCommand(f.credential, { ...f.recipe, recipeId: first.recipeId!, timeoutMs: 1000 })).toThrow('RECIPE_REGISTRATION_CONFLICT');
  });

  it('keeps each owner’s current built-in catalog independent', async () => {
    const f = await fixture();
    const first = f.core.registerBuiltinCommand(f.credential, f.recipe);
    const secondCredential = f.core.enrollAdapter('second-product', 'second-owner');
    const otherExecutable = path.join(f.root, 'other-app.exe'); writeFileSync(otherExecutable, 'other packaged executable');
    const second = f.core.registerBuiltinCommand(secondCredential, { ...f.recipe, executable: otherExecutable });
    expect(second.recipeId).not.toBe(first.recipeId);
    expect(f.core.catalog(f.credential).find((entry) => entry.recipeId === first.recipeId)).toMatchObject({ state: 'available' });
    expect(f.core.catalog(f.credential).some((entry) => entry.recipeId === second.recipeId)).toBe(false);
    expect(f.core.catalog(secondCredential).find((entry) => entry.recipeId === second.recipeId)).toMatchObject({ state: 'available' });
  });

  it('requires the product profile before inspecting built-in files', async () => {
    const f = await fixture();
    const core = await ExecutionCore.open(path.join(f.root, 'plain-state')); cores.push(core);
    const credential = core.enrollAdapter('plain', 'owner');
    expect(() => core.registerBuiltinCommand(credential, { ...f.recipe, executable: path.join(f.root, 'missing.exe') })).toThrow('PRODUCT_PROFILE_REQUIRED');
  });
});
