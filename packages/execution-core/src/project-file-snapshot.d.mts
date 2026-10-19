export function projectFileBytesSync(target: string, limit?: number): Buffer;
export function copyProjectFileSnapshot(target: string, destination: string, expected: import('node:fs').BigIntStats, beforeWrite: (bytes: number) => void): Promise<number>;
