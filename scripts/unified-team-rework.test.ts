// node scripts/unified-team-rework.test.ts
// Isolated team SQLite + fake providers; validates team rework creation and claim guards only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-team-rework-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '43127',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-team-rework-test',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
ensureServerDeploymentMarker({
  mode: 'server',
  dataRoot: root,
  hostname: '127.0.0.1',
  port: 43127,
  deploymentId: 'unified-team-rework-test',
  trustedOrigin: 'https://studio.example.test',
});
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { createTeamAccessContext, registerRootScope, registerInheritedScope } =
  await import('../lib/team-service/resource-scopes.ts');
const { seedProviders, seedVideoProviders } = await import('../lib/seed.ts');
const { applyFilmRework } = await import('../lib/final-edit/reassembled/rework.ts');
const {
  protectReassembledQueue,
  registerFilmReworkImageCandidate,
} = await import('../lib/reassembled-shot-guard.ts');
const { claimNextVideoJob } = await import('../lib/video-queue.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
} = await import('../lib/media-core/unified-media/catalog.ts');

const db = getDb();
const now = new Date().toISOString();
const png = await sharp({
  create: { width: 16, height: 16, channels: 3, background: '#eeeeee' },
}).png().toBuffer();

function insertUser(id: string): void {
  db.prepare(`INSERT INTO team_users
    (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, ?, 'employee', 'active', 'hash', ?, ?)`)
    .run(id, id, id, now, now);
}

function insertProject(projectId: string): { inputId: string; shotSetId: string; shotId: string } {
  const inputId = `image-${projectId}`;
  const shotSetId = `set-${projectId}`;
  const shotId = `shot-${projectId}`;
  const inputPath = path.join(root, `${projectId}.png`);
  fs.writeFileSync(inputPath, png);
  const provider = db.prepare('SELECT id FROM providers LIMIT 1').get() as { id: string };
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality)
    VALUES (?, ?, ?, ?, '', '1024x1024', 'auto')`)
    .run(projectId, projectId, provider.id, UNIFIED_IMAGE_MODEL_KEY);
  db.prepare(`INSERT INTO image_assets
    (id, projectId, role, filename, path, mimeType, width, height, usage)
    VALUES (?, ?, 'input', ?, ?, 'image/png', 16, 16, 'scene_seed')`)
    .run(inputId, projectId, `${projectId}.png`, inputPath);
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES (?, ?, ?)`)
    .run(shotSetId, projectId, projectId);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId)
    VALUES (?, ?, 1, ?)`).run(shotId, shotSetId, inputId);
  registerRootScope(db, { resourceType: 'project', resourceId: projectId, ownerUserId: 'member' });
  registerInheritedScope(db, {
    resourceType: 'shot_set', resourceId: shotSetId,
    parent: { resourceType: 'project', resourceId: projectId },
  });
  registerInheritedScope(db, {
    resourceType: 'shot', resourceId: shotId,
    parent: { resourceType: 'shot_set', resourceId: shotSetId },
  });
  registerInheritedScope(db, {
    resourceType: 'image', resourceId: inputId,
    parent: { resourceType: 'project', resourceId: projectId },
  });
  return { inputId, shotSetId, shotId };
}

function insertFilm(
  projectId: string,
  shotSetId: string,
  shotId: string,
  clipId: string,
): { groupId: string; bindingId: string } {
  const groupId = `group-${projectId}-${clipId}`;
  const variantId = `variant-${projectId}-${clipId}`;
  const bindingId = `binding-${projectId}-${clipId}`;
  db.prepare(`INSERT INTO final_edit_groups
    (id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash,
     narrationConfigJson, coverTitleJson, textStylesJson, createdAt, updatedAt)
    VALUES (?, ?, 'script', ?, '{}', 'hash', '{}', '{}', '{}', ?, ?)`)
    .run(groupId, projectId, shotSetId, now, now);
  db.prepare(`INSERT INTO final_edit_variants
    (id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, createdAt, updatedAt)
    VALUES (?, ?, 0, 'portrait', '{"clips":[]}', '{}', '{}', ?, ?)`)
    .run(variantId, groupId, now, now);
  const manifest = {
    shots: [{
      id: clipId,
      selectedCandidateId: 'candidate-original',
      candidates: [{ id: 'candidate-original', file: 'original.mp4' }],
    }],
  };
  db.prepare(`INSERT INTO final_edit_film_bindings
    (id, importKey, importHash, projectId, shotSetId, groupId, variantId,
     specJson, candidatesJson, manifestJson, inputHashesJson, managedRootRelative,
     deliveryDir, baseName, reviewToken, createdAt)
    VALUES (?, ?, 'hash', ?, ?, ?, ?, '{}', ?, ?, '{}', 'managed', 'delivery', ?, 'token', ?)`)
    .run(
      bindingId, `${projectId}-${clipId}`, projectId, shotSetId, groupId, variantId,
      JSON.stringify([{ clipId, shotId, videoJobId: 'original-video', file: 'original.mp4' }]),
      JSON.stringify(manifest), `${projectId}-${clipId}`, now,
    );
  registerInheritedScope(db, {
    resourceType: 'final_group', resourceId: groupId,
    parent: { resourceType: 'shot_set', resourceId: shotSetId },
  });
  return { groupId, bindingId };
}

function configureUnifiedProviders(): void {
  seedProviders();
  seedVideoProviders();
  for (const channel of UNIFIED_IMAGE_CHANNELS) {
    db.prepare('UPDATE providers SET baseUrl=?, apiKey=?, enabled=1 WHERE id=?')
      .run(`https://${channel.channelKey}.example.test`, `fixture-${channel.channelKey}-key`, channel.providerId);
  }
  for (const channel of UNIFIED_KLING3_CHANNELS) {
    db.prepare('UPDATE video_providers SET baseUrl=?, apiKey=?, enabled=1 WHERE id=?')
      .run(`https://${channel.channelKey}.example.test`, `fixture-${channel.channelKey}-video-key`, channel.providerId);
  }
}

