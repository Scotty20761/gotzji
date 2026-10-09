import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CoreError, type ProjectRegistration, type RegisteredProject, type BasicProductOperationInput, type ProductOperation, type CatalogEntry, type ReviewedCommandRegistration, type ReviewedCommand, type FileFingerprint } from './types.js';
import { hash } from './store.js';

function invalid(field: string, reason: string): never { throw new CoreError('INVALID_REQUEST', reason, field, 'request', 'Correct the named field and prepare again'); }
export function filesystem<T>(field: string, action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof CoreError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const result = code === 'ENOENT' ? 'FILE_NOT_FOUND' : ['EACCES','EPERM'].includes(code ?? '') ? 'FILE_PERMISSION_DENIED' : code === 'ENOTDIR' ? 'PATH_NOT_DIRECTORY' : 'FILESYSTEM_UNAVAILABLE';
    throw new CoreError(result, code ?? 'Unclassified filesystem failure', field, 'filesystem', result === 'FILE_PERMISSION_DENIED' ? 'Grant this Windows owner access to the selected file' : 'Check the selected path and prepare again');
  }
}
function fingerprint(filename: string, field = 'dependencies'): FileFingerprint {
  return filesystem(field, () => {
    const resolved = realpathSync(filename);
    if (resolved !== path.resolve(filename) || lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile()) invalid(field, 'Use a regular file without redirected paths');
    return { path: resolved, hash: hash(readFileSync(resolved)) };
  });
}
/** Trusted immutable recipe. projectRoot templates are expanded only by the server. */
export function reviewedRecipe(registration: ReviewedCommandRegistration): ReviewedCommandRegistration & { readonly timeoutMs: number; readonly executableHash: string; readonly fixedDependencies: readonly FileFingerprint[] } {
  if (!registration || !/^[a-zA-Z0-9_-]{1,64}$/.test(registration.recipeId)) invalid('recipeId', 'A stable server recipe ID is required');
  if (!path.isAbsolute(registration.executable) || !Array.isArray(registration.args) || registration.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) invalid('recipe', 'Use a trusted executable and argument array');
  if (/^[\\/]{2}/u.test(registration.executable)) invalid('executable', 'Use an executable on a local disk, not a network path');
  if (!Array.isArray(registration.dependencies) || registration.dependencies.some((item) => typeof item !== 'string' || (!path.isAbsolute(item) && !item.startsWith('${projectRoot}')))) invalid('dependencies', 'Declare every reviewed script/config dependency as an absolute path or projectRoot template');
  const executable = filesystem('executable', () => realpathSync(registration.executable));
  if (/^[\\/]{2}/u.test(executable)) invalid('executable', 'Use an executable on a local disk, not a network path');
  const timeoutMs = registration.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 7200000) invalid('timeoutMs', 'Use a budget between 100 ms and two hours');
  if (registration.writeScope !== undefined && registration.writeScope !== 'project') invalid('writeScope', 'Declare project, or leave it out when the command may write anywhere in its workspace');
  const fixedDependencies = registration.dependencies.filter((item) => !item.includes('${projectRoot}')).map((item) => fingerprint(item));
  if (fixedDependencies.some((entry) => /^[\\/]{2}/u.test(entry.path))) invalid('dependencies', 'Pin files on a local disk, not a network path');
  // A file the command is given must be declared: absolute and projectRoot paths are dependencies, and a relative or
  // `--option=path` file is refused, because it would run project bytes that no dependency names.
  for (const arg of registration.args) for (const candidate of [/^-[^=]*=/u.test(arg) ? arg.slice(arg.indexOf('=') + 1) : arg]) {
    // On Windows one leading slash names a switch (`/c`, `/p:Configuration=Release`) unless it is an existing file.
    if (process.platform === 'win32' && /^\/[^\\/]/u.test(candidate) && !existsSync(candidate)) continue;
    if (path.isAbsolute(candidate) || candidate.startsWith('${projectRoot}')) { if (!registration.dependencies.includes(candidate)) invalid('dependencies', 'Declare file arguments in dependencies'); }
    else if (!candidate.includes('://') && (/[\\/]/u.test(candidate) || /\.(?:py|pyw|ps1|psm1|bat|cmd|js|mjs|cjs|ts|sh|rb|pl)$/iu.test(candidate))) invalid('args', 'Write project files as ${projectRoot}/… and declare them in dependencies');
  }
  return { ...registration, executable, args: [...registration.args], dependencies: [...registration.dependencies], timeoutMs, executableHash: hash(filesystem('executable', () => readFileSync(executable))), fixedDependencies };
}
/**
 * Claim key for a folder inside a workspace (incident I3): lower-cased, ending in exactly one separator, so a drive or
 * share root is keyed once and `a\` never matches `ab\`.
 */
