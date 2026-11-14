import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput } from '../lib/media-core/execution/context.ts';
import { planHistoricalOccupancyRelease, releaseHistoricalOccupancy } from './team-server/release-historical-occupancy.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-historical-occupancy-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
fs.mkdirSync(path.join(root,'data'),{recursive:true});
const db = new Database(path.join(root,'data','workbench.db'));
let now = new Date(Date.now() - 60 * 60_000);
const identity = { instanceId: 'test-owner', fence: 1 };
const deploymentId = 'test-historical-occupancy';
const journal = createExecutionJournal({deploymentId, directory:path.join(root,'journal')});
let sends = 0;
try {
  const ready=await checkExecutionReadiness({db,...schemaUpgradeRuntimePaths(root)});
  assert.equal(ready.available,true,JSON.stringify(ready));
  db.exec("CREATE TABLE team_users (id TEXT PRIMARY KEY, role TEXT, status TEXT); INSERT INTO team_users VALUES ('admin','admin','active'),('employee','employee','active')");
  registerExecutionInstance(db,{...identity,deploymentId});
  for (const poolKey of ['llm','unrelated']) upsertExecutionPool(db,{poolKey,kind:'remote',capacity:1,enabled:true,mappingSnapshot:{fixture:true},expectedVersion:0});
  for (const actorId of ['employee','other']) updateActorPolicy(db,{actorId,monthlyLimitMinor:null,personalConcurrency:1,paused:false,expectedVersion:0});
  const options={db,journal,deploymentId,actorAllowed:()=>true,scopeAllowed:()=>true,maintenance:()=>false,now:()=>now};
  const runtime=createExecutionFacade(options);
  await runtime.lifecycle.start({...identity,deploymentId,signal:new AbortController().signal});
  const execution=runtime.facade;
  function input(taskId:string,actor='employee',pool='llm'):EnqueueInput {
    return {operationKey:`llm/${taskId}/analyze/r1`,actor:{userId:actor},scope:{resourceType:'project',resourceId:'project'},
      module:'llm',taskId,step:'analyze',inputRevision:'r1',businessAttempt:{id:taskId,number:1},
      inputHash:taskId,inputSnapshot:{privatePrompt:'must-not-enter-audit'},continuationKey:'llm.analyze',
      providerSnapshot:{providerId:'fixture',model:'fixture'},requiredPools:[pool],
      quote:{kind:'priced',reserve:{currency:'CNY',minor:2},pricingSnapshot:{version:1}}};
  }
  async function fail(taskId:string,actor='employee',pool='llm') {
    const op=execution.enqueue(input(taskId,actor,pool)).operation;
    const admitted=execution.admit({...identity,operationId:op.id,leaseMs:100});
    assert.equal(admitted.kind,'admitted');if(admitted.kind!=='admitted')throw Error('Expected grant');
    const intent=await execution.markSubmitting({grant:admitted.grant,requestSnapshot:{fixture:true}});
    await assert.rejects(execution.transmit(intent,async()=>{sends++;throw Error('connection reset');}),/connection reset/);
    return op.id;
  }
  const old=await fail('historical');
  const unrelated=await fail('unrelated','other','unrelated');
  const beforeFacts=db.prepare('SELECT * FROM execution_operations WHERE id=?').get(old);
  const beforeAttempts=db.prepare('SELECT * FROM execution_attempts ORDER BY id').all();
  const beforeCost=db.prepare("SELECT * FROM execution_reservations WHERE kind='cost' ORDER BY id").all();
  const beforeJournal=journal.scan();
  const beforeUnrelated=db.prepare('SELECT * FROM execution_reservations WHERE operationId=? ORDER BY id').all(unrelated);
  const newOperation=execution.enqueue(input('fresh')).operation;
  const blocked=execution.admit({...identity,operationId:newOperation.id});
  assert.equal(blocked.kind,'deferred');
  if(blocked.kind==='deferred')assert.ok(blocked.reasons.includes('pool_capacity')||blocked.reasons.includes('personal_concurrency'));
  const request={operatorId:'admin',auditId:'fixture-release',reason:'User explicitly authorized detaching historical occupancy, preserving unknown outcome and costs',operationIds:[old]};
  assert.throws(()=>planHistoricalOccupancyRelease(options,request),/lease|Recent/);
  now=new Date(now.getTime()+60*60_000);
  assert.throws(()=>planHistoricalOccupancyRelease(options,{...request,operatorId:'employee'}),/administrator/);
  assert.throws(()=>planHistoricalOccupancyRelease(options,{...request,operationIds:[old,newOperation.id]}),/historical unknown|Current attempt/);
  assert.throws(()=>planHistoricalOccupancyRelease({...options,journal:{...journal,verify:()=>({valid:false,records:[]})}},request),/journal/);
  const plan=planHistoricalOccupancyRelease(options,request);
  assert.equal(JSON.stringify(plan).includes('must-not-enter-audit'),false,'Audit must not contain inputs or prompts');
  assert.throws(()=>releaseHistoricalOccupancy(options,plan,()=>{throw Error('audit fsync failed');}),/audit fsync/);
  assert.equal(db.prepare("SELECT count(*) FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held'").pluck().get(old),2);
  db.exec("CREATE TRIGGER occupancy_update_failure BEFORE UPDATE ON execution_reservations WHEN OLD.poolKey='actor:employee:remote' BEGIN SELECT RAISE(ABORT, 'injected release failure'); END");
  assert.throws(()=>releaseHistoricalOccupancy(options,plan,()=>{}),/injected release failure/);
  db.exec('DROP TRIGGER occupancy_update_failure');
  assert.equal(db.prepare("SELECT count(*) FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held'").pluck().get(old),2,'Failed transaction must retain every original hold');
  let audits=0;
  if(!process.argv.includes('--baseline')) {
    const result=releaseHistoricalOccupancy(options,plan,()=>{audits++;});
    assert.equal(result.releasedReservations,2);
    assert.equal(releaseHistoricalOccupancy(options,plan,()=>{audits++;}).alreadyReleased,true);
    assert.equal(audits,1,'Repeat execution cannot release twice or duplicate the audit');
  }
  assert.deepEqual(db.prepare('SELECT * FROM execution_operations WHERE id=?').get(old),beforeFacts);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts ORDER BY id').all(),beforeAttempts);
  assert.deepEqual(db.prepare("SELECT * FROM execution_reservations WHERE kind='cost' ORDER BY id").all(),beforeCost);
  assert.deepEqual(db.prepare('SELECT * FROM execution_reservations WHERE operationId=? ORDER BY id').all(unrelated),beforeUnrelated);
  assert.deepEqual(journal.scan(),beforeJournal,'No fabricated provider receipt');
  const admitted=execution.admit({...identity,operationId:newOperation.id});
  assert.equal(admitted.kind,'admitted','New employee generation must no longer be blocked by historical occupancy');
  const replay=execution.enqueue(input('historical'));
  assert.equal(replay.replayed,true);assert.equal(replay.operation.status,'unknown');
  assert.equal(execution.admit({...identity,operationId:old}).kind,'idle','Old unknown cannot be readmitted');
  await runtime.lifecycle.recover({...identity,deploymentId,signal:new AbortController().signal});
  assert.equal(db.prepare("SELECT count(*) FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held'").pluck().get(old),0,'Restart recovery must not recreate released occupancy');
  assert.deepEqual(db.prepare("SELECT * FROM execution_reservations WHERE kind='cost' AND operationId=? ORDER BY id").all(old),beforeCost.filter((r)=> (r as {operationId:string}).operationId===old));
  assert.equal(sends,2,'Release and restart never resend original calls');
  const oldAttempt=db.prepare('SELECT currentAttemptId FROM execution_operations WHERE id=?').pluck().get(old) as string;
  await execution.reconcile({attemptId:oldAttempt,source:'operator',evidence:{kind:'terminal',outcome:'succeeded',actualCost:{currency:'CNY',minor:7}}});
  assert.equal(db.prepare('SELECT actualMinor FROM execution_attempts WHERE id=?').pluck().get(oldAttempt),7,'Later true cost evidence remains reconcilable');
  assert.equal(db.prepare("SELECT count(*) FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held'").pluck().get(old),0);
  assert.equal(sends,2);
  console.log('historical occupancy release tests passed: admission, preservation, restart, idempotency, audit failure, late reconciliation');
} finally {
  db.close();
  if(previousRoot===undefined)delete process.env.CREATIVE_STUDIO_DATA_ROOT;else process.env.CREATIVE_STUDIO_DATA_ROOT=previousRoot;
  fs.rmSync(root,{recursive:true,force:true});
}