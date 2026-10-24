import { createHash } from 'node:crypto';

const actors = new Set(['mammos', 'facty', 'indie']);
export function canonicalSpokePolicy(source, actor) {
  if (!actors.has(actor) || typeof source !== 'string') throw new Error('LIBRARY_SPOKE_ROLE_DENIED');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/u.exec(source);
  if (!match?.[1]?.trim()) throw new Error('LIBRARY_CANONICAL_AGENT_INVALID');
  const value = { [actor]: { description: `Canonical ${actor} persona under a task-bound gotzji policy`, prompt: match[1], tools: [] } };
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return { content, policyAdapterSha256: createHash('sha256').update(content).digest('hex') };
}
