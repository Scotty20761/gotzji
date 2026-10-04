import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { ExecutionCore } from './core.js';
import type { GraceRegistration } from './grace-profile.js';
const registration: GraceRegistration = {
  executable: path.join(process.env.USERPROFILE ?? os.homedir(),'.local','bin','claude.exe'),
  libraryRoot: 'E:/Investment Library',
  sourceFile: fileURLToPath(new URL('../README.md',import.meta.url)),
};
const directory = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(),'gotzji','execution-core','grace-slice',randomUUID());
const core = await ExecutionCore.open(directory,{grace:registration});
const credential = core.enrollAdapter('gotzji','qualification-owner');
const preparation = core.prepareSourceSnapshot(credential,'grace-source-snapshot');
const job = await core.submit(credential,preparation.preparationId); const binding=core.select(credential,job.jobId);
try {
  await core.resume(credential,binding); core.startSupervisor();
  for (let n=0;n<240;n++) {
    const result=await core.result(credential,binding);
    if (result.status==='completed') {
      const reopened = await ExecutionCore.open(directory,{grace:registration});
      try {
        const another=reopened.enrollAdapter('lnwjud-library','qualification-owner');
        const same=await reopened.result(another,reopened.select(another,job.jobId));
        process.stdout.write(JSON.stringify({coverage:'actual-Grace-private-source-snapshot',directory,result:same})+'\n');
      } finally { reopened.close(); }
      break;
    }
    if (result.status==='blocked' || result.status==='failed') throw new Error('Grace slice requires reconciliation');
    await core.tick(); await new Promise((resolve)=>setTimeout(resolve,1000));
    if(n===239) throw new Error('Grace slice timed out');
  }
} catch (error) {
  try { await core.cancel(credential,binding); } catch { /* preserve unresolved owned work */ }
  const message=error instanceof Error ? error.message : 'Grace slice not verified';
  process.stdout.write(JSON.stringify({coverage:'actual-Grace-private-source-snapshot',directory,status:'not-verified',reason:message})+'\n');
  process.exitCode=1;
} finally { core.close(); }
// Sensitive CLI logs and broker credentials stay in the private run directory.
