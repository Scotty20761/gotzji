/* global Buffer */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const SHA256 = /^[a-f0-9]{64}$/u;
const ATOM_ID = /^ATOM-[0-9]{4,}$/u;

export function finalMemoPreflight(prepared) {
  const metadata = assertFinalMemoPrepared(prepared);
  const root = prepared.project.rootPath;
  const target = inside(root, metadata.targetRelativePath);
  if (existsSync(target)) fail('LIBRARY_CANONICAL_MEMO_EXISTS');
  const tracked = {
    pipeline: regular(root, 'pipeline.md'),
    outputsIndex: regular(root, 'indexes/INDEX_outputs.md'),
    tickerIndex: regular(root, `indexes/tickers/${metadata.ticker}.md`),
    knowledgeIndex: regular(root, 'knowledge-base/index.md'),
    topicMap: regular(root, 'knowledge-base/topic-map.md'),
    contradictionRegistry: regular(root, 'knowledge-base/contradiction-registry.md'),
  };
  return {
    ticker: metadata.ticker,
    period: metadata.period,
    targetRelativePath: metadata.targetRelativePath,
    requiredInputs: {
      card: metadata.cardRelativePath,
      filings: [...metadata.filingRelativePaths],
      earnings: [...metadata.earningsRelativePaths],
    },
    baselines: Object.fromEntries(Object.entries(tracked).map(([key, filename]) => [key, digest(readFileSync(filename))])),
    navigationSnapshot: captureNavigationSnapshot(prepared),
  };
}

export function captureNavigationSnapshot(prepared) {
  assertFinalMemoPrepared(prepared);
  const root = prepared.project.rootPath;
  const files = ['KNOWLEDGE_INDEX.md', 'knowledge-base/index.md', 'knowledge-base/topic-map.md', 'knowledge-base/contradiction-registry.md'];
  for (const directory of ['indexes', 'indexes/tickers', 'indexes/themes', 'indexes/authors']) {
    const absolute = path.join(root, directory); if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.md')) files.push(`${directory}/${entry.name}`);
  }
  return Object.fromEntries([...new Set(files)].sort().flatMap((relative) => {
    const target = inside(root, relative); if (!existsSync(target)) return [[relative, null]];
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || realpathSync(target) !== target) fail('LIBRARY_NAVIGATION_SCOPE_INVALID');
    return [[relative, digest(readFileSync(target))]];
  }));
}

export function navigationEffects(before, after) {
  if (!before || !after) fail('LIBRARY_NAVIGATION_RECEIPT_INVALID');
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.filter((relative) => before[relative] !== after[relative]).map((relative) => ({ relativePath: relative, beforeSha256: before[relative] ?? null, afterSha256: after[relative] ?? null }));
}

export function assertNavigationSnapshot(prepared, expected) {
  const actual = captureNavigationSnapshot(prepared);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('LIBRARY_NAVIGATION_CHANGED');
  return actual;
}

export function assertFinalMemoBaseline(prepared, preflight, names) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!preflight || preflight.ticker !== metadata.ticker || preflight.targetRelativePath !== metadata.targetRelativePath) fail('LIBRARY_MEMO_PREFLIGHT_INVALID');
  const paths = {
    pipeline: 'pipeline.md', outputsIndex: 'indexes/INDEX_outputs.md', tickerIndex: `indexes/tickers/${metadata.ticker}.md`,
    knowledgeIndex: 'knowledge-base/index.md', topicMap: 'knowledge-base/topic-map.md', contradictionRegistry: 'knowledge-base/contradiction-registry.md',
  };
  for (const name of names) {
    if (!SHA256.test(preflight.baselines?.[name] ?? '') || digest(readFileSync(regular(prepared.project.rootPath, paths[name]))) !== preflight.baselines[name]) fail('LIBRARY_CANONICAL_TARGET_CHANGED');
  }
}

export function mammosPrompt(prepared) {
  const metadata = assertFinalMemoPrepared(prepared);
  return [
    `Act as Mammos for one task-bound final Investment Memo for ${metadata.ticker}.`,
    'Use only the supplied frozen evidence. Return the complete Thai-primary Markdown memo, including valid YAML frontmatter with type: memo, plural tickers, related links, and a complete ## 🔄 Handoff block.',
    'Do not claim that it was saved, indexed, audited, atomized, delivered, committed, pushed, synced to Notion/NotebookLM, or sent to Telegram. Those are later host-controlled effects.',
    'If a required fact is absent, state the dependency gap instead of guessing.',
  ].join('\n');
}

