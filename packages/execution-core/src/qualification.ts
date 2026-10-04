import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ExecutionCore } from './core.js';

const directory = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'gotzji', 'execution-core', 'qualification', randomUUID());
const core = await ExecutionCore.open(directory);
const gotzji = core.enrollAdapter('gotzji', 'qualification-owner');
const lnwjud = core.enrollAdapter('lnwjud-library', 'qualification-owner');
const prepared = core.prepare(gotzji, { requestId: 'qualification-one', operation: 'fixture.write', text: 'gotzji independent effect verification' });
const job = await core.submit(gotzji, prepared.preparationId);
const binding = core.select(gotzji, job.jobId);
try {
  await core.resume(gotzji, binding);
  core.close();
  const recovered = await ExecutionCore.open(directory);
  try {
    await recovered.tick();
    const result = await recovered.result(lnwjud, recovered.select(lnwjud, job.jobId));
    if (result.status !== 'completed') throw new Error('qualification incomplete');
    process.stdout.write(JSON.stringify({ qualification: 'neutral-core-only', directory, channels: ['gotzji-fixture', 'lnwjud-library-fixture'], result }) + '\n');
  } finally { recovered.close(); }
} catch (error) {
  try { await core.cancel(gotzji, binding); } catch { /* preserve uncertain evidence */ }
  try { core.close(); } catch { /* already detached */ }
  throw error;
}
