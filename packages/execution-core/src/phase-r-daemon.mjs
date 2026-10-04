/* global process, Buffer */
// Private owner-bound host. The MCP front end/tunnel may close without closing
// this supervisor or changing a live worker's lease/session.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { ExecutionCore } from './core.js';
import { acquireHostOwnership,hostBuildIdentity,hostConfigurationIdentity,publishHostReady } from './phase-r-host-identity.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const ownership=acquireHostOwnership(config.directory,config.daemonSecret);
if(!ownership) process.exit(0);
process.once('exit',()=>ownership.release());
const registration={executable:config.executable,libraryRoot:config.libraryRoot,sourceFile:config.sourceFile,recipe:'code-check',expectedContent:'export function add(a, b) { return a + b; }\n',validationMs:config.validationMs,...(config.testDriver?{testDriver:config.testDriver}:{})};
const core=await ExecutionCore.open(config.directory,{grace:registration});core.startSupervisor();
const server=http.createServer(async(req,res)=>{
 res.setHeader('Connection','close');res.setHeader('Content-Type','application/json');
 if(req.headers.authorization!==`Bearer ${config.daemonSecret}`){res.writeHead(403).end('{}');return;}
 if(req.method==='GET'&&req.url==='/health'){res.end(JSON.stringify({server:'gotzji',state:'ready'}));return;}
 if(req.method!=='POST'||req.url!=='/rpc'){res.writeHead(404).end('{}');return;}
 try{
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>20000) throw new Error('INVALID_REQUEST');}
  const {method,input}=JSON.parse(body);let value;
  const binding=()=>core.select(config.credential,input.jobId);
  switch(method){
   case 'prepare':value=core.prepareCodeChange(config.credential,input.requestId,input.requestedDelivery??'local');break;
   case 'submit':value=await core.submit(config.credential,input.preparationId);break;
   case 'resume':value=await core.resume(config.credential,binding());break;
   case 'status':value=await core.get(config.credential,binding());break;
   case 'logs':value=core.logs(config.credential,binding(),input.cursor??0,input.limit??4000);break;
   case 'artifact':value=await core.readCodeResult(config.credential,binding());break;
   case 'cancel':value=await core.cancel(config.credential,binding());break;
   case 'workflow':{const prepared=core.prepareCodeChange(config.credential,input.requestId,input.requestedDelivery??'local');const job=await core.submit(config.credential,prepared.preparationId);value=await core.resume(config.credential,core.select(config.credential,job.jobId));break;}
   default:throw new Error('METHOD_DENIED');
  }
  res.end(JSON.stringify({ok:true,value}));
 }catch(error){const code=typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'REQUEST_DENIED';res.end(JSON.stringify({ok:false,error:{code,...(error?.reason?{reason:error.reason}:{})}}));}
});
server.listen(0,'127.0.0.1',()=>{
 publishHostReady(config.directory,config.daemonSecret,ownership,{port:server.address().port,sourceHash:hostBuildIdentity(),configurationHash:hostConfigurationIdentity(config)});
});
