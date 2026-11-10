import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n){
  if(s==='next/server') return n('next/server.js',c);
  try { return await n(s,c); } catch(e) {
    if(e.code!=='ERR_UNSUPPORTED_DIR_IMPORT') throw e;
    return n(s+'/index.ts',c);
  }
}`)}`, import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-image-project-routes-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '0';

const { getDb, closeDb } = await import('../lib/db.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION } =
  await import('../lib/media-core/unified-media/catalog.ts');
const applyScene = await import('../app/api/shot-sets/[id]/apply-scene/route.ts');
const regenerate = await import('../app/api/jobs/[id]/regenerate/route.ts');
const sceneJobs = await import('../app/api/projects/[id]/scene-jobs/route.ts');

function request(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

try {
  const db = getDb();
  seedProviders();
  db.prepare(`
    INSERT INTO projects (
      id, name, providerId, model, prompt, size, quality, maxAttempts,
      workflowType, scenePrompt, shotPrompt
    ) VALUES ('project-unified', '统一图片入口', ?, ?, '', '1728x2304', 'auto', 1, 'complex_product', '', '')
  `).run(UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);

  const now = new Date().toISOString();
  for (const id of ['scene-ref-image', 'shot-image-a', 'shot-image-b']) {
    db.prepare(`
      INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, createdAt)
      VALUES (?, 'project-unified', ?, ?, ?, 'image/png', ?)
    `).run(id, id === 'scene-ref-image' ? 'reference' : 'input', `${id}.png`, path.join(root, `${id}.png`), now);
  }
  db.prepare(`
    INSERT INTO scene_references (id, projectId, imageAssetId, name, createdAt)
    VALUES ('scene-ref', 'project-unified', 'scene-ref-image', '客厅参考', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO shot_sets (id, projectId, name, sceneReferenceId, status, createdAt)
    VALUES ('set-a', 'project-unified', '统一分镜', 'scene-ref', 'draft', ?)
  `).run(now);
  const insertShot = db.prepare(`
    INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, createdAt)
    VALUES (?, 'set-a', ?, ?, ?)
  `);
  insertShot.run('shot-a', 1, 'shot-image-a', now);
  insertShot.run('shot-b', 2, 'shot-image-b', now);

  const applyBody = {
    sceneReferenceId: 'scene-ref',
    prompt: '图1是分镜底图，图2是场景参考。保持产品主体不变。',
    requestKey: 'apply-scene-request-1',
  };
  const first = await applyScene.POST(request(applyBody) as never, {
    params: Promise.resolve({ id: 'set-a' }),
  });
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  const firstBody = JSON.parse(firstText) as { jobIds: string[]; replayed?: boolean };
  assert.equal(firstBody.jobIds.length, 2);
  assert.equal(firstBody.replayed, false);

  const jobs = db.prepare(`
    SELECT id, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      maxAttempts, unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource,
      creationRequestKey, creationIndex
    FROM jobs WHERE projectId = 'project-unified' ORDER BY creationIndex
  `).all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.inputImageId), ['shot-image-a', 'shot-image-b']);
  assert.deepEqual(jobs.map((job) => job.referenceImageIds), [
    JSON.stringify(['scene-ref-image']),
    JSON.stringify(['scene-ref-image']),
  ]);
  for (const job of jobs) {
    assert.equal(job.providerId, UNIFIED_IMAGE_ANCHOR_ID);
    assert.equal(job.model, UNIFIED_IMAGE_MODEL_KEY);
    assert.equal(job.size, '1728x2304');
    assert.equal(job.quality, 'auto');
    assert.equal(job.maxAttempts, 1);
    assert.equal(job.unifiedModel, UNIFIED_IMAGE_MODEL_KEY);
    assert.equal(job.unifiedRuleVersion, UNIFIED_MEDIA_RULE_VERSION);
    assert.equal(job.creationSource, 'project_apply_scene');
    assert.equal(job.creationRequestKey, 'apply-scene-request-1');
    const frozen = JSON.parse(String(job.unifiedRequestJson)) as {
      referenceImageIds: string[];
      tier: string;
      ratio: string;
    };
    assert.deepEqual(frozen.referenceImageIds, ['scene-ref-image']);
    assert.equal(frozen.tier, '2k');
    assert.equal(frozen.ratio, '3:4');
  }

  const replay = await applyScene.POST(request(applyBody) as never, {
    params: Promise.resolve({ id: 'set-a' }),
  });
  const replayText = await replay.text();
  assert.equal(replay.status, 200, replayText);
  assert.deepEqual((JSON.parse(replayText) as { jobIds: string[] }).jobIds, firstBody.jobIds);
  assert.equal((db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number), 2,
    'same requestKey must not create a second batch');

  const conflict = await applyScene.POST(request({ ...applyBody, prompt: '不同提示词' }) as never, {
    params: Promise.resolve({ id: 'set-a' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number), 2);
  const bypass = await applyScene.POST(request({
    ...applyBody,
    providerId: 'company-gateway-image2-medium',
    requestKey: 'apply-scene-bypass',
  }) as never, { params: Promise.resolve({ id: 'set-a' }) });
  assert.equal(bypass.status, 400, 'unified project must reject a direct real-channel bypass');
  assert.equal((db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number), 2);
  db.prepare(`
    INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES ('project-other', '其他项目', ?, ?, '')
  `).run(UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, createdAt)
    VALUES ('foreign-image', 'project-other', 'input', 'foreign.png', ?, 'image/png', ?)
  `).run(path.join(root, 'foreign.png'), now);
  db.prepare("UPDATE shots SET sourceImageId = 'foreign-image' WHERE id = 'shot-b'").run();
  const crossProject = await applyScene.POST(request({
    ...applyBody,
    requestKey: 'apply-scene-cross-project',
  }) as never, { params: Promise.resolve({ id: 'set-a' }) });
  assert.equal(crossProject.status, 400, 'cross-project shot material must be rejected before creating jobs');
  assert.equal((db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number), 2);
  db.prepare("UPDATE shots SET sourceImageId = 'shot-image-b' WHERE id = 'shot-b'").run();

  const originalJobId = firstBody.jobIds[0];
  db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(originalJobId);
  const regen = await regenerate.POST(request({
    prompt: '重新生成这一张，保持图1产品主体和图2场景参考。',
    inputSource: 'original',
    referenceImageIds: ['scene-ref-image'],
    markOriginal: true,
    requestKey: 'regenerate-request-1',
  }) as never, { params: Promise.resolve({ id: originalJobId }) });
  const regenText = await regen.text();
  assert.equal(regen.status, 200, regenText);
  const regenBody = JSON.parse(regenText) as { newJobId: string; revision: number; replayed?: boolean };
  assert.equal(regenBody.replayed, false);
  const regenerated = db.prepare(`
    SELECT providerId, model, size, quality, maxAttempts, parentJobId, revision,
      unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource
    FROM jobs WHERE id = ?
  `).get(regenBody.newJobId) as Record<string, unknown>;
  assert.equal(regenerated.providerId, UNIFIED_IMAGE_ANCHOR_ID);
  assert.equal(regenerated.model, UNIFIED_IMAGE_MODEL_KEY);
  assert.equal(regenerated.size, '1728x2304');
  assert.equal(regenerated.quality, 'auto');
  assert.equal(regenerated.maxAttempts, 1);
  assert.equal(regenerated.parentJobId, originalJobId);
  assert.equal(regenerated.revision, regenBody.revision);
  assert.equal(regenerated.unifiedModel, UNIFIED_IMAGE_MODEL_KEY);
  assert.equal(regenerated.unifiedRuleVersion, UNIFIED_MEDIA_RULE_VERSION);
  assert.equal(regenerated.creationSource, 'project_regenerate');
  assert.deepEqual(JSON.parse(String(regenerated.unifiedRequestJson)).referenceImageIds, ['scene-ref-image']);
  assert.equal((db.prepare('SELECT reviewMark FROM jobs WHERE id = ?').pluck().get(originalJobId) as string), 'rework');

  const regenReplay = await regenerate.POST(request({
    prompt: '重新生成这一张，保持图1产品主体和图2场景参考。',
    inputSource: 'original',
    referenceImageIds: ['scene-ref-image'],
    markOriginal: true,
    requestKey: 'regenerate-request-1',
  }) as never, { params: Promise.resolve({ id: originalJobId }) });
  const regenReplayText = await regenReplay.text();
  assert.equal(regenReplay.status, 200, regenReplayText);
  assert.equal((JSON.parse(regenReplayText) as { newJobId: string }).newJobId, regenBody.newJobId);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM jobs WHERE creationRequestKey = ?').pluck().get('regenerate-request-1'),
    1,
    'regenerate replay must return the original new task',
  );

  db.prepare(`
    INSERT INTO projects (
      id, name, providerId, model, prompt, size, quality, maxAttempts,
      workflowType, scenePrompt, shotPrompt
    ) VALUES ('project-scene-unified', '统一场景批量', ?, ?, '', '1728x2304', 'auto', 1, 'complex_product', '', '')
  `).run(UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage, createdAt)
    VALUES ('scene-seed-a', 'project-scene-unified', 'input', 'scene.png', ?, 'image/png', 'scene_seed', ?)
  `).run(path.join(root, 'scene.png'), now);
  const sceneBody = {
    sceneSeedImageId: 'scene-seed-a',
    scenePrompt: '结合参考场景生成三张卧室候选。',
    generationCount: 3,
    requestKey: 'scene-batch-request-1',
  };
  const sceneResponse = await sceneJobs.POST(request(sceneBody) as never, {
    params: Promise.resolve({ id: 'project-scene-unified' }),
  });
  const sceneText = await sceneResponse.text();
  assert.equal(sceneResponse.status, 200, sceneText);
  const sceneBodyResult = JSON.parse(sceneText) as { jobIds: string[] };
  assert.equal(sceneBodyResult.jobIds.length, 3);
  const sceneRows = db.prepare(`
    SELECT providerId, model, unifiedModel, unifiedRuleVersion, size, maxAttempts,
      creationSource, creationRequestKey, creationIndex
    FROM jobs WHERE projectId = 'project-scene-unified' ORDER BY creationIndex
  `).all() as Array<Record<string, unknown>>;
  assert.deepEqual(sceneRows.map((row) => row.creationIndex), [0, 1, 2]);
  assert.ok(sceneRows.every((row) =>
    row.providerId === UNIFIED_IMAGE_ANCHOR_ID
    && row.model === UNIFIED_IMAGE_MODEL_KEY
    && row.unifiedModel === UNIFIED_IMAGE_MODEL_KEY
    && row.unifiedRuleVersion === UNIFIED_MEDIA_RULE_VERSION
    && row.size === '1728x2304'
    && row.maxAttempts === 1
    && row.creationSource === 'project_scene'
    && row.creationRequestKey === 'scene-batch-request-1'));
  const sceneReplay = await sceneJobs.POST(request(sceneBody) as never, {
    params: Promise.resolve({ id: 'project-scene-unified' }),
  });
  const sceneReplayText = await sceneReplay.text();
  assert.equal(sceneReplay.status, 200, sceneReplayText);
  assert.deepEqual((JSON.parse(sceneReplayText) as { jobIds: string[] }).jobIds, sceneBodyResult.jobIds);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM jobs WHERE projectId = 'project-scene-unified'").pluck().get(),
    3,
    'scene batch replay must not duplicate any candidate',
  );

  console.log('unified image project route tests passed');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