export function factyPrompt(prepared, mammos) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!mammos || typeof mammos.content !== 'string' || digest(mammos.content) !== mammos.artifactDigest) fail('LIBRARY_MAMMOS_ARTIFACT_INVALID');
  return [
    `Act as Facty for one task-bound audit of Mammos's final Investment Memo for ${metadata.ticker}.`,
    'Audit the supplied draft against the frozen evidence. Return Markdown beginning with exactly VERDICT: PASS, VERDICT: CAVEATS, or VERDICT: BLOCK.',
    'Never claim persistence, index, pipeline, atom, delivery, commit, push, Notion, NotebookLM, or Telegram effects.',
    `\n## Mammos draft\n${mammos.content}`,
  ].join('\n');
}

export function indiePrompt(prepared, memo) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!memo || typeof memo.path !== 'string' || typeof memo.sha256 !== 'string') fail('LIBRARY_CANONICAL_MEMO_RECEIPT_INVALID');
  return [
    `Act as Indie for one task-bound extraction from the audited ${metadata.ticker} memo below.`,
    'Return JSON only: {"atoms":[{"topic":"...","thesis":"bull|bear|neutral|contra","confidence":"high|medium|low","content":"Thai insight in 1-3 sentences","contradicts":["ATOM-0001-existing-slug"],"contradictionReason":"..."}]}. Use empty contradicts when none.',
    'Return one to three load-bearing atoms. Do not invent facts, IDs, paths, writes, index changes, or delivery claims.',
    `\n## Audited memo\n${readFileSync(regular(prepared.project.rootPath, memo.path), 'utf8')}`,
  ].join('\n');
}

export function assembleAuditedMemo(prepared, mammos, facty) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!mammos || typeof mammos.content !== 'string' || digest(mammos.content) !== mammos.artifactDigest) fail('LIBRARY_MAMMOS_ARTIFACT_INVALID');
  if (!facty || typeof facty.content !== 'string' || !['PASS', 'CAVEATS'].includes(facty.verdict) || digest(facty.content) !== facty.artifactDigest) fail('LIBRARY_FACTY_ARTIFACT_INVALID');
  const draft = mammos.content.trim();
  if (!/^---\s*[\s\S]*?^---/mu.test(draft) || !/^type:\s*memo\s*$/imu.test(draft)
    || !/^tickers:\s*(?:\[[^\]]+\]|\n\s*-\s*\S+)/imu.test(draft) || !/^#{2,3}\s+.*Handoff/im.test(draft)) fail('LIBRARY_MAMMOS_OUTPUT_INVALID');
  const content = `${draft}\n\n---\n\n## 🛡 Facty Audit\n\n${facty.content.trim()}\n`;
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) fail('LIBRARY_CANONICAL_MEMO_TOO_LARGE');
  return { ticker: metadata.ticker, path: metadata.targetRelativePath, content, sha256: digest(content), verdict: facty.verdict };
}

