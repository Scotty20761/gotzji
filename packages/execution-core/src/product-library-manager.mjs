/* global URL, AbortController, setTimeout */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { providerFailureCode } from './product-security.mjs';
const hash=(value)=>createHash('sha256').update(value).digest('hex');

/** Durable Library workflow execution under the same owned worker/lease as Grace. */
export function productLibraryManager(config,directory,callbacks){
  const prepared=config.operation==='grace.product-operation'?JSON.parse(config.text):null;
  let current;let controller;let readRecordedLibraryState;let running;
  function persist(){callbacks.persist('library-progress.json',current);appendFileSync(path.join(directory,'product.stdout'),JSON.stringify(current)+'\n',{mode:0o600});}
  // Classify failure and stop from the recorded outcome; unreadable evidence is unknown, never a throw that crashes the worker.
  function recordedState(){try{return readRecordedLibraryState?.(config);}catch{return{outcome:'unknown'};}}
  return{
    status:()=>current,
    start:()=>{
      if(running||current?.state==='completed')return current;
      if(prepared?.kind!=='library')throw new Error('LIBRARY_PREPARATION_REQUIRED');
      controller=new AbortController();const started=Date.now();
      current={jobId:config.jobId,epoch:config.epoch,runId:hash(`${config.jobId}\0${config.epoch}\0${prepared.library.digest}`),state:'running',elapsedMs:0,checks:0,lastProgressAt:new Date().toISOString()};persist();
      running=Promise.resolve().then(async()=>{
        const brokerUrl=existsSync(new URL('./product-library.js',import.meta.url))?new URL('./product-library-broker.mjs',import.meta.url):new URL('../dist/product-library-broker.mjs',import.meta.url);
        const backend=await import(brokerUrl.href);readRecordedLibraryState=backend.readRecordedLibraryState;
        const {assertProductAuthority}=await import('./product-broker.mjs');
        const verifyLiveAuthority=()=>{backend.assertPreparedLibraryDependencies(config);const db=new DatabaseSync(config.database,{timeout:5000});try{assertProductAuthority(db,config);return true;}finally{db.close();}};
        const receipt=await backend.executePreparedLibraryOperation(config,controller.signal,{verifyLiveAuthority});
        writeFileSync(path.join(config.effectRoot,'result.txt'),JSON.stringify(receipt),{mode:0o600});
        current={...current,state:receipt.state==='completed'?'completed':'failed',code:receipt.state==='blocked'?'LIBRARY_FACTY_BLOCKED':undefined,elapsedMs:Date.now()-started,checks:receipt.steps?.length??0,lastProgressAt:new Date().toISOString()};persist();callbacks.finished(current);
      }).catch((error)=>{const state=recordedState();const uncertain=state?.outcome==='unknown'||state?.state==='uncertain';current={...current,state:uncertain?'uncertain':'failed',code:providerFailureCode(error,'LIBRARY_EXECUTION_FAILED'),elapsedMs:Date.now()-started,lastProgressAt:new Date().toISOString()};persist();callbacks.finished(current);}).finally(()=>{running=undefined;});
      return current;
    },
    stop:async()=>{
      if(!current||current.state==='failed')return true;
      if(current.state==='completed')return recordedState()?.outcome==='verified';
      controller.abort();
      if(running)await Promise.race([running,new Promise((resolve)=>setTimeout(resolve,5000))]);
      const state=recordedState();
      return state?.outcome==='none'&&['failed','cancelled'].includes(state?.state);
    },
  };
}
