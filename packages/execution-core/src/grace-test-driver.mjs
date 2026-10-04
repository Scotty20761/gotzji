// Explicit no-model driver for core/broker integration tests. Never a Claude fallback.
import { readFileSync } from 'node:fs';
import { fullTools } from './grace-broker.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const endpoint = `http://127.0.0.1:${process.argv[3]}/broker`;
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', tools: fullTools(config), apiKeySource: 'none', model: 'explicit-test-driver' }) + '\n');
await new Promise((resolve) => setTimeout(resolve, 150));
async function call(name, args) {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__gotzji_task__' + name, input: args }] } }) + '\n');
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type':'application/json' }, body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('denied');
  return response.json();
}
for (const document of Object.keys(config.grace.documents)) await call('read_policy', { document });
const source = await call('read_source', {});
if(config.grace.recipe==='code-check'){
 await call('check_before',{});
 await call('apply_change',{sourceHash:source.sha256,content:config.grace.expectedContent});
 await call('start_validation',{});
 await call('validation_status',{});
} else {await call('save_result', { sourceHash: source.sha256 });await call('check_result', {});}
process.stdout.write(JSON.stringify({ type:'result', subtype:'success', is_error:false }) + '\n');
