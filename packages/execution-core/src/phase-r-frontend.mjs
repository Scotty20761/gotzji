/* global process, URL, fetch, AbortSignal, setTimeout, Buffer */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hostBuildIdentity,hostConfigurationIdentity,readHostReady } from './phase-r-host-identity.mjs';
const configPath=process.argv[2],config=JSON.parse(readFileSync(configPath,'utf8'));
const daemon=fileURLToPath(new URL('./phase-r-daemon.mjs',import.meta.url));
const sourceHash=hostBuildIdentity();
const configurationHash=hostConfigurationIdentity(config);
const headers={Authorization:`Bearer ${config.daemonSecret}`,'Content-Type':'application/json'};
function ready(){
 return readHostReady(config.directory,config.daemonSecret,sourceHash,configurationHash);
}
let host=ready();
const hostDeadline=Date.now()+6000;
async function reachable(value){try{const r=await fetch(`http://127.0.0.1:${value.port}/health`,{headers,signal:AbortSignal.timeout(Math.min(1500,Math.max(1,hostDeadline-Date.now())))});return r.ok&&(await r.json()).server==='gotzji';}catch{return false;}}
let joined=!!host&&await reachable(host);
if(!joined){
 if(!host){const child=spawn(process.execPath,[daemon,configPath],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();}
 for(let n=0;n<150&&Date.now()<hostDeadline;n++){const candidate=ready();if(candidate&&await reachable(candidate)){host=candidate;joined=true;break;}await new Promise((r)=>setTimeout(r,40));}
 if(!joined) throw new Error(host?'HOST_RECONCILIATION_REQUIRED':'HOST_UNAVAILABLE');
}
const definitions=[
 ['gotzji_prepare_code_job','prepare',false,{requestId:'string',requestedDelivery:'string'},['requestId'],'Prepare the registered safe local code repair under Grace. Delivery is local; commit/push/deploy are denied.'],
 ['gotzji_submit_job','submit',false,{preparationId:'string'},['preparationId'],'Accept the prepared request durably. Same request/digest returns the same job.'],
 ['gotzji_resume_job','resume',false,{jobId:'string'},['jobId'],'Resume or observe the explicitly selected existing job; never create another worker for live work.'],
 ['gotzji_job_status','status',true,{jobId:'string'},['jobId'],'Read canonical job status and actual validation progress under the existing Grace job authority.'],
 ['gotzji_validation_status','status',true,{jobId:'string'},['jobId'],'Inspect real run ID, state, checks and elapsed time. Running/pending is not completed.'],
 ['gotzji_validation_logs','logs',true,{jobId:'string',cursor:'integer',limit:'integer'},['jobId'],'Read one bounded log page. Follow nextCursor; full logs stay private on the host.'],
 ['gotzji_read_code_result','artifact',true,{jobId:'string'},['jobId'],'Read only the independently verified safe code result after job completion.'],
 ['gotzji_cancel_job','cancel',false,{jobId:'string'},['jobId'],'Cancel only the selected job and prove owned work stopped while preserving evidence.'],
 ['gotzji_code_workflow','workflow',false,{requestId:'string',requestedDelivery:'string'},['requestId'],'Prepare, accept and start the complete Grace-controlled safe code repair workflow. Return job ID promptly, then inspect status/result.']
];
const tools=definitions.map(([name,,readOnlyHint,shape,required,description])=>({name,description,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,type])=>[k,{type}])),required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:name==='gotzji_cancel_job',idempotentHint:true}}));
for await(const line of createInterface({input:process.stdin})){
 let request;try{
  if(Buffer.byteLength(line)>30000) throw new Error('REQUEST_TOO_LARGE');request=JSON.parse(line);if(request.id===undefined) continue;let result;
  if(request.method==='initialize') result={protocolVersion:request.params?.protocolVersion??'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'gotzji',version:'5.7.3'},instructions:'Use the gotzji tools for this registered local safe job. Grace controls its effects. Preserve request/job identity. Read progress and final artifact; do not infer completion from observer exit. Other domains remain unqualified.'};
  else if(request.method==='ping') result={};
  else if(request.method==='tools/list') result={tools};
  else if(request.method==='tools/call'){
   const definition=definitions.find(([name])=>name===request.params?.name);if(!definition) throw new Error('TOOL_DENIED');
   const input=request.params.arguments??{};if(!input||Array.isArray(input)||Object.keys(input).some((k)=>!Object.hasOwn(definition[3],k))||definition[4].some((k)=>!Object.hasOwn(input,k))||Object.entries(input).some(([k,v])=>definition[3][k]==='integer'?!Number.isSafeInteger(v):typeof v!=='string')) throw new Error('INPUT_SHAPE_INVALID');
   const response=await fetch(`http://127.0.0.1:${host.port}/rpc`,{method:'POST',headers,body:JSON.stringify({method:definition[1],input}),signal:AbortSignal.timeout(10000)});const value=await response.json();
   result=value.ok?{content:[{type:'text',text:JSON.stringify(value.value)}],structuredContent:value.value}:{isError:true,content:[{type:'text',text:JSON.stringify(value.error)}]};
  }else throw new Error('METHOD_DENIED');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
 }catch(error){const reason=/^[A-Z_]{1,80}$/.test(error?.message??'')?error.message:'REQUEST_DENIED';process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32602,message:reason}})+'\n');}
}
// Closing this front end never closes the owner-bound supervisor.
