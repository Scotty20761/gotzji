import { Console } from 'node:console';
const PREFIX = '[gotzji-git-read-budget] ';
const PHASES = ['census', 'metadata', 'config', 'object-directories', 'objects', 'worktree'] as const;
type Phase = typeof PHASES[number];
export interface GitReadDiagnostic {
  readonly schemaVersion: 1; readonly code: 'GIT_SNAPSHOT_BUDGET' | 'GIT_VALIDATION_BUDGET'; readonly phase: Phase;
  readonly elapsedMs: number; readonly phaseStartsMs: Readonly<Partial<Record<Phase, number>>>;
  readonly totalObjects: number; readonly copiedObjects: number; readonly copiedBytes: number; readonly ioThreads: number;
}
const fields = ['schemaVersion', 'code', 'phase', 'elapsedMs', 'phaseStartsMs', 'totalObjects', 'copiedObjects', 'copiedBytes', 'ioThreads'];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function valid(value: unknown): value is GitReadDiagnostic {
  return record(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
    && value.schemaVersion === 1 && (value.code === 'GIT_SNAPSHOT_BUDGET' || value.code === 'GIT_VALIDATION_BUDGET') && PHASES.includes(value.phase as Phase)
    && integer(value.elapsedMs, 3_600_000) && integer(value.totalObjects, 1_000_000) && integer(value.copiedObjects, value.totalObjects)
    && integer(value.copiedBytes, 512 * 1024 * 1024) && integer(value.ioThreads, 1024)
    && record(value.phaseStartsMs) && Object.keys(value.phaseStartsMs).every(key => PHASES.includes(key as Phase))
    && Object.values(value.phaseStartsMs).every(time => integer(time, value.elapsedMs as number));
}
export function formatGitReadDiagnostic(value: unknown): string | undefined {
  return valid(value) ? `${PREFIX}${JSON.stringify(value)}\n` : undefined;
}
export function parseGitReadDiagnostic(line: string): GitReadDiagnostic | undefined {
  if (!line.startsWith(PREFIX) || Buffer.byteLength(line) > 2048) return undefined;
  try { const value: unknown = JSON.parse(line.slice(PREFIX.length)); return valid(value) ? value : undefined; } catch { return undefined; }
}

/** Emit bounded private diagnostics without promoting a failed pipe to a runtime failure. */
export function writeGitReadDiagnostic(value: unknown, destination: NodeJS.WritableStream = process.stderr): void {
  try {
    const line = formatGitReadDiagnostic(value);
    if (line) new Console({ stdout: destination, stderr: destination, ignoreErrors: true }).error('%s', line.slice(0, -1));
  } catch { /* Observations must preserve the original runtime outcome. */ }
}