try {
  assert.equal((await checkTeamServiceReadiness({
    db, ...schemaUpgradeRuntimePaths(root),
  })).available, true);
  insertUser('member');
  insertUser('other');
  configureUnifiedProviders();
  db.prepare(`INSERT INTO providers (id,name,baseUrl,apiKey,model,type,enabled)
    VALUES ('legacy-image','legacy','https://legacy.example.test','fixture-legacy','legacy-model','openai-compatible',1)`)
    .run();
  db.prepare(`INSERT INTO video_providers
    (id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled,baseUrl,apiKey)
    VALUES ('legacy-video','legacy','openai-video','','','','legacy-video-model',1,
      'https://legacy.example.test','fixture-legacy-video')`).run();

  const imageProject = 'project-image-rework';
  const imageFixture = insertProject(imageProject);
  const imageFilm = insertFilm(imageProject, imageFixture.shotSetId, imageFixture.shotId, 'clip-image');
  const access = createTeamAccessContext({
    db,
    principal: { userId: 'member', role: 'employee' },
  });
  const imageCommand = {
    requestId: 'rework-image-0001',
    expectedRevision: 0,
    type: 'generate_image' as const,
    providerId: UNIFIED_IMAGE_ANCHOR_ID,
    model: UNIFIED_IMAGE_MODEL_KEY,
    prompt: '保留产品主体，调整场景光线',
    inputImageId: imageFixture.inputId,
    referenceImageIds: [] as string[],
    size: '1024x1024',
    quality: 'standard',
  };
  const imageResult = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image', imageCommand, 'human',
    { mode: 'server' },
  ));
  assert.ok(imageResult.jobId);
  const imageJob = db.prepare('SELECT * FROM jobs WHERE id=?').get(imageResult.jobId) as Record<string, unknown>;
  assert.equal(imageJob.providerId, UNIFIED_IMAGE_ANCHOR_ID);
  assert.equal(imageJob.model, UNIFIED_IMAGE_MODEL_KEY);
  assert.equal(imageJob.unifiedModel, UNIFIED_IMAGE_MODEL_KEY);
  assert.equal(imageJob.creationSource, 'team_film_rework');
  assert.equal(imageJob.creationRequestKey, imageCommand.requestId);
  assert.equal(imageJob.maxAttempts, 1);
  const frozenImage = JSON.parse(String(imageJob.unifiedRequestJson)) as { inputImageId: string; size: string };
  assert.equal(frozenImage.inputImageId, imageFixture.inputId);
  assert.equal(frozenImage.size, '1024x1024');
  assert.ok(db.prepare(`SELECT 1 FROM team_resource_scopes
    WHERE resourceType='job' AND resourceId=?`).get(imageResult.jobId));
  assert.ok(db.prepare(`SELECT 1 FROM team_task_principals
    WHERE module='image' AND taskId=? AND actorUserId='member'`).get(imageResult.jobId));

  const replay = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image', imageCommand, 'human',
    { mode: 'server' },
  ));
  assert.deepEqual(replay, imageResult);
  assert.equal(db.prepare('SELECT COUNT(*) FROM jobs WHERE creationRequestKey=?')
    .pluck().get(imageCommand.requestId), 1);
  await assert.rejects(() => runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image',
    { ...imageCommand, prompt: '不同请求内容' }, 'human', { mode: 'server' },
  )), { code: 'request_conflict', status: 409 });
  await assert.rejects(() => runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image',
    {
      ...imageCommand, requestId: 'rework-image-0002', expectedRevision: 1,
      providerId: 'legacy-image', model: 'legacy-model',
    },
    'human', { mode: 'server' },
  )), { code: 'team_unified_model_required', status: 409 });
  const localImage = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image',
    {
      ...imageCommand,
      requestId: 'local-image-0003',
      expectedRevision: 1,
      providerId: 'legacy-image',
      model: 'legacy-model',
    },
    'human', { mode: 'local' },
  ));
  assert.deepEqual(
    db.prepare('SELECT providerId,model,unifiedModel FROM jobs WHERE id=?').get(localImage.jobId),
    { providerId: 'legacy-image', model: 'legacy-model', unifiedModel: null },
    'local rework keeps the original exact provider/model path',
  );

  const outputId = 'rework-output-image';
  db.prepare(`INSERT INTO image_assets
    (id, projectId, role, filename, path, mimeType, width, height, usage)
    VALUES (?, ?, 'output', 'result.png', ?, 'image/png', 16, 16, 'film_rework')`)
    .run(outputId, imageProject, path.join(root, 'result.png'));
  const currentBefore = db.prepare('SELECT latestGeneratedImageId FROM shots WHERE id=?')
    .pluck().get(imageFixture.shotId);
  assert.equal(registerFilmReworkImageCandidate(db, imageResult.jobId!, outputId), imageFixture.shotId);
  assert.ok(db.prepare('SELECT 1 FROM shot_result_candidates WHERE shotId=? AND jobId=? AND imageAssetId=?')
    .get(imageFixture.shotId, imageResult.jobId, outputId));
  assert.equal(db.prepare('SELECT latestGeneratedImageId FROM shots WHERE id=?')
    .pluck().get(imageFixture.shotId), currentBefore);

  // A canceled late image remains explicitly adoptable, never automatically used.
  const lateOutputId = 'rework-late-output-image';
  const lateJobId = 'rework-late-image-job';
  db.prepare(`INSERT INTO image_assets
    (id, projectId, role, filename, path, mimeType, width, height, usage)
    VALUES (?, ?, 'output', 'late.png', ?, 'image/png', 16, 16, 'film_rework')`)
    .run(lateOutputId, imageProject, path.join(root, 'late.png'));
  db.prepare(`INSERT INTO jobs (
    id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
    status, providerStatus, attempt, maxAttempts, outputImageId, unifiedModel,
    unifiedRuleVersion, createdAt
  ) VALUES (?, ?, ?, '[]', ?, ?, 'late rework', '1024x1024', 'auto',
    'canceled', 'succeeded', 1, 1, ?, ?, 'unified-media-2026-11-10-v1', ?)`)
    .run(
      lateJobId, imageProject, imageFixture.inputId, UNIFIED_IMAGE_ANCHOR_ID,
      UNIFIED_IMAGE_MODEL_KEY, lateOutputId, UNIFIED_IMAGE_MODEL_KEY, now,
    );
  const revisionBeforeLate = db.prepare('SELECT revision FROM final_edit_film_shots WHERE bindingId=? AND clipId=?')
    .pluck().get(imageFilm.bindingId, 'clip-image') as number;
  db.prepare(`INSERT INTO final_edit_film_reworks
    (id,bindingId,clipId,baseRevision,actor,kind,jobId,requestJson,resultJson,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'late-image-request', imageFilm.bindingId, 'clip-image', revisionBeforeLate,
    'human', 'generate_image', lateJobId, '{}', '{}', now,
  );
  const adopted = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), imageFilm.groupId, 'clip-image',
    {
      requestId: 'select-late-image-0001',
      expectedRevision: revisionBeforeLate,
      type: 'select_image',
      imageId: lateOutputId,
    },
    'human',
    { mode: 'server' },
  ));
  assert.equal(adopted.revision, revisionBeforeLate + 1);
  assert.equal(
    db.prepare('SELECT latestGeneratedImageId FROM shots WHERE id=?').pluck().get(imageFixture.shotId),
    lateOutputId,
    'a canceled late image is adopted only by an explicit select_image command',
  );

  const videoProject = 'project-video-rework';
  const videoFixture = insertProject(videoProject);
  const videoFilm = insertFilm(videoProject, videoFixture.shotSetId, videoFixture.shotId, 'clip-video');
  const videoCommand = {
    requestId: 'rework-video-0001',
    expectedRevision: 0,
    type: 'generate_video' as const,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    model: UNIFIED_KLING3_MODEL_KEY,
    prompt: '镜头缓慢推进，保持产品不变',
    imageId: videoFixture.inputId,
    durationSec: 5,
  };
  const videoResult = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), videoFilm.groupId, 'clip-video', videoCommand, 'human',
    { mode: 'server' },
  ));
  assert.ok(videoResult.jobId);
  const videoJob = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(videoResult.jobId) as Record<string, unknown>;
  assert.equal(videoJob.providerId, UNIFIED_KLING3_ANCHOR_ID);
  assert.equal(videoJob.model, UNIFIED_KLING3_MODEL_KEY);
  assert.equal(videoJob.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
  assert.equal(videoJob.multiShot, 0);
  assert.equal(videoJob.maxAttempts, 1);
  assert.ok(db.prepare(`SELECT 1 FROM final_edit_film_reworks
    WHERE id=? AND jobId=? AND kind='generate_video'`).get(videoCommand.requestId, videoResult.jobId));
  assert.ok(db.prepare(`SELECT 1 FROM team_task_principals
    WHERE module='video' AND taskId=? AND actorUserId='member'`).get(videoResult.jobId));
  const localVideo = await runWithAccessContext(access, () => applyFilmRework(
    db, path.join(root, 'storage'), videoFilm.groupId, 'clip-video',
    {
      ...videoCommand,
      requestId: 'local-video-0003',
      expectedRevision: 1,
      providerId: 'legacy-video',
      model: 'legacy-video-model',
    },
    'human', { mode: 'local' },
  ));
  assert.deepEqual(
    db.prepare('SELECT providerId,model,unifiedModel FROM video_jobs WHERE id=?').get(localVideo.jobId),
    { providerId: 'legacy-video', model: 'legacy-video-model', unifiedModel: null },
    'local video rework keeps its legacy one-submission contract',
  );

  // A unified team rework is claimable despite the legacy rework guard; the
  // attempted legacy rework row stays excluded and is still stopped.
  const unifiedPending = 'video-unified-pending';
  const legacyPending = 'video-legacy-pending';
  db.prepare(`INSERT INTO video_jobs
    (id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,
     status,attempt,maxAttempts,unifiedModel,unifiedRuleVersion,unifiedRequestJson)
    VALUES (?,?,?,?,?,?,?, '',5,'pending',1,1,?,?,?)`).run(
    unifiedPending, videoProject, videoFixture.shotSetId, videoFixture.shotId, videoFixture.inputId,
    UNIFIED_KLING3_ANCHOR_ID, UNIFIED_KLING3_MODEL_KEY,
    UNIFIED_KLING3_MODEL_KEY, 'unified-media-2026-11-10-v1', '{}',
  );
  db.prepare(`INSERT INTO video_jobs
    (id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,
     status,attempt,maxAttempts)
    VALUES (?,?,?,?,?,'legacy-video','legacy-video-model','',5,'pending',1,1)`)
    .run(legacyPending, videoProject, videoFixture.shotSetId, videoFixture.shotId, videoFixture.inputId);
  for (const [id, kind] of [[unifiedPending, 'generate_video'], [legacyPending, 'generate_video']] as const) {
    db.prepare(`INSERT INTO final_edit_film_reworks
      (id,bindingId,clipId,baseRevision,actor,kind,jobId,requestJson,resultJson,createdAt)
      VALUES (?,?,?,'0','human',?,?,'{}','{}',?)`)
      .run(id, videoFilm.bindingId, 'clip-video', kind, id, now);
  }
  protectReassembledQueue(db, videoProject, 'generate_video', undefined, false);
  assert.equal(db.prepare('SELECT status FROM video_jobs WHERE id=?').pluck().get(unifiedPending), 'pending');
  assert.equal(db.prepare('SELECT status FROM video_jobs WHERE id=?').pluck().get(legacyPending), 'failed');
  const claimed = claimNextVideoJob(videoProject, unifiedPending);
  assert.equal(claimed.job?.id, unifiedPending, 'team unified rework must be claimable');

  console.log('unified team rework tests passed (paid calls: 0)');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
