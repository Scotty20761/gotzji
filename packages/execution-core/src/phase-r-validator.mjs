/* global process */
// Registered semantic/property validator. Duration is host-selected stress work,
// never a model sleep/hold or caller-selected executable.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const [filename, expectedHash, durationText] = process.argv.slice(2);
const bytes=readFileSync(filename);
const sha256=createHash('sha256').update(bytes).digest('hex');
if(sha256!==expectedHash) throw new Error('ARTIFACT_HASH_MISMATCH');
const module=await import('data:text/javascript;base64,'+bytes.toString('base64'));
const duration=Number(durationText);
if(!Number.isInteger(duration)||duration<0||duration>600000) throw new Error('VALIDATION_BUDGET_INVALID');
let seed=0x12345678,checks=0,last=0;
const started=performance.now();
function verify(a,b){ if(module.add(a,b)!==a+b) throw new Error('CODE_ASSERTION_FAILED'); checks++; }
try {
  for(const [a,b] of [[0,0],[1,2],[-9,4],[7,-9],[100000,99999]]) verify(a,b);
  do {
    for(let i=0;i<10000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0; const a=(seed%200001)-100000;seed=(Math.imul(seed,1664525)+1013904223)>>>0;verify(a,(seed%200001)-100000);}
    const elapsedMs=Math.round(performance.now()-started);
    if(elapsedMs-last>=1000){last=elapsedMs;process.stdout.write(JSON.stringify({event:'progress',checks,elapsedMs,sha256})+'\n');}
  } while(performance.now()-started<duration);
  process.stdout.write(JSON.stringify({event:'verified',checks,elapsedMs:Math.round(performance.now()-started),sha256})+'\n');
} catch { process.stdout.write(JSON.stringify({event:'failed',reason:'CODE_ASSERTION_FAILED',checks,elapsedMs:Math.round(performance.now()-started),sha256})+'\n');process.exitCode=1; }
