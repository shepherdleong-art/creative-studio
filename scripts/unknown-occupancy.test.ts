import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput, ExecutionFacadeOptions } from '../lib/media-core/execution/context.ts';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-unknown-occupancy-'));
const previous=process.env.CREATIVE_STUDIO_DATA_ROOT;process.env.CREATIVE_STUDIO_DATA_ROOT=root;
const {checkExecutionReadiness}=await import('../lib/media-core/execution/readiness.ts');
const {schemaUpgradeRuntimePaths}=await import('../lib/schema-upgrade/runtime.ts');
const {registerExecutionInstance}=await import('../lib/media-core/execution/schema.ts');
const {createExecutionFacade}=await import('../lib/media-core/execution/operations.ts');
const {createExecutionJournal}=await import('../lib/media-core/execution/journal.ts');
const {upsertExecutionPool,updateActorPolicy}=await import('../lib/media-core/execution/pools.ts');
const {releaseExpiredUnknownConcurrency}=await import('../lib/media-core/execution/unknown-occupancy.ts');
const cleanups:Array<()=>void>=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(name:string,enabled=true,monthlyLimitMinor:number|null=null){
 const data=path.join(root,name);fs.mkdirSync(path.join(data,'data'),{recursive:true});
 const db=new Database(path.join(data,'data/workbench.db'));let now=new Date('2026-11-13T12:00:00Z');let paused=false;let sends=0;
 assert.equal((await checkExecutionReadiness({db,...schemaUpgradeRuntimePaths(data)})).available,true);
 const identity={instanceId:name,fence:1};const deploymentId=name;
 registerExecutionInstance(db,{...identity,deploymentId});
 upsertExecutionPool(db,{poolKey:'shared',kind:'remote',capacity:10,enabled:true,mappingSnapshot:{fixture:true},expectedVersion:0});
 updateActorPolicy(db,{actorId:'user',monthlyLimitMinor,personalConcurrency:10,paused:false,expectedVersion:0});
 const journal=createExecutionJournal({deploymentId,directory:path.join(data,'journal'),now:()=>now});
 const options:ExecutionFacadeOptions={db,journal,deploymentId,now:()=>now,actorAllowed:()=>true,scopeAllowed:()=>true,maintenance:()=>paused,
  ...(enabled?{unknownConcurrency:{idleMs:60_000,sweepIntervalMs:1_000}}:{})};
 const runtime=createExecutionFacade(options);const controller=new AbortController();const context={...identity,deploymentId,signal:controller.signal};await runtime.lifecycle.start(context);
 cleanups.push(()=>{runtime.closeNewWork();controller.abort();db.close();});
 const input=(taskId:string,unified=false):EnqueueInput=>({operationKey:`llm/${taskId}/submit/r1`,actor:{userId:'user'},scope:{resourceType:'project',resourceId:'project'},module:'llm',taskId,step:'submit',inputRevision:'r1',businessAttempt:{id:taskId,number:1},inputHash:taskId,inputSnapshot:{privatePrompt:'private-fixture'},continuationKey:'llm.submit',providerSnapshot:{model:'fixture'},requiredPools:['shared'],quote:{kind:'priced',reserve:{currency:'CNY',minor:2},pricingSnapshot:{v:1}},...(unified?{mediaTaskId:'media-'+taskId,channelKey:'fixture'}:{})});
 async function submitted(taskId:string,mode:'unknown'|'intent'|'accepted'='unknown',unified=false){
  const op=runtime.facade.enqueue(input(taskId,unified)).operation;const grant=runtime.facade.admit({...identity,operationId:op.id,leaseMs:10_000});assert.equal(grant.kind,'admitted');if(grant.kind!=='admitted')throw Error('Expected grant');
  const intent=await runtime.facade.markSubmitting({grant:grant.grant,requestSnapshot:{fixture:true}});
  if(mode==='unknown')await assert.rejects(runtime.facade.transmit(intent,async()=>{sends++;throw Error('connection reset');}));
  if(mode==='accepted')await runtime.facade.transmit(intent,async()=>{sends++;return {remoteId:'remote-'+taskId};});
  return {operationId:op.id,attemptId:grant.grant.attempt.id,permitId:grant.grant.permitId,intent};
 }
 const held=(id:string)=>db.prepare("SELECT count(*) FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held'").pluck().get(id);
 const facts=(id:string)=>({operation:db.prepare('SELECT * FROM execution_operations WHERE id=?').get(id),attempts:db.prepare('SELECT * FROM execution_attempts WHERE operationId=? ORDER BY id').all(id),costs:db.prepare("SELECT * FROM execution_reservations WHERE operationId=? AND kind='cost' ORDER BY id").all(id)});
 return {db,journal,options,runtime,context,identity,controller,input,submitted,held,facts,sends:()=>sends,advance:(ms:number)=>{now=new Date(now.getTime()+ms);},pause:(value:boolean)=>{paused=value;}};
}
try{
 const f=await fixture('automatic',!process.argv.includes('--baseline'));
 upsertExecutionPool(f.db,{poolKey:'shared',kind:'remote',capacity:1,enabled:true,mappingSnapshot:{fixture:true},expectedVersion:1});
 const old=await f.submitted('old','unknown',true);const preserved=f.facts(old.operationId);const journalBefore=f.journal.scan();
 const fresh=f.runtime.facade.enqueue(f.input('new')).operation;
 assert.equal(f.runtime.facade.admit({...f.identity,operationId:fresh.id}).kind,'deferred');
 f.advance(69_999);assert.equal(releaseExpiredUnknownConcurrency(f.options,f.identity,60_000).operations,0,'The idle window starts after lease expiry or later evidence');
 f.advance(1);
 // No admission call: the periodic lifecycle must clear idle history independently.
 await sleep(1_100);
 assert.equal(f.held(old.operationId),0,'Expired unknown must release occupancy automatically');
 assert.deepEqual(f.facts(old.operationId),preserved);assert.deepEqual(f.journal.scan(),journalBefore);
 assert.equal(f.runtime.facade.admit({...f.identity,operationId:fresh.id}).kind,'admitted');
 assert.equal(f.runtime.facade.enqueue(f.input('old',true)).operation.status,'unknown');
 assert.equal(f.runtime.facade.admit({...f.identity,operationId:old.operationId}).kind,'idle');
 assert.equal(f.sends(),1);assert.equal(f.db.prepare('SELECT count(*) FROM execution_unknown_occupancy_releases').pluck().get(),1);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM execution_unknown_occupancy_releases').all()).includes('private-fixture'),false);
 assert.equal(releaseExpiredUnknownConcurrency(f.options,f.identity,60_000).operations,0);
 await f.runtime.lifecycle.recover(f.context);assert.equal(f.held(old.operationId),0);
 await f.runtime.facade.reconcile({attemptId:old.attemptId,source:'operator',evidence:{kind:'terminal',outcome:'succeeded',actualCost:{currency:'CNY',minor:7}}});
 assert.equal(f.db.prepare('SELECT actualMinor FROM execution_attempts WHERE id=?').pluck().get(old.attemptId),7);assert.equal(f.sends(),1);

 const g=await fixture('protected');const inFlight=await g.submitted('inflight','intent');const accepted=await g.submitted('accepted','accepted');const unknown=await g.submitted('unknown');
 g.advance(70_000);g.pause(true);assert.equal(releaseExpiredUnknownConcurrency(g.options,g.identity,60_000).operations,0);g.pause(false);
 g.journal.appendReceipt({...g.journal.scan().filter(r=>r.attemptId===unknown.attemptId).at(-1)!,terminalState:'unknown',at:undefined});
 assert.equal(releaseExpiredUnknownConcurrency(g.options,g.identity,60_000).operations,0,'Recent journal evidence must postpone release even if DB update was lost');
 g.advance(70_000);assert.equal(releaseExpiredUnknownConcurrency(g.options,g.identity,60_000).operations,1);assert.equal(g.held(inFlight.operationId),2);assert.equal(g.held(accepted.operationId),2);

 const h=await fixture('crash');const crashed=await h.submitted('intent','intent');h.advance(70_000);await h.runtime.lifecycle.recover(h.context);
 assert.equal(releaseExpiredUnknownConcurrency(h.options,h.identity,60_000).operations,0,'Same owner without unknown receipt cannot claim its request has stopped');
 h.runtime.closeNewWork();const newer={instanceId:'replacement',fence:2};registerExecutionInstance(h.db,{...newer,deploymentId:h.options.deploymentId});
 assert.throws(()=>releaseExpiredUnknownConcurrency(h.options,h.identity,60_000),/实例已失效/);
 assert.equal(releaseExpiredUnknownConcurrency(h.options,newer,60_000).operations,1);assert.equal(h.held(crashed.operationId),0);

 const a=await fixture('audit');const failed=await a.submitted('audit');a.advance(70_000);
 assert.throws(()=>releaseExpiredUnknownConcurrency({...a.options,journal:{...a.journal,verify:()=>({valid:false,records:[]})}},a.identity,60_000),/完整执行证据/);
 a.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON execution_unknown_occupancy_releases BEGIN SELECT RAISE(ABORT,'audit failure'); END");
 assert.throws(()=>releaseExpiredUnknownConcurrency(a.options,a.identity,60_000),/audit failure/);assert.equal(a.held(failed.operationId),2);a.db.exec('DROP TRIGGER fail_audit');
 assert.equal(releaseExpiredUnknownConcurrency(a.options,a.identity,60_000).operations,1);

 const b=await fixture('budget',true,2);const costHeld=await b.submitted('cost');const costBefore=b.facts(costHeld.operationId).costs;b.advance(70_000);
 const next=b.runtime.facade.enqueue(b.input('next')).operation;const budgetResult=b.runtime.facade.admit({...b.identity,operationId:next.id});
 assert.equal(b.held(costHeld.operationId),0);assert.equal(budgetResult.kind,'deferred');if(budgetResult.kind==='deferred')assert.ok(budgetResult.reasons.includes('monthly_budget'));
 assert.deepEqual(b.facts(costHeld.operationId).costs,costBefore,'Concurrency expiry cannot waive budget evidence');

 const stopped=await fixture('stop');const retained=await stopped.submitted('stop');stopped.runtime.closeNewWork();stopped.advance(70_000);await sleep(1_100);assert.equal(stopped.held(retained.operationId),2,'Stopped runtime cannot keep mutating reservations');
 const local=await fixture('disabled',false);const localUnknown=await local.submitted('local');local.advance(70_000);const localNew=local.runtime.facade.enqueue(local.input('another')).operation;local.runtime.facade.admit({...local.identity,operationId:localNew.id});assert.equal(local.held(localUnknown.operationId),2,'Non-team callers retain existing behavior');
 console.log('unknown occupancy tests passed: automatic timer, admission, evidence/lease guard, preserved costs, newer-owner recovery, audit rollback, late receipt, no replay, shutdown');
}finally{for(const cleanup of cleanups.reverse())cleanup();if(previous===undefined)delete process.env.CREATIVE_STUDIO_DATA_ROOT;else process.env.CREATIVE_STUDIO_DATA_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}