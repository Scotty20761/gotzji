import type { DatabaseSync } from 'node:sqlite';
import { CoreError } from './types.js';

/** Conversation notes are separate from host policy, job status and effect receipts. */
export interface ProjectMemory {
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly resultPaths: readonly string[];
}
export interface ProjectMemorySnapshot extends ProjectMemory {
  readonly revision: number;
  readonly updatedAt: string | null;
}
export const EMPTY_PROJECT_MEMORY: ProjectMemorySnapshot = {
  revision: 0, updatedAt: null, summary: '', decisions: [], openQuestions: [], resultPaths: [],
};

export function readProjectMemory(db: DatabaseSync, owner: string, projectId: string): ProjectMemorySnapshot {
  const row = db.prepare('SELECT revision,body,updated_at FROM gotzji_project_memory WHERE owner=? AND project_id=?').get(owner, projectId);
  return row ? { ...JSON.parse(String(row.body)) as ProjectMemory, revision: Number(row.revision), updatedAt: String(row.updated_at) } : EMPTY_PROJECT_MEMORY;
}

export function writeProjectMemory(db: DatabaseSync, owner: string, projectId: string, input: {
  readonly expectedRevision: number; readonly memory: ProjectMemory;
}, now: string): ProjectMemorySnapshot {
  const memory = input.memory;
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !memory || Array.isArray(memory)
    || Object.keys(memory).sort().join(',') !== 'decisions,openQuestions,resultPaths,summary'
    || typeof memory.summary !== 'string' || memory.summary.length > 16000
    || [memory.decisions, memory.openQuestions, memory.resultPaths].some((items) => !Array.isArray(items) || items.length > 100
      || items.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2000))) {
    throw new CoreError('PROJECT_MEMORY_INVALID');
  }
  const body = JSON.stringify(memory);
  if (Buffer.byteLength(body) > 128 * 1024) throw new CoreError('PROJECT_MEMORY_TOO_LARGE');
  const changed = input.expectedRevision === 0
    ? db.prepare('INSERT OR IGNORE INTO gotzji_project_memory VALUES (?,?,1,?,?)').run(owner, projectId, body, now)
    : db.prepare('UPDATE gotzji_project_memory SET revision=revision+1,body=?,updated_at=? WHERE owner=? AND project_id=? AND revision=?')
      .run(body, now, owner, projectId, input.expectedRevision);
  if (changed.changes === 0) throw new CoreError('PROJECT_MEMORY_CONFLICT');
  return readProjectMemory(db, owner, projectId);
}
