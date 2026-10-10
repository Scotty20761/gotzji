/** An error code or code-shaped message, otherwise `fallback`; never free text that can carry paths (incident I8). */
export function providerFailureCode(error: unknown, fallback: string): string;
export function childEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizedStream(emit: (value: string) => void): { write(chunk: Buffer): void; end(): void };
export function replaceFileSync(temporary: string, target: string, options?: {
  rename?: (temporary: string, target: string) => void;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => void;
}): void;
