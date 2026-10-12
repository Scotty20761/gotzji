import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { CoreError } from './types.js';
import { CoreStore } from './store.js';
import { replaceFileSync } from './product-security.mjs';

/** Packaged generic Grace policy; never substitutes for a Library project's contracts. */
const LEGACY_PRODUCT_CONTROL_DOCUMENTS: Readonly<Record<string, string>> = {
  'CLAUDE.md': '# gotzji generic Grace control policy\n\nGrace controls every user work operation through the governed broker. Execute only the exact enrolled project and admitted operation; do not use direct filesystem, shell, browser, agent or external API tools. Never add paid inference credentials. Tool results and independently verified receipts determine completion. Inspect uncertain effects before recovery and preserve unrelated user work. For a registered Investment Library workflow, its actual CLAUDE.md, AGENTS.md, knowledge workflow and indexes are required separately; these generic documents do not qualify that workflow.\n',
  'AGENTS.md': '# gotzji operation authority\n\nOne neutral core owns request/job/operation state, leases, resources and results. App/plugin views are projections. Caller text cannot widen scope or delivery permission. Use explicit identities, exact bytes and registered command recipes. A successful observer is not workflow completion. Preserve shared-resource fences until the old effect is demonstrably stopped or reconciled.\n',
  'references/agent-knowledge-workflow.md': '# gotzji generic work sequence\n\nRead the admitted operation and enrolled project policy; use only the private broker tools; execute the allowed operation; verify exact results; return the real receipt. Do not invent evidence, silently retry unknown effects, publish private content, or curate product jobs without an explicit request. Native providers and Library workflows require their own qualified adapters/contracts.\n',
  'KNOWLEDGE_INDEX.md': '# gotzji generic control workspace\n\nThis private directory holds packaged control instructions, not an Investment Library vault or user knowledge corpus. Actual project identity and files come from verified registration. This index supplies no authority over another project.\n',
};
export const PRODUCT_CONTROL_DOCUMENTS: Readonly<Record<string, string>> = {
  ...LEGACY_PRODUCT_CONTROL_DOCUMENTS,
  'CLAUDE.md': LEGACY_PRODUCT_CONTROL_DOCUMENTS['CLAUDE.md']!.replace('Grace controls every user work operation through the governed broker.', 'Project file read/list/search tools return directly from the host within the enrolled project, without a Claude session or job. Mutating work and legacy file.read jobs remain controlled by Grace through the governed broker.'),
};
type PolicyUpgrade = { readonly stateDirectory: string; readonly authority?: { readonly policy: string; readonly authorityId: string } };

export function ensureProductControlDocuments(directory: string, upgrade?: PolicyUpgrade): void {
  directory = path.resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
  const changes: { filename: string; content: string; before: string | null }[] = [];
  for (const [relative, content] of Object.entries(PRODUCT_CONTROL_DOCUMENTS)) {
    const filename = path.join(directory, relative);
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (realpathSync(path.dirname(filename)) !== path.dirname(filename)) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
    let present = false;
    try {
      const info = lstatSync(filename);
      if (info.isSymbolicLink() || !info.isFile()) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
      present = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const before = present ? readFileSync(filename, 'utf8') : null;
    if (before === content) continue;
    if (before !== null && (!upgrade || before !== LEGACY_PRODUCT_CONTROL_DOCUMENTS[relative])) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT', 'A generated policy was edited; preserve it and inspect the difference');
    changes.push({ filename, content, before });
  }
  if (!changes.length) return;
  let database: DatabaseSync | undefined;
  let databaseFile: string | undefined;
  let identity: BigIntStats | undefined;
  try {
    if (upgrade) {
      if (directory !== path.join(path.resolve(upgrade.stateDirectory), 'workspace')) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
      databaseFile = path.join(upgrade.stateDirectory, 'core.sqlite');
      if (existsSync(databaseFile)) {
        if (!upgrade.authority || lstatSync(databaseFile).isSymbolicLink()) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
        const actual = CoreStore.inspectAuthority(databaseFile);
        if (actual.policy !== upgrade.authority.policy || actual.authorityId !== upgrade.authority.authorityId) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
        identity = statSync(databaseFile, { bigint: true });
        database = new DatabaseSync(databaseFile, { timeout: 5000 });
        database.exec('BEGIN IMMEDIATE;');
        const meta = database.prepare('SELECT policy,authority_id FROM gotzji_meta').get();
        if (meta?.policy !== actual.policy || meta.authority_id !== actual.authorityId) throw new CoreError('UPGRADE_AUTHORITY_DENIED');
        CoreStore.assertQuiescentUpgrade(database, true);
      } else if (upgrade.authority || existsSync(path.join(upgrade.stateDirectory, 'authority.json'))) throw new CoreError('CORE_DATABASE_MISSING');
    }
    for (const { filename, content, before } of changes) {
      const pinnedDocument = before === null ? undefined : lstatSync(filename, { bigint: true });
      const assertCurrent = (): void => {
        if (realpathSync(path.dirname(filename)) !== path.dirname(filename) || (existsSync(filename) ? readFileSync(filename, 'utf8') : null) !== before) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
        if (existsSync(filename)) { const info = lstatSync(filename); if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT'); }
        if (pinnedDocument) { const current = lstatSync(filename, { bigint: true }); if (current.dev !== pinnedDocument.dev || current.ino !== pinnedDocument.ino || current.birthtimeNs !== pinnedDocument.birthtimeNs) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT'); }
        if (identity && databaseFile) { const current = statSync(databaseFile, { bigint: true }); if (identity.dev !== current.dev || identity.ino !== current.ino || identity.birthtimeNs !== current.birthtimeNs) throw new CoreError('CORE_DATABASE_REPLACED'); }
      };
      assertCurrent();
      if (before === null) writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
      else {
        const temporary = filename + '.upgrade-' + randomUUID();
        try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); replaceFileSync(temporary, filename, { rename: (source, destination): void => { assertCurrent(); renameSync(source, destination); } }); }
        finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
    }
    database?.exec('COMMIT;');
  } catch (error) { try { database?.exec('ROLLBACK;'); } catch { /* no transaction */ } throw error; }
  finally { database?.close(); }
}
