import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-cover-generation-'));
const deploymentId = 'cover-worker-fixture';
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId, CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_LITELLM_PORT: '46873', CREATIVE_STUDIO_COS_DOMAIN: 'cos.example.test',
  CREATIVE_STUDIO_COS_SECRET_ID: 'fixture-id', CREATIVE_STUDIO_COS_SECRET_KEY: 'fixture-key',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { createTeamAccessContext, registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
await import('../lib/team-service/accepted-access.ts');
const { registerManagedFile, runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { readAttempt, readOperation } = await import('../lib/media-core/execution/records.ts');
const { legacyMediaProviderPoolKey, legacyMediaProviderCredentialFingerprint } = await import('../lib/media-core/execution/media-provider-pool.ts');
const { setExecutionModuleRuntime, clearExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { seedScriptProviders } = await import('../lib/seed.ts');
const { createAnalysisVersion, getOrCreateRun } = await import('../lib/one-click-film/store.ts');
const { queueFilmCoverGeneration } = await import('../lib/one-click-film/cover-generation.ts');
const { listFilmCoverCandidates, resolveGeneratedFilmCoverPath } = await import('../lib/one-click-film/cover-assets.ts');
const { startFilmCoverGenerationAfterReadiness, stopFilmCoverGeneration } = await import('../lib/one-click-film/cover-generation-worker.ts');
const { completeJson } = await import('../lib/script-providers/index.ts');

const vendor = 'http://127.0.0.1:46873';
const providerId = 'company-gateway-qiniuyun-gpt-image-2-6-flare';
const providerKey = 'fixture-gateway';
const providerModel = 'qiniuyun/gpt-image-2.6-flare';
const cosOrigin = 'fixture-12345.cos.ap-guangzhou.myqcloud.com';
process.env.CREATIVE_STUDIO_COS_SIGN_HOST = cosOrigin;
const sentReferenceHosts: string[] = [];
const originalFetch = globalThis.fetch;
const controller = new AbortController();
const providerCalls: string[] = [];
const png = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#4c2774' } }).png().toBuffer();
let posts = 0;
let missingPolls = 0;
const originalRemoteId = 'video_ab+c/d==';
const originalRemotePath = '/v1/videos/' + encodeURIComponent(originalRemoteId);
let remoteCompleted = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'cos.example.test' || url.hostname === cosOrigin) {
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=0-0');
    return new Response(new Uint8Array([png[0]]), { status: 206 });
  }
  assert.equal(url.origin, vendor);
  if (url.pathname === '/health/liveliness') return Response.json({ status: 'ok' });
  if (url.pathname === '/v1/videos' && init?.method === 'POST') {
    providerCalls.push('image');
    posts++;
    for (const ref of JSON.parse(String(init.body)).images ?? []) sentReferenceHosts.push(new URL(ref).hostname);
    return Response.json({ id: posts === 1 ? originalRemoteId : 'cover-remote-' + posts, status: 'queued' });
  }
  if (url.pathname === originalRemotePath) {
    missingPolls++;
    if (remoteCompleted) return Response.json({ id: 'different-poll-id', status: 'completed' });
    return missingPolls % 2 === 1 ? new Response('PRIVATE_PROVIDER_RESPONSE', { status: 503 })
      : Response.json({ status: 'temporarily-missing' });
  }
  if (url.pathname === '/v1/videos/cover-remote-2') {
    return Response.json({ status: 'completed', url: vendor + '/image.png' });
  }
  if (url.pathname === '/v1/videos/cover-remote-3') {
    return Response.json({ status: 'failed', error: { message: 'Unable to download content from the provided URL before the timeout.' } });
  }
  if (url.pathname === '/image.png' || url.pathname === originalRemotePath + '/content') {
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
  }
  if (url.pathname === '/v1/chat/completions' && init?.method === 'POST') {
    providerCalls.push('llm');
    return Response.json({ choices: [{ message: { content: '{"done":true}' } }] });
  }
  throw new Error('Unexpected fixture request ' + url.pathname);
};

async function waitFor<T>(read: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 12_000;
  do {
    const value = read();
    if (value) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error('封面任务状态未在约定时间内推进');
}

try {
  ensureServerDeploymentMarker({ mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
    deploymentId, trustedOrigin: 'https://studio.example.test' });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n');
  fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'storage', 'run', 'stack.json'),
    JSON.stringify({ litellmPid: process.pid, proxyPort: 46873, startedAt: new Date().toISOString() }));
  const db = getDb();
  const paths = schemaUpgradeRuntimePaths(root);
  assert.equal((await checkTeamServiceReadiness({ db, ...paths })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...paths })).available, true);
  await startFilmCoverGenerationAfterReadiness();
  const identity = { instanceId: 'worker', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId });
  const runtime = createExecutionFacade({ db, deploymentId,
    journal: createExecutionJournal({ deploymentId, directory: path.join(root, 'storage', 'execution-journal') }),
    actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false });
  await runtime.lifecycle.start({ ...identity, deploymentId, signal: controller.signal });
  let coverAdmissionChecks = 0;
  setExecutionModuleRuntime({ ...identity, facade: { ...runtime.facade, admit(instance) {
    if (instance.module === 'one-click-film-cover') coverAdmissionChecks++;
    return runtime.facade.admit(instance);
  } } });

  const now = new Date().toISOString();
  const user = db.prepare(`INSERT INTO team_users(id,employeeId,displayName,role,status,passwordHash,mustChangePassword,sessionVersion,createdAt,updatedAt)
    VALUES(?,?,?,'employee','active','fixture',0,1,?,?)`);
  user.run('owner', '0001', '封面剪辑师', now, now);
  user.run('zz-dispatcher', '0002', '另一位剪辑师', now, now);
  for (const [actorId, monthlyLimitMinor] of [['owner', 1_000], ['zz-dispatcher', null]] as const) {
    updateActorPolicy(db, { actorId, monthlyLimitMinor, personalConcurrency: 4, paused: false, expectedVersion: 0 });
  }
  const poolKey = legacyMediaProviderPoolKey(vendor, providerKey);
  const setImageCapacity = (capacity: number, expectedVersion: number) => upsertExecutionPool(db, {
    poolKey, kind: 'remote', enabled: true, capacity, expectedVersion,
    mappingSnapshot: { protocol: 'legacy-media-upstream/1', baseUrl: vendor,
      credentialFingerprint: legacyMediaProviderCredentialFingerprint(vendor, providerKey) },
  });
  setImageCapacity(0, 0);
  upsertExecutionPool(db, { poolKey: 'llm:remote', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { providerId: 'fixture-script' }, expectedVersion: 0 });
  db.prepare(`INSERT INTO providers(id,name,type,baseUrl,apiKey,model,enabled) VALUES (?,'Fixture','gateway-task-image',?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET baseUrl=excluded.baseUrl,apiKey=excluded.apiKey,enabled=1`).run(providerId, vendor, providerKey, providerModel);
  seedScriptProviders();
  db.prepare(`INSERT INTO script_providers(id,name,type,apiStyle,baseUrl,apiKey,model,enabled,supportsVision,isBuiltin,executionScope)
    VALUES ('fixture-script','Fixture LLM','openai-compatible','openai-compatible',?,'fixture-script-key','fixture-script',1,1,0,'external')`).run(vendor);
  db.prepare(`INSERT INTO projects(id,name,providerId,model,prompt) VALUES ('project','Fixture project',?,?,'')`).run(providerId, providerModel);
  registerRootScope(db, { resourceType: 'project', resourceId: 'project', ownerUserId: 'owner' });
  const owner = createTeamAccessContext({ db, principal: { userId: 'owner', role: 'employee' } });
  const dispatcher = createTeamAccessContext({ db, principal: { userId: 'zz-dispatcher', role: 'employee' } });
  const run = runWithAccessContext(owner, () => getOrCreateRun(db, 'project'));
  const analysis = runWithAccessContext(owner, () => createAnalysisVersion(db, { run, sourceImageIds: [] }));
  db.prepare(`INSERT INTO one_click_film_entries
    (id,runId,projectId,ordinal,code,structure,structureSource,soundMode,status,promptDurationSec,promptAspectRatio,analysisId,productNameSnapshot,createdAt,updatedAt)
    VALUES('entry',?,'project',1,'F01','scene','auto','none','confirmed',15,'3:4',?,'云朵床',?,?)`).run(run.id, analysis.id, now, now);
  const reference = path.join(root, 'storage', 'sofa.png');
  fs.writeFileSync(reference, png);
  db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES ('sofa','project','input','sofa.png','sofa.png','scene_seed')").run();
  owner.registerInheritedScope({ resourceType: 'image', resourceId: 'sofa', parent: { resourceType: 'project', resourceId: 'project' } });
  runWithAccessContext(owner, () => registerManagedFile({ absolutePath: reference, mimeType: 'image/png',
    references: [{ resourceType: 'image', resourceId: 'sofa' }] }));
  const queue = (requestKey: string, referenceImageIds: string[] = []) => runWithAccessContext(owner, () => queueFilmCoverGeneration(db, run, {
    entryCode: 'F01', requestKey, providerId, referenceImageIds, preference: '', template: 'overlay-minimal', aspectRatio: '3:4',
  }));
  const candidate = (id: string) => runWithAccessContext(owner, () => listFilmCoverCandidates(db, run, 'entry').find(row => row.id === id));
  const operationId = (id: string) => db.prepare('SELECT operationId FROM one_click_film_cover_assets WHERE id=?').pluck().get(id) as string | undefined;

  await sleep(2100);
  assert.equal(coverAdmissionChecks, 0, '空闲队列不进入会扫描执行日志的准入路径');
  const first = await queue('cover-first');
  const firstOperation = await waitFor(() => operationId(first.id));
  setImageCapacity(1, 1);
  const response = await runWithAccessContext(dispatcher, () => completeJson({
    providerId: 'fixture-script', systemPrompt: 'fixture', userPrompt: 'fixture',
    executionContext: { taskId: 'shared-dispatch', step: 'complete', scope: { resourceType: 'project', resourceId: 'project' } },
  }));
  assert.deepEqual(response, { done: true });
  assert.deepEqual(providerCalls, ['image', 'llm'], '另一个员工的 LLM 共享调度先执行封面 grant，再完成自己的请求');
  const acceptedOperation = readOperation(db, firstOperation);
  assert.equal(acceptedOperation.actorId, 'owner');
  assert.equal(acceptedOperation.status, 'accepted');
  await waitFor(() => missingPolls > 0);
  const expeditePoll = db.prepare('UPDATE one_click_film_cover_assets SET nextAttemptAt=? WHERE id=?');
  expeditePoll.run(new Date(Date.now() - 5_000).toISOString(), first.id);
  await waitFor(() => missingPolls > 1);
  db.prepare('UPDATE one_click_film_cover_assets SET submittedAt=?,nextAttemptAt=? WHERE id=?')
    .run(new Date(Date.now() - 16 * 60_000).toISOString(), new Date(Date.now() - 5_000).toISOString(), first.id);
  await waitFor(() => candidate(first.id)?.message?.includes('继续核对'));
  assert.equal(candidate(first.id)?.status, 'running');
  assert.doesNotMatch(candidate(first.id)?.message ?? '', /PRIVATE_PROVIDER_RESPONSE/);
  const expiredAttempt = readAttempt(db, acceptedOperation.currentAttemptId!);
  assert.equal(expiredAttempt.remoteId, originalRemoteId);
  assert.equal(expiredAttempt.submissionState, 'accepted');
  assert.equal(expiredAttempt.costState, 'reserved', '超时保留已受理调用和费用预留');
  assert.equal((await queue('cover-first')).id, first.id, '重放请求不能重新付费提交');

  const retry = await queue('cover-retry', ['sofa']);
  const retryId = await waitFor(() => operationId(retry.id));
  await waitFor(() => readOperation(db, retryId).waitReason === 'pool_capacity');
  assert.equal(posts, 1, '原任务未确认前保留唯一名额');
  remoteCompleted = true;
  expeditePoll.run(new Date().toISOString(), first.id);
  await waitFor(() => candidate(first.id)?.status === 'ready');
  assert.equal(readAttempt(db, expiredAttempt.id).costState, 'settled');
  await waitFor(() => candidate(retry.id)?.status === 'ready');
  assert.equal(posts, 2, '新请求可生成候选，先前已受理的远端任务不会重复提交');
  const result = runWithAccessContext(owner, () => resolveGeneratedFilmCoverPath(db, run, 'entry', retry.id));
  assert.ok(result && fs.existsSync(result));
  const retryOperation = readOperation(db, operationId(retry.id)!);
  const charged = readAttempt(db, retryOperation.currentAttemptId!);
  assert.equal(charged.actorId, 'owner');
  assert.equal(charged.actualMinor, 49, '成功候选使用冻结价格结算');
  assert.deepEqual(sentReferenceHosts, [cosOrigin], 'Flare 参考图优先使用验证可读的 COS 源站');
  const unreadable = await queue('cover-unreadable-ref', ['sofa']);
  await waitFor(() => candidate(unreadable.id)?.status === 'failed');
  assert.match(candidate(unreadable.id)?.message ?? '', /供应商下载参考图超时/);
  assert.equal(posts, 3, '供应商确认取图失败后不自动重提');
  console.log('one-click-film cover generation tests passed');
} finally {
  await stopFilmCoverGeneration();
  controller.abort();
  clearExecutionModuleRuntime();
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
