/* global process, URL */
import { readFileSync,existsSync,writeFileSync,renameSync,unlinkSync,lstatSync,realpathSync } from 'node:fs';
import { createHash,createHmac,randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

const localRuntimeFiles=[
 'phase-r-host-identity.mjs','phase-r-daemon.mjs','phase-r-frontend.mjs','core.js','grace-profile.js','store.js','managed-worker.js',
 'fixture-worker.mjs','grace-broker.mjs','grace-runtime.mjs','grace-stdio.mjs','grace-verifier.mjs','fingerprints.mjs',
 'phase-r-runner.mjs','phase-r-validator.mjs',
];
const nativeRuntimeEntries=['@lnwjud/application','@lnwjud/domain','@lnwjud/storage','@lnwjud/mcp-server/engineering-evidence-verifier'];
const importPattern=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
function digest(value){return createHash('sha256').update(value).digest('hex');}
function resolveLnwjjud(specifier,parent){
 const parts=specifier.split('/'),packageName=parts.slice(0,2).join('/'),subpath=parts.slice(2).join('/');let cursor=path.dirname(fileURLToPath(parent));
 while(true){
  const candidate=path.join(cursor,'node_modules',...packageName.split('/'),'package.json');
  if(existsSync(candidate)){
   const packageFile=realpathSync(candidate),manifest=JSON.parse(readFileSync(packageFile,'utf8')),key=subpath?`./${subpath}`:'.',entry=manifest.exports?.[key];
   const target=typeof entry==='string'?entry:typeof entry?.import==='string'?entry.import:entry?.import?.default;
   if(typeof target!=='string') throw new Error('HOST_RUNTIME_MANIFEST_INVALID');
   return pathToFileURL(realpathSync(path.join(path.dirname(packageFile),target)));
  }
  const parentDirectory=path.dirname(cursor);if(parentDirectory===cursor) break;cursor=parentDirectory;
 }
 throw new Error('HOST_RUNTIME_MANIFEST_INVALID');
}
export function hashJavaScriptClosure(entries){
 const pending=entries.map((entry)=>entry instanceof URL?entry:new URL(entry)),seen=new Map();
 while(pending.length){
  const current=pending.pop();if(!current||seen.has(current.href)) continue;
  const bytes=readFileSync(current);seen.set(current.href,digest(bytes));
  if(!/\.(?:m?js)$/i.test(current.pathname)) continue;
  const source=bytes.toString('utf8');importPattern.lastIndex=0;let match;
  while((match=importPattern.exec(source))!==null){
   const specifier=match[1];if(!specifier||( !specifier.startsWith('.')&&!specifier.startsWith('@lnwjud/'))) continue;
   const resolved=specifier.startsWith('.')?new URL(specifier,current):resolveLnwjjud(specifier,current);
   if(resolved.protocol==='file:'&&!seen.has(resolved.href)) pending.push(resolved);
  }
 }
 return digest([...seen].sort(([left],[right])=>left.localeCompare(right)).map(([file,sha])=>`${file}\0${sha}`).join('\n'));
}
export function hostBuildIdentity(){
 const entries=[...localRuntimeFiles.map((name)=>new URL('./'+name,import.meta.url)),...nativeRuntimeEntries.map((name)=>resolveLnwjjud(name,new URL(import.meta.url)))];
 return hashJavaScriptClosure(entries);
}
export function hostConfigurationIdentity(config){
 const database=new DatabaseSync(path.join(config.directory,'core.sqlite'),{readOnly:true,timeout:5000});let policy;try{policy=String(database.prepare('SELECT policy FROM gotzji_meta').get()?.policy??'');}finally{database.close();}
 if(!policy) throw new Error('HOST_POLICY_UNAVAILABLE');
 const recipe=config.recipe??'source-snapshot';
 const documents=['CLAUDE.md','AGENTS.md','references/agent-knowledge-workflow.md','KNOWLEDGE_INDEX.md',...(recipe==='code-check'?['.claude/skills/karpathy-guidelines/SKILL.md','.claude/skills/debug-mantra/SKILL.md']:[])];
 return digest(JSON.stringify({directory:path.resolve(config.directory),policy,recipe,validationMs:config.validationMs??25,expectedHash:digest(config.expectedContent??''),executable:path.resolve(config.executable),libraryRoot:path.resolve(config.libraryRoot),sourceFile:path.resolve(config.sourceFile),documents,testDriver:config.testDriver?path.resolve(config.testDriver):null}));
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='ESRCH'?false:undefined;}}
function envelope(file,key){
 if(!existsSync(file)) return null;
 let raw;
 try{
  if(lstatSync(file).isSymbolicLink()) throw new Error('HOST_IDENTITY_INVALID');
  raw=readFileSync(file,'utf8');
 }catch(error){
  // publishHostReady renames the previous record away before renaming the new one in: between the two, nothing is published.
  if(error?.code==='ENOENT') return null;
  throw error;
 }
 const value=JSON.parse(raw);
 if(typeof value?.body!=='string'||value.mac!==createHmac('sha256',key).update(value.body).digest('hex')) throw new Error('HOST_IDENTITY_INVALID');
 return {body:value.body,value:JSON.parse(value.body)};
}
function openOwnerDatabase(directory){
 const database=new DatabaseSync(path.join(directory,'core.sqlite'),{timeout:5000});database.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS gotzji_host_owners (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL);');return database;
}
function ownerRow(directory){const database=openOwnerDatabase(directory);try{return database.prepare('SELECT pid,nonce FROM gotzji_host_owners WHERE name=?').get('daemon');}finally{database.close();}}
function legacyOwnerBlocks(directory,key){
 const file=path.join(directory,'daemon-owner.json');if(!existsSync(file)) return false;
 try{const previous=envelope(file,key)?.value;return !Number.isSafeInteger(previous?.pid)||alive(previous.pid)!==false;}catch{return true;}
}
export function acquireHostOwnership(directory,key){
 const nonce=randomBytes(24).toString('hex'),database=openOwnerDatabase(directory);let acquired=false;
 try{
  database.exec('BEGIN IMMEDIATE;');const previous=database.prepare('SELECT pid,nonce FROM gotzji_host_owners WHERE name=?').get('daemon');
  if(previous&&alive(previous.pid)!==false){database.exec('ROLLBACK;');return null;}
  if(!previous&&legacyOwnerBlocks(directory,key)){database.exec('ROLLBACK;');return null;}
  if(previous) database.prepare('UPDATE gotzji_host_owners SET pid=?,nonce=? WHERE name=? AND pid=? AND nonce=?').run(process.pid,nonce,'daemon',previous.pid,previous.nonce);
  else database.prepare('INSERT INTO gotzji_host_owners VALUES (?,?,?)').run('daemon',process.pid,nonce);
  database.exec('COMMIT;');acquired=true;
 }catch(error){try{database.exec('ROLLBACK;');}catch{ /* transaction did not open */ }throw error;}finally{database.close();}
 if(!acquired) return null;
 return {pid:process.pid,nonce,release:()=>{const db=openOwnerDatabase(directory);try{db.prepare('DELETE FROM gotzji_host_owners WHERE name=? AND pid=? AND nonce=?').run('daemon',process.pid,nonce);}finally{db.close();}}};
}
export function publishHostReady(directory,key,ownership,value){
 const readyFile=path.join(directory,'daemon-ready.json'),owner=ownerRow(directory);
 if(owner?.pid!==ownership.pid||owner?.nonce!==ownership.nonce||alive(owner.pid)!==true) throw new Error('HOST_OWNER_INVALID');
 const body=JSON.stringify({...value,pid:ownership.pid,ownerNonce:ownership.nonce});
 const record=JSON.stringify({body,mac:createHmac('sha256',key).update(body).digest('hex')});
 const temporary=`${readyFile}.candidate-${ownership.nonce}`;
 writeFileSync(temporary,record,{flag:'wx',mode:0o600});
 try{
  const previous=envelope(readyFile,key);
  if(previous){
   const prior=previous.value;if(!Number.isSafeInteger(prior?.pid)) throw new Error('HOST_IDENTITY_INVALID');
   if(alive(prior.pid)!==false) throw new Error('HOST_READY_LIVE');
   renameSync(readyFile,`${readyFile}.retired-${typeof prior.ownerNonce==='string'?prior.ownerNonce:'legacy'}-${ownership.nonce}`);
  }
  renameSync(temporary,readyFile);
 }catch(error){try{unlinkSync(temporary);}catch{ /* candidate was already removed */ }throw error;}
}
export function readHostReady(directory,key,expectedBuild,expectedConfiguration){
 const value=readHostReadyRecord(directory,key);if(!value) return null;
 if(!Number.isSafeInteger(value?.pid)||!Number.isSafeInteger(value?.port)||value.port<1||value.port>65535||typeof value?.sourceHash!=='string'||typeof value?.configurationHash!=='string') throw new Error('HOST_IDENTITY_INVALID');
 const state=alive(value.pid);if(state===false) return null;if(state!==true) throw new Error('HOST_RECONCILIATION_REQUIRED');
 if(value.sourceHash!==expectedBuild||value.configurationHash!==expectedConfiguration) throw new Error('HOST_BUILD_CHANGED');
 if(typeof value.ownerNonce!=='string') throw new Error('HOST_IDENTITY_INVALID');
 const owner=ownerRow(directory);if(owner?.pid!==value.pid||owner?.nonce!==value.ownerNonce) throw new Error('HOST_RECONCILIATION_REQUIRED');
 return value;
}
export function readHostReadyRecord(directory,key){
 const ready=envelope(path.join(directory,'daemon-ready.json'),key);if(!ready) return null;
 const value=ready.value;
 if(!Number.isSafeInteger(value?.pid)||!Number.isSafeInteger(value?.port)||value.port<1||value.port>65535||typeof value?.sourceHash!=='string'||typeof value?.configurationHash!=='string'||typeof value?.ownerNonce!=='string') throw new Error('HOST_IDENTITY_INVALID');
 return value;
}
