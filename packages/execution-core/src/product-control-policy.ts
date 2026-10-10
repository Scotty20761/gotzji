import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CoreError } from './types.js';

/** Packaged generic Grace policy; never substitutes for a Library project's contracts. */
export const PRODUCT_CONTROL_DOCUMENTS: Readonly<Record<string, string>> = {
  'CLAUDE.md': '# gotzji generic Grace control policy\n\nGrace controls every user work operation through the governed broker. Execute only the exact enrolled project and admitted operation; do not use direct filesystem, shell, browser, agent or external API tools. Never add paid inference credentials. Tool results and independently verified receipts determine completion. Inspect uncertain effects before recovery and preserve unrelated user work. For a registered Investment Library workflow, its actual CLAUDE.md, AGENTS.md, knowledge workflow and indexes are required separately; these generic documents do not qualify that workflow.\n',
  'AGENTS.md': '# gotzji operation authority\n\nOne neutral core owns request/job/operation state, leases, resources and results. App/plugin views are projections. Caller text cannot widen scope or delivery permission. Use explicit identities, exact bytes and registered command recipes. A successful observer is not workflow completion. Preserve shared-resource fences until the old effect is demonstrably stopped or reconciled.\n',
  'references/agent-knowledge-workflow.md': '# gotzji generic work sequence\n\nRead the admitted operation and enrolled project policy; use only the private broker tools; execute the allowed operation; verify exact results; return the real receipt. Do not invent evidence, silently retry unknown effects, publish private content, or curate product jobs without an explicit request. Native providers and Library workflows require their own qualified adapters/contracts.\n',
  'KNOWLEDGE_INDEX.md': '# gotzji generic control workspace\n\nThis private directory holds packaged control instructions, not an Investment Library vault or user knowledge corpus. Actual project identity and files come from verified registration. This index supplies no authority over another project.\n',
};

export function ensureProductControlDocuments(directory: string): void {
  for (const [relative, content] of Object.entries(PRODUCT_CONTROL_DOCUMENTS)) {
    const filename = path.join(directory, relative);
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (existsSync(filename)) {
      if (readFileSync(filename, 'utf8') !== content) throw new CoreError('PRODUCT_CONTROL_POLICY_DRIFT');
    } else writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
  }
}
