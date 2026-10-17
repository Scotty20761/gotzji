import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const { issueSyntheticCleanupCapability, syntheticCleanupAuthorizer } = await import('./test-worker-cleanup.mjs');
const roots:string[]=[];
async function fixture():Promise<{root:string;directory:string;entrypoint:string;config:{jobId:string;epoch:string;token:string;operation:string;text:string;grace:{mode:string;recipe:string;testDriver:string;testDriverHash:string;libraryRoot:string}}}>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'gotzji-library-')));roots.push(root);
  const directory=path.join(root,'state','workers','worker');await mkdir(directory,{recursive:true});await mkdir(path.join(root,'library'));
  return {root,directory,entrypoint:path.join(root,'source','fixture-worker.mjs'),config:{jobId:'job',epoch:'epoch',token:'a'.repeat(64),operation:'grace.product-operation',text:JSON.stringify({kind:'library'}),grace:{mode:'test-driver',recipe:'product',testDriver:'fixture-driver',testDriverHash:'b'.repeat(64),libraryRoot:path.join(root,'library')}}};
}
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('accepts only its signed capability once and leaves normal job/effect state untouched',async()=>{
  const f=await fixture();const before=JSON.stringify(f.config);const nonce=issueSyntheticCleanupCapability(f.config,f.directory,f.entrypoint);const saved=await readFile(path.join(f.directory,'synthetic-test-cleanup.json'));const authorize=syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint);
  expect(authorize('f'.repeat(64))).toBe(false);expect(authorize(nonce)).toBe(true);expect(authorize(nonce)).toBe(false);await writeFile(path.join(f.directory,'synthetic-test-cleanup.json'),saved);expect(syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint)(nonce)).toBe(false);expect(JSON.stringify(f.config)).toBe(before);
});
it('denies normal drivers, other operation kinds, installed directories and manifest-bearing runtime',async()=>{
  const f=await fixture();const nonce=issueSyntheticCleanupCapability(f.config,f.directory,f.entrypoint);
  for(const config of [{...f.config,grace:{...f.config.grace,mode:'claude'}},{...f.config,grace:{...f.config.grace,recipe:'code-check'}},{...f.config,grace:{...f.config.grace,testDriver:''}},{...f.config,grace:{...f.config.grace,libraryRoot:f.root}},{...f.config,text:JSON.stringify({kind:'native'})},{...f.config,operation:'fixture.hold'},{...f.config,epoch:'different'},{...f.config,jobId:'different'}])expect(syntheticCleanupAuthorizer(config,f.directory,f.entrypoint)(nonce)).toBe(false);
  expect(syntheticCleanupAuthorizer(f.config,f.directory,path.join(f.root,'gotzji-core','fixture-worker.mjs'))(nonce)).toBe(false);
  const runtime=path.join(f.root,'runtime');await mkdir(runtime);await writeFile(path.join(runtime,'product-runtime-manifest.json'),'{}');expect(syntheticCleanupAuthorizer(f.config,f.directory,path.join(runtime,'fixture-worker.mjs'))(nonce)).toBe(false);
  // Positive control: every denial above left the issued capability valid for its real context.
  expect(syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint)(nonce)).toBe(true);
});
it('denies tampered, expired and out-of-scope capabilities without consuming a valid one',async()=>{
  const f=await fixture();const nonce=issueSyntheticCleanupCapability(f.config,f.directory,f.entrypoint);
  const file=path.join(f.directory,'synthetic-test-cleanup.json');const value=JSON.parse(await readFile(file,'utf8')) as {body:string;mac:string};await writeFile(file,JSON.stringify({...value,mac:'0'.repeat(64)}));expect(syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint)(nonce)).toBe(false);
  await writeFile(file,JSON.stringify(value));const authorize=syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint);expect(authorize(nonce)).toBe(true);
  const fresh=issueSyntheticCleanupCapability(f.config,f.directory,f.entrypoint);const freshRecord=JSON.parse(await readFile(file,'utf8')) as {body:string};const expiredBody=JSON.stringify({...JSON.parse(freshRecord.body),expiresAt:Date.now()-1});await writeFile(file,JSON.stringify({body:expiredBody,mac:createHmac('sha256',f.config.token).update(expiredBody).digest('hex')}));expect(syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint)(fresh)).toBe(false);
  expect(()=>issueSyntheticCleanupCapability(f.config,path.join(f.root,'library'),f.entrypoint)).toThrow('TEST_CLEANUP_DENIED');
});
it.runIf(process.platform==='win32')('compares one canonical spelling of Temp and the worker directory',async()=>{
  // Hosted runners can spell TEMP as an 8.3 alias (RUNNER~1). A different-case spelling reaches the same split
  // between JavaScript realpath (keeps the given spelling) and native realpath on any Windows host.
  const f=await fixture();vi.spyOn(os,'tmpdir').mockReturnValue(f.root.slice(0,-path.basename(f.root).length-1).toUpperCase());
  const nonce=issueSyntheticCleanupCapability(f.config,f.directory,f.entrypoint);expect(syntheticCleanupAuthorizer(f.config,f.directory,f.entrypoint)(nonce)).toBe(true);
  const directory=f.directory.toUpperCase();const second=issueSyntheticCleanupCapability(f.config,directory,f.entrypoint);expect(syntheticCleanupAuthorizer(f.config,directory,f.entrypoint)(second)).toBe(true);
  expect(()=>issueSyntheticCleanupCapability(f.config,path.join(f.root,'library').toUpperCase(),f.entrypoint)).toThrow('TEST_CLEANUP_DENIED');
});
