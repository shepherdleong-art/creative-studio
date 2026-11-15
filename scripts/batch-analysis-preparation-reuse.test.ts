import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { register } from 'node:module';
import type { ResourceAccessContext } from '../lib/media-core/access-context.ts';
register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analysis-reuse-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
const { getDb, closeDb } = await import('../lib/db.ts');
const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
const { createAsset } = await import('../lib/batch-production/assets.ts');
const { queueAssetPreparation } = await import('../lib/batch-production/asset-preparation.ts');
const { claimNextTask, deferTaskAttempt } = await import('../lib/batch-production/scheduler.ts');
const { createAnalyzeAssetExecutor } = await import('../lib/batch-production/executors.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool, readActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { clearExecutionModuleRuntime, setExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { getAvailableProviders } = await import('../lib/script-providers/index.ts');
const ffmpeg = (await import('ffmpeg-static')).default;
const db = getDb();
const originalFetch = globalThis.fetch;
try {
  assert.equal((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'ready');
  getAvailableProviders();
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const identity = { instanceId: 'batch-llm-recovery', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId: 'batch-llm-recovery' });
  upsertExecutionPool(db, { poolKey: 'llm:remote', kind: 'remote', capacity: 8, enabled: true, mappingSnapshot: { fixture: 'loopback-only' }, expectedVersion: 0 });
  updateActorPolicy(db, { actorId: 'test-user', monthlyLimitMinor: null, personalConcurrency: 8, paused: false, expectedVersion: 0 });
  const journal = createExecutionJournal({ deploymentId: 'batch-llm-recovery', directory: path.join(root, 'storage/execution-journal/batch-llm-recovery') });
  const execution = createExecutionFacade({ db, deploymentId: 'batch-llm-recovery', journal, actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false });
  await execution.lifecycle.start({ ...identity, deploymentId: 'batch-llm-recovery', signal: new AbortController().signal });
  setExecutionModuleRuntime({ facade: execution.facade, ...identity });
  const access: ResourceAccessContext = { kind: 'team', actor: { userId: 'test-user', role: 'admin' }, assertAccess() {}, resolveOwner() { return 'test-user'; }, registerRootScope() {}, registerInheritedScope() {}, registerTaskPrincipal() {} };
  db.prepare("INSERT INTO providers(id,name,baseUrl) VALUES ('fixture','隔离供应商','http://127.0.0.1:9')").run();
  db.prepare("INSERT INTO projects(id,name,providerId,model,prompt) VALUES ('recovery-project','隔离恢复回归','fixture','fixture','synthetic')").run();
  const batchId = createBatchProduction(db, 'recovery-project', '恢复回归');
  const file = path.join(root, 'storage/batch-media/recovery-project/recovery.mp4'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = spawnSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const fingerprint = 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const location = { kind: 'managed', relativePath: 'storage/batch-media/recovery-project/recovery.mp4' };
  const assetId = createAsset(db, { projectId: 'recovery-project', sourceKind: 'managed', locationJson: location, contentFingerprint: fingerprint, mediaKind: 'video' });
  db.prepare("INSERT INTO batch_asset_sources(id,assetId,sourceKind,locationJson,health,createdAt) VALUES ('source',?,'managed',?,'healthy',?)").run(assetId, JSON.stringify(location), new Date().toISOString());
  db.prepare("UPDATE script_providers SET type='openai-compatible',apiStyle='openai-compatible',baseUrl='http://127.0.0.1:9/v1',apiKey='fixture',model='fixture',enabled=1,supportsVision=1,executionScope='external' WHERE id='qwen'").run();
  const queued = queueAssetPreparation(db, 'recovery-project', batchId, [assetId], undefined, { mode: 'content', providerId: 'qwen', model: 'fixture', executionScope: 'external' });
  assert.ok(queued.items[0].taskId);
  globalThis.fetch = async () => { throw new Error('Unexpected provider submission during paused admission'); };
  const nativeSpawn = childProcess.spawn;
  let frameStarts = 0, probeStarts = 0;
  const control = { signal: new AbortController().signal, reportProgress() {} };
  const executor = createAnalyzeAssetExecutor({ assertProviderReady: async () => {} });
  updateActorPolicy(db, { actorId: 'test-user', monthlyLimitMinor: null, personalConcurrency: 8, paused: true, expectedVersion: readActorPolicy(db, 'test-user').version });
  childProcess.spawn = ((command: string, args: string[], options: object) => {
    if (args.includes('-frames:v')) frameStarts++;
    if (args.includes('-show_entries')) probeStarts++;
    return nativeSpawn(command, args, options);
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    let firstFrames = 0, firstProbes = 0;
    for (let i = 0; i < 3; i++) {
      const claim = claimNextTask(db, { workerId: 'prepared-' + i })!;
      await assert.rejects(runWithAccessContext(access, () => executor.execute({ db, claim, ...control })), { code: 'llm_execution_deferred' });
      deferTaskAttempt(db, claim.attempt.id, { workerId: 'prepared-' + i });
      if (i === 0) { firstFrames = frameStarts; firstProbes = probeStarts; assert.ok(firstFrames > 0 && firstProbes > 0); }
      assert.equal(frameStarts, firstFrames, 'Admission deferral must not decode the same verified input again');
      assert.equal(probeStarts, firstProbes, 'Identical content verified by complete hashes must reuse parsed media');
    }
    const bytes = fs.readFileSync(file);
    fs.appendFileSync(file, 'changed');
    const claim = claimNextTask(db, { workerId: 'changed' })!;
    await assert.rejects(runWithAccessContext(access, () => executor.execute({ db, claim, ...control })), /内容已变化/);
    assert.equal(frameStarts, firstFrames, 'A preparation cache must not bypass the full content hash');
    fs.writeFileSync(file, bytes);
    execution.closeNewWork();
    console.log('PASS: deferred analysis prepares once, repeated media hash checks remain mandatory, changed content is rejected');
  } finally { childProcess.spawn = nativeSpawn; syncBuiltinESMExports(); }
} finally {
  globalThis.fetch = originalFetch; clearExecutionModuleRuntime(); closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
