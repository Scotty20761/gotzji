/* global process, URL, setTimeout */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const configPath=process.argv[2],config=JSON.parse(readFileSync(configPath,'utf8'));
function client(){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./phase-r-frontend.mjs',import.meta.url)),configPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let next=0;
 child.stderr.on('data',()=>{ /* auth/private diagnostics never copied to public summary */ });
 createInterface({input:child.stdout}).on('line',(line)=>{const value=JSON.parse(line);const reply=pending.get(value.id);if(reply){pending.delete(value.id);if(value.error) reply.reject(new Error(value.error.message));else reply.resolve(value.result);}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 return {child,call,tool:async(name,args)=>{const result=await call('tools/call',{name,arguments:args});if(result.isError) throw new Error(result.content[0].text);return result.structuredContent;}};
}
let c=client();
await c.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'local-qualification-not-ChatGPT',version:'1'}});
const catalog=await c.call('tools/list',{});
const first=await c.tool('gotzji_code_workflow',{requestId:'phase-r-real-code'});
let disconnected=false,result=first,observations=[];
for(let n=0;n<900;n++){
 result=await c.tool('gotzji_job_status',{jobId:first.jobId});
 if(n%15===0){const value={status:result.status,progress:result.progress};observations.push(value);process.stdout.write(JSON.stringify({event:'progress',...value})+'\n');}
 if(!disconnected&&result.progress?.state==='running'){
  c.child.stdin.end();await new Promise((resolve)=>c.child.once('exit',resolve));
  c=client();await c.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'rejoined-local-qualification',version:'1'}});
  const again=await c.tool('gotzji_code_workflow',{requestId:'phase-r-real-code'});
  if(again.jobId!==first.jobId) throw new Error('JOB_DUPLICATED');disconnected=true;
 }
 if(result.status==='completed') break;
 if(['blocked','failed','cancelled'].includes(result.status)) throw new Error('JOB_NOT_COMPLETED:'+result.status+':'+result.blockerCode);
 await new Promise((resolve)=>setTimeout(resolve,1000));
 if(n===899) throw new Error('QUALIFICATION_BUDGET_EXHAUSTED');
}
const artifact=await c.tool('gotzji_read_code_result',{jobId:first.jobId});
const summary={coverage:config.testDriver?'local-MCP-explicit-no-model':'local-MCP-actual-Claude-NOT-ChatGPT',catalogTools:catalog.tools.length,jobId:first.jobId,disconnected,result,artifact,observations};
writeFileSync(path.join(config.directory,'qualification-summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
process.stdout.write(JSON.stringify({event:'completed',coverage:summary.coverage,directory:config.directory,jobId:summary.jobId,result,artifact})+'\n');
c.child.stdin.end();
