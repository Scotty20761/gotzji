/* global process, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const hash=(x)=>createHash('sha256').update(x).digest('hex');
const display=(x)=>/^[A-Za-z0-9_./:@+\\-]+$/.test(x)?x:JSON.stringify(x);
export function validationManager(config,directory,callbacks){
  let child, current;
  const validator=fileURLToPath(new URL('./phase-r-validator.mjs',import.meta.url));
  const filename=path.join(config.effectRoot,'result.txt');
  const args=[validator,filename,config.grace?.expectedHash??'',String(config.grace?.validationMs??0)];
  const command=[process.execPath,...args].map(display).join(' ');
  const runId=hash(config.jobId+'\0'+config.epoch+'\0'+config.authorizationDigest+'\0'+command);
  const base={jobId:config.jobId,epoch:config.epoch,runId,authorizationDigest:config.authorizationDigest,intentRevision:config.intentRevision,command,commandFingerprint:hash(command),artifactHash:config.grace?.expectedHash??''};
  function persist(){callbacks.persist('validation.json',current);}
  return {
    status:()=>current,
    start:()=>{
      if(current) return {runId,state:current.state};
      current={...base,state:'running',exitCode:null,checks:0,elapsedMs:0,lastProgressAt:new Date().toISOString()};persist();
      child=spawn(process.execPath,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      if(child.pid) callbacks.register(child.pid, child);
      let buffer='',verified=false;
      const deadline=setTimeout(()=>{if(child.exitCode===null) child.kill();},config.grace.validationMs+30000);
      child.stdout.on('data',(chunk)=>{
        appendFileSync(path.join(directory,'validation.stdout'),chunk,{mode:0o600});
        buffer+=chunk.toString('utf8');
        while(buffer.includes('\n')){
          const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try{const event=JSON.parse(line);if(event.sha256!==base.artifactHash||!Number.isSafeInteger(event.checks)||event.checks<0) throw new Error();if(event.event==='verified') verified=true;current={...current,checks:event.checks,elapsedMs:event.elapsedMs,lastProgressAt:new Date().toISOString()};persist();}catch{ /* untrusted output is never completion */ }
        }
      });
      child.stderr.on('data',(chunk)=>appendFileSync(path.join(directory,'validation.stderr'),chunk,{mode:0o600}));
      child.once('error',()=>{current={...current,state:'failed',exitCode:-1,lastProgressAt:new Date().toISOString()};persist();callbacks.finished(current);});
      child.once('close',(code)=>{
        clearTimeout(deadline);
        if(current.state==='cancelled') return;
        const actual=hash(readFileSync(filename));
        current={...current,state:code===0&&verified&&current.checks>0&&actual===base.artifactHash?'completed':'failed',exitCode:code??-1,lastProgressAt:new Date().toISOString()};persist();callbacks.finished(current);
      });
      return {runId,state:'running'};
    },
    stop:async()=>{
      if(current&&current.state==='running'){current={...current,state:'cancelled',exitCode:-1,lastProgressAt:new Date().toISOString()};persist();}
      if(child&&child.exitCode===null) await new Promise((resolve)=>{child.once('close',resolve);child.kill();});
    }
  };
}
