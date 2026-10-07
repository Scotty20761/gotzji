export function childEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizedStream(emit: (value: string) => void): { write(chunk: Buffer): void; end(): void };
export function replaceFileSync(temporary: string, target: string, options?: {
  rename?: (temporary: string, target: string) => void;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => void;
}): void;
