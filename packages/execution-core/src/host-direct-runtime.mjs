import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { brokerCall } from './grace-broker.mjs';
import { setImmediate } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
/** Production deterministic controller. Every effect goes through the existing product broker. */
export async function runHostDirect(config, runner, callbacks) {
  if (config.operation !== 'grace.product-operation' || config.grace?.mode !== 'host-direct' || config.grace.executable || config.grace.testDriver) throw new Error('HOST_DIRECT_PROFILE_REQUIRED');
  const brokerReceipts = [];
  const call = (name, args) => {
    const result = brokerCall(config, name, args, callbacks.approved(), runner);
    const operationId = name === 'read_policy' ? `policy:${args.document}` : name;
    const database = new DatabaseSync(config.database, { readOnly: true, timeout: 5000 });
    try {
      const row = database.prepare('SELECT digest,phase,receipt FROM gotzji_recipe_operations WHERE job_id=? AND operation_id=?').get(config.jobId, operationId);
      if (!row || row.phase !== 'verified' || row.receipt !== JSON.stringify(result)) throw new Error('CONTROLLER_BROKER_EVIDENCE_REQUIRED');
      brokerReceipts.push({ operationId, digest: row.digest, receiptHash: digest(row.receipt) });
    } finally { database.close(); }
    return result;
  };
  for (const document of Object.keys(config.grace.documents)) { await setImmediate(); call('read_policy', { document }); }
  await setImmediate();
  call('execute_operation', {}); call('operation_status', {});
  if (!callbacks.approved()) throw new Error('RUNTIME_OR_TOOL_DENIED');
  const receipt = { schemaVersion: 1, executor: 'host-direct', mode: 'host-direct', jobId: config.jobId, epoch: config.epoch, generation: config.generation, owner: config.owner, session: config.session, intentRevision: config.intentRevision, policy: config.policy, textDigest: digest(config.text), leaseDigest: digest(config.lease), authorizationDigest: config.authorizationDigest, brokerReceipts };
  callbacks.persist('controller-runtime.json', receipt);
  callbacks.finish(receipt);
}
