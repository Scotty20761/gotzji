import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export class WorkspaceIndexBusyError extends Error {
  public constructor() { super('Workspace index is busy in another runtime; retry after its update finishes'); }
}

export async function withWorkspaceIndexMutex<T>(
  directory: string,
  workspaceId: string,
  mutation: () => Promise<T>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const lockDirectory = path.join(directory, '.locks');
  await mkdir(lockDirectory, { recursive: true });
  const filename = path.join(lockDirectory, `${createHash('sha256').update(workspaceId).digest('hex')}.sqlite`);
  const deadline = performance.now() + Math.max(1, Math.min(10_000, options.timeoutMs ?? 10_000));
  const database = await acquire(filename, deadline, options.signal);
  let mutationFailed = false;
  try {
    options.signal?.throwIfAborted();
    return await mutation();
  } catch (error: unknown) {
    mutationFailed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { database.exec('ROLLBACK'); } catch (error: unknown) { cleanupError = error; }
    try { database.close(); } catch (error: unknown) { cleanupError ??= error; }
    if (cleanupError !== undefined && !mutationFailed) {
      console.warn('Workspace index mutation completed but mutex cleanup failed');
    }
  }
}

async function acquire(filename: string, deadline: number, signal?: AbortSignal): Promise<DatabaseSync> {
  for (;;) {
    signal?.throwIfAborted();
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(filename, { timeout: 0 });
      database.exec('BEGIN IMMEDIATE');
      return database;
    } catch (error: unknown) {
      database?.close();
      if (!isSqliteBusy(error)) throw error;
      if (performance.now() >= deadline) throw new WorkspaceIndexBusyError();
      await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error
    && typeof error.errcode === 'number' && (error.errcode & 0xff) === 5;
}