export function writeCanonicalMemo(prepared, assembled) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!assembled || assembled.path !== metadata.targetRelativePath || assembled.sha256 !== digest(assembled.content)) fail('LIBRARY_CANONICAL_MEMO_RECEIPT_INVALID');
  const target = inside(prepared.project.rootPath, assembled.path);
  const parent = path.dirname(target);
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) fail('LIBRARY_CANONICAL_MEMO_DIRECTORY_INVALID');
  try { writeFileSync(target, assembled.content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { fail(error?.code === 'EEXIST' ? 'LIBRARY_CANONICAL_MEMO_EXISTS' : 'LIBRARY_CANONICAL_MEMO_WRITE_FAILED', 'unknown'); }
  if (digest(readFileSync(regular(prepared.project.rootPath, assembled.path))) !== assembled.sha256) fail('LIBRARY_CANONICAL_MEMO_WRITE_UNVERIFIED', 'unknown');
  return { path: assembled.path, sha256: assembled.sha256, verdict: assembled.verdict, sizeBytes: Buffer.byteLength(assembled.content) };
}

export function parseIndieAtoms(value) {
  let candidate = value?.atoms ? value : value?.content;
  if (typeof candidate === 'string') {
    const text = candidate.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { candidate = JSON.parse(text); } catch { fail('LIBRARY_INDIE_OUTPUT_INVALID'); }
  }
  if (!candidate || !Array.isArray(candidate.atoms) || candidate.atoms.length < 1 || candidate.atoms.length > 3) fail('LIBRARY_INDIE_OUTPUT_INVALID');
  return candidate.atoms.map((atom) => {
    if (!atom || Object.keys(atom).some((key) => !['topic', 'thesis', 'confidence', 'content', 'contradicts', 'contradictionReason'].includes(key))
      || typeof atom.topic !== 'string' || !/^[^\r\n]{1,100}$/u.test(atom.topic)
      || !['bull', 'bear', 'neutral', 'contra'].includes(atom.thesis) || !['high', 'medium', 'low'].includes(atom.confidence)
      || typeof atom.content !== 'string' || atom.content.trim().length < 10 || Buffer.byteLength(atom.content, 'utf8') > 10_000
      || (atom.contradicts !== undefined && (!Array.isArray(atom.contradicts) || atom.contradicts.length > 3 || atom.contradicts.some((entry) => !/^ATOM-[0-9]{4,}-[a-z0-9-]+$/iu.test(entry))))
      || ((atom.contradicts?.length ?? 0) > 0 && (typeof atom.contradictionReason !== 'string' || atom.contradictionReason.trim().length < 5 || /[\r\n]/u.test(atom.contradictionReason)))) fail('LIBRARY_INDIE_OUTPUT_INVALID');
    return { topic: atom.topic.trim(), thesis: atom.thesis, confidence: atom.confidence, content: atom.content.trim(), contradicts: [...(atom.contradicts ?? [])], contradictionReason: atom.contradictionReason?.trim() ?? '' };
  });
}

export function appendContradictionRegistry(prepared, preflight, atoms, written, memo) {
  const relative = 'knowledge-base/contradiction-registry.md'; const target = regular(prepared.project.rootPath, relative);
  if (digest(readFileSync(target)) !== preflight.baselines?.contradictionRegistry) fail('LIBRARY_CANONICAL_TARGET_CHANGED');
  const additions = atoms.flatMap((atom, index) => (atom.contradicts ?? []).map((existing) => {
    const created = path.basename(written[index]?.path ?? '', '.md'); if (!created) fail('LIBRARY_ATOM_WRITEBACK_MISSING');
    return `- [[${created}|${written[index].id}]] contradicts [[${existing}|${existing.split('-').slice(0,2).join('-')}]] — ${atom.contradictionReason} — source [[${path.basename(memo.path, '.md')}]]`;
  }));
  if (additions.length === 0) return { path: relative, changed: false, sha256: digest(readFileSync(target)) };
  const before = readFileSync(target, 'utf8'); const content = `${before.trimEnd()}\n${additions.join('\n')}\n`; const temporary = `${target}.gotzji-${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); if (digest(readFileSync(target)) !== preflight.baselines.contradictionRegistry) fail('LIBRARY_CANONICAL_TARGET_CHANGED'); renameSync(temporary, target);
  return { path: relative, changed: true, sha256: digest(content), additions: additions.length };
}

export function writeReservedAtom(prepared, reservation, atom, memo) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!reservation || !ATOM_ID.test(reservation.id) || typeof reservation.path !== 'string' || !SHA256.test(reservation.sha256)) fail('LIBRARY_ATOM_RESERVATION_INVALID');
  const atomsRoot = realpathSync(path.join(prepared.project.rootPath, 'knowledge-base', 'atoms'));
  const target = realpathSync(reservation.path);
  const relative = path.relative(atomsRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(target) !== `${reservation.id}-pending.md`
    || lstatSync(target).isSymbolicLink() || digest(readFileSync(target)) !== reservation.sha256) fail('LIBRARY_ATOM_RESERVATION_CHANGED');
  const sourceStem = path.basename(memo.path, '.md');
  const yamlTopic = JSON.stringify(atom.topic);
  const content = `---\nid: ${reservation.id}\ndate: ${metadata.period}-01\ntype: atom\ntickers: [${metadata.ticker}]\ntopic: ${yamlTopic}\nthesis: ${atom.thesis}\nconfidence: ${atom.confidence}\nsource: ${memo.path}\nstatus: candidate\nrelated:\n  - '[[${memo.path}]]'\n---\n\n${atom.content}\n\n**Source:** [[${sourceStem}]]\n`;
  const temporary = path.join(atomsRoot, `.${reservation.id}-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  if (digest(readFileSync(target)) !== reservation.sha256) fail('LIBRARY_ATOM_RESERVATION_CHANGED');
  renameSync(temporary, target);
  return { id: reservation.id, path: path.relative(prepared.project.rootPath, target).replaceAll('\\', '/'), sha256: digest(content), sourceStem };
}

export function verifyFinalMemoEvidence(prepared, memo, atoms) {
  const metadata = assertFinalMemoPrepared(prepared);
  if (!memo || memo.path !== metadata.targetRelativePath || !SHA256.test(memo.sha256)) fail('LIBRARY_CANONICAL_MEMO_RECEIPT_INVALID');
  const memoBytes = readFileSync(regular(prepared.project.rootPath, memo.path));
  const memoText = memoBytes.toString('utf8');
  if (digest(memoBytes) !== memo.sha256 || !/^## 🛡 Facty Audit/mu.test(memoText) || !/VERDICT:\s*(PASS|CAVEATS)/iu.test(memoText) || !/^#{2,3}\s+.*Handoff/im.test(memoText)) fail('LIBRARY_CANONICAL_MEMO_VERIFICATION_FAILED');
  const pipeline = readFileSync(regular(prepared.project.rootPath, 'pipeline.md'), 'utf8');
  const row = pipeline.split(/\r?\n/u).find((line) => line.startsWith('|') && new RegExp(`(?:^|[^A-Z0-9])${escapeRegExp(metadata.ticker)}(?:[^A-Z0-9]|$)`, 'u').test(line));
  if (!row || !row.includes('📊') || !row.includes('Mammos')) fail('LIBRARY_PIPELINE_WRITEBACK_MISSING');
  const basename = path.basename(memo.path);
  for (const indexPath of ['indexes/INDEX_outputs.md', `indexes/tickers/${metadata.ticker}.md`]) if (!readFileSync(regular(prepared.project.rootPath, indexPath), 'utf8').includes(basename)) fail('LIBRARY_INDEX_WRITEBACK_MISSING');
  if (!Array.isArray(atoms) || atoms.length < 1 || atoms.length > 3) fail('LIBRARY_ATOM_WRITEBACK_MISSING');
  for (const atom of atoms) {
    const text = readFileSync(regular(prepared.project.rootPath, atom.path), 'utf8');
    if (digest(text) !== atom.sha256 || !text.includes(basename) || !text.includes(`tickers: [${metadata.ticker}]`)) fail('LIBRARY_ATOM_BACKLINK_MISSING');
    if (!readFileSync(regular(prepared.project.rootPath, 'knowledge-base/index.md'), 'utf8').includes(atom.id)
      || !readFileSync(regular(prepared.project.rootPath, 'knowledge-base/topic-map.md'), 'utf8').includes(atom.id)) fail('LIBRARY_ATOM_INDEX_WRITEBACK_MISSING');
  }
  return { path: memo.path, sha256: memo.sha256, verdict: memo.verdict, atomPaths: atoms.map((atom) => atom.path), verified: true };
}

export function assertFinalMemoPrepared(prepared) {
  const metadata = prepared?.library?.finalMemo;
  if (prepared?.library?.ast?.workflowId !== 'library.final-memo' || prepared.library.ast.workflowVersion !== 2 || !metadata
    || !/^[A-Z][A-Z0-9.-]{0,9}$/u.test(metadata.ticker) || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(metadata.period)
    || metadata.targetRelativePath !== `team-outputs/memos/${metadata.ticker}_memo_${metadata.period}.md`) fail('LIBRARY_FINAL_MEMO_PREPARATION_REQUIRED');
  return metadata;
}

function regular(root, relative) {
  const target = inside(root, relative);
  if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || realpathSync(target) !== target) fail('LIBRARY_CANONICAL_ARTIFACT_INVALID');
  return target;
}

function inside(root, relative) {
  if (!relative || path.isAbsolute(relative)) fail('LIBRARY_CANONICAL_PATH_INVALID');
  const target = path.resolve(root, relative); const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('LIBRARY_CANONICAL_PATH_INVALID');
  return target;
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function fail(code, outcome = 'none') { const error = new Error(code); error.code = code; error.outcome = outcome; throw error; }