export function folderClaim(resourceKey: string, folder: string): string {
  const key = folder.toLowerCase();
  return `folder:${resourceKey}:${key.endsWith(path.sep) ? key : key + path.sep}`;
}
function claimParts(key: string): { readonly group: string; readonly folder?: string } | undefined {
  if (key.startsWith('project:')) return { group: key.slice('project:'.length) };
  const end = key.startsWith('folder:') ? key.indexOf(':', 'folder:'.length) : -1;
  return end < 0 ? undefined : { group: key.slice('folder:'.length, end), folder: key.slice(end + 1) };
}
/** Two claims collide when they are equal, when one holds the whole workspace the other's folder is in, or when one folder contains the other. */
export function claimsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const a = claimParts(left); const b = claimParts(right);
  if (!a || !b || a.group !== b.group) return false;
  return !a.folder || !b.folder || a.folder.startsWith(b.folder) || b.folder.startsWith(a.folder);
}
export function registeredProject(owner: string, registration: ProjectRegistration): RegisteredProject {
  if (!registration || Object.keys(registration).some((key) => !['projectId','displayName','rootPath','kind','recipeIds'].includes(key))) invalid('registration', 'Projects select server recipe IDs; executables and argument arrays are not accepted');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(registration.projectId)) invalid('projectId', 'Use 1–64 letters, digits, underscores or hyphens');
  if (typeof registration.displayName !== 'string' || !registration.displayName.trim() || registration.displayName.length > 200) invalid('displayName', 'A project name is required');
  if (typeof registration.rootPath !== 'string' || !path.isAbsolute(registration.rootPath)) invalid('rootPath', 'An existing absolute project directory is required');
  const rootPath = filesystem('rootPath', () => realpathSync(registration.rootPath));
  if (!lstatSync(rootPath).isDirectory()) invalid('rootPath', 'The project root must be a directory');
  if (registration.kind && !['project','library'].includes(registration.kind)) invalid('kind', 'Use project or library');
  if (registration.recipeIds && (!Array.isArray(registration.recipeIds) || registration.recipeIds.some((id) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) || new Set(registration.recipeIds).size !== registration.recipeIds.length)) invalid('recipeIds', 'Select unique enrolled server recipe IDs');
  let repository = rootPath;
  let ancestor = rootPath;
  while (true) {
    const marker = path.join(ancestor, '.git');
    if (existsSync(marker)) {
      if (lstatSync(marker).isDirectory()) repository = realpathSync(marker);
      else {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(marker, 'utf8'));
        if (!match?.[1]) invalid('rootPath', 'The Git worktree registration is invalid');
        const gitdir = realpathSync(path.resolve(ancestor, match[1].trim()));
        const common = path.join(gitdir, 'commondir');
        repository = existsSync(common) ? realpathSync(path.resolve(gitdir, readFileSync(common, 'utf8').trim())) : gitdir;
      }
      break;
    }
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  return { projectId: registration.projectId, displayName: registration.displayName.trim(), owner, rootPath, kind: registration.kind ?? 'project', resourceKey: hash(repository.toLowerCase()), recipeIds: [...(registration.recipeIds ?? [])] };
}
export function discoverPolicies(projectRoot: string, targetDirectories: readonly string[]): { projectPolicies: Readonly<Record<string, FileFingerprint>>; policyDirectories: readonly string[] } {
  const directories = new Set<string>();
  for (let directory of [projectRoot, ...targetDirectories]) {
    while (true) { directories.add(directory); const parent = path.dirname(directory); if (parent === directory) break; directory = parent; }
  }
  const policyDirectories = [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const policies: FileFingerprint[] = [];
  for (const directory of policyDirectories) for (const name of ['AGENTS.md','CLAUDE.md']) {
    const filename = path.join(directory, name); if (existsSync(filename)) policies.push(fingerprint(filename, 'projectPolicies'));
  }
  return { projectPolicies: Object.fromEntries(policies.map((entry, index) => [`project_policy_${index}`, entry])), policyDirectories };
}
export function assertOutsidePrivateRuntime(target: string, privateRoots: readonly string[]): void {
  const normalized=path.resolve(target).toLowerCase();
  for(const root of privateRoots){const protectedRoot=path.resolve(root).toLowerCase();const relative=path.relative(protectedRoot,normalized);if(!relative||(!relative.startsWith('..')&&!path.isAbsolute(relative)))throw new CoreError('PRIVATE_RUNTIME_SCOPE_DENIED','Server authority/config/receipt files are outside project file operations','path','authority','Select an ordinary project file');}
}
export function productOperation(project: RegisteredProject, input: BasicProductOperationInput, recipe?: ReturnType<typeof reviewedRecipe>, options: { readonly privateRuntimeRoots?: readonly string[]; readonly boundRecipeIds?: readonly string[] } = {}): ProductOperation {
  if (!input || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) invalid('requestId', 'Use 1–100 letters, digits, underscores or hyphens');
  if (input.projectId !== project.projectId) invalid('projectId', 'Select an enrolled project');
  if (!['file.read','file.write','command.run'].includes(input.operation)) invalid('operation', 'Select an available operation');
  const common = ['requestId','projectId','operation','dependsOn','priority'];
  const allowed = [...common, ...(input.operation === 'command.run' ? ['commandId'] : input.operation === 'file.write' ? ['path','expectedSha256','content'] : ['path'])];
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid('arguments', 'Unexpected operation fields');
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 3)) invalid('priority', 'Use priority 0 through 3; default is 1');
  if (input.dependsOn && (!Array.isArray(input.dependsOn) || input.dependsOn.length > 8 || input.dependsOn.some((id) => !/^[a-f0-9]{64}$/.test(id)) || new Set(input.dependsOn).size !== input.dependsOn.length)) invalid('dependsOn', 'Select up to eight unique existing owned jobs');
  if (filesystem('rootPath', () => realpathSync(project.rootPath)) !== project.rootPath) throw new CoreError('PROJECT_ROOT_CHANGED', undefined, 'rootPath');
  if (input.operation === 'command.run') {
    // Owner bindings add recipes without rewriting the project registration that every prepared job embeds.
    if (!recipe || ![...project.recipeIds, ...(options.boundRecipeIds ?? [])].includes(recipe.recipeId) || input.commandId !== recipe.recipeId) invalid('commandId', 'Only enrolled immutable server recipes can run');
    const substitute = (item: string): string => item.replaceAll('${projectRoot}', project.rootPath);
    const dependencies = recipe.dependencies.map((item) => fingerprint(substitute(item)));
    for (const previous of recipe.fixedDependencies) if (!dependencies.some((entry) => entry.path === previous.path && entry.hash === previous.hash)) throw new CoreError('COMMAND_DEPENDENCIES_CHANGED', 'A reviewed fixed script/config changed; enroll a new trusted recipe', 'commandId', 'recipe', 'Have the host review the changed dependency');
    if (hash(readFileSync(recipe.executable)) !== recipe.executableHash) throw new CoreError('COMMAND_DEPENDENCIES_CHANGED', undefined, 'commandId');
    const command: ReviewedCommand & { executableHash: string } = { commandId: recipe.recipeId, executable: recipe.executable, executableHash: recipe.executableHash, args: recipe.args.map(substitute), timeoutMs: recipe.timeoutMs, dependencies, ...(recipe.writeScope ? { writeScope: recipe.writeScope } : {}) };
    const targetDirectories = dependencies.filter((entry) => !path.relative(project.rootPath, entry.path).startsWith('..')).map((entry) => path.dirname(entry.path));
    return { input: { ...input }, project, command, ...discoverPolicies(project.rootPath, targetDirectories) };
  }
  if (typeof input.path !== 'string' || !input.path || path.isAbsolute(input.path) || input.path.includes('\0')) invalid('path', 'Use a relative file path');
  const target = path.resolve(project.rootPath, input.path);
  const relative = path.relative(project.rootPath, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid('path', 'The file must be inside the selected project');
  assertOutsidePrivateRuntime(target,options.privateRuntimeRoots??[]);
  const create = input.operation === 'file.write' && input.expectedSha256 === null;
  if (create) {
    const parent=path.dirname(target);
    filesystem('path',()=>{if(realpathSync(parent)!==parent||lstatSync(parent).isSymbolicLink()||!lstatSync(parent).isDirectory())invalid('path','Create inside an existing regular project directory');});
    if(existsSync(target))throw new CoreError('FILE_VERSION_CONFLICT','The path must still be absent; read it or choose another path','expectedSha256');
    if(typeof input.content!=='string'||Buffer.byteLength(input.content)>65536)invalid('content','Supply UTF-8 replacement content up to 64 KiB');
    const policies=discoverPolicies(project.rootPath,[parent]);
    return {input:{...input},project,target,beforeSha256:null,afterSha256:hash(input.content),...policies};
  }
  const bytes = filesystem('path', () => {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || realpathSync(target) !== target) invalid('path', 'Select a regular file without redirected paths');
    return readFileSync(target);
  });
  if (bytes.length > 1024 * 1024) invalid('path', 'Files above 1 MiB require a bounded range operation');
  const beforeSha256 = hash(bytes);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) invalid('path', 'This operation requires UTF-8; binary files need a qualified provider');
  const policies = discoverPolicies(project.rootPath, [path.dirname(target)]);
  if (input.operation === 'file.write') {
    if (!/^[a-f0-9]{64}$/.test(input.expectedSha256 ?? '')) invalid('expectedSha256', 'Supply the SHA-256 of the exact current bytes');
    if (input.expectedSha256 !== beforeSha256) throw new CoreError('FILE_VERSION_CONFLICT', 'Read the current bytes and prepare again', 'expectedSha256');
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 65536) invalid('content', 'Supply UTF-8 replacement content up to 64 KiB');
    return { input: { ...input }, project, target, beforeSha256, afterSha256: hash(input.content), ...policies };
  }
  return { input: { ...input }, project, target, beforeSha256, ...policies };
}
export const PRODUCT_CATALOG: readonly CatalogEntry[] = [
  { name: 'file.read', state: 'available', description: 'Grace reads an explicitly selected UTF-8 file after actual project-policy pre-work.', controller: 'grace' },
  { name: 'file.write', state: 'available', description: 'Grace changes exact approved UTF-8 bytes with before/after SHA-256 and retained original.', controller: 'grace' },
  { name: 'command.run', state: 'available', description: 'Grace starts a host-reviewed immutable recipe with frozen script/config dependencies.', controller: 'grace' },
  ...['browser','excel','word','powerpoint','cad','library.workflow'].map((name): CatalogEntry => ({ name, state: 'unsupported', description: 'Provider-specific governed operation', controller: 'grace', reason: 'PROVIDER_NOT_QUALIFIED' })),
];
