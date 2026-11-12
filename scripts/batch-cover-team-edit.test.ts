// Run: node scripts/batch-cover-team-edit.test.ts
// Real team task permissions + allocator + FFmpeg. No user data or providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import type { ResourceAccessContext } from '../lib/media-core/access-context.ts';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-cover-team-edit-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'batch-cover-team-test',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { registerRootScope, createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { createAcceptedTaskAccessContext } = await import('../lib/team-service/accepted-access.ts');
const { runWithAccessContext, setTaskAccessContextFactory, registerManagedFile } = await import('../lib/media-core/access-context.ts');
const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { createBatchProduction, createBatchProductionVersion, addAssetToPool } = await import('../lib/batch-production/versions.ts');
const { createProjectScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');
const { createOutputPlansForSnapshot } = await import('../lib/batch-production/plans.ts');
const { persistBatchAllocation, persistOutputReallocation } = await import('../lib/batch-production/allocation-store.ts');
const { createAnalysisVersion } = await import('../lib/batch-production/assets.ts');
const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
const { computeFingerprintFromFile } = await import('../lib/batch-production/fingerprint.ts');
const { scheduleRenderAfterCoverChange } = await import('../lib/batch-production/phase-e.ts');
const { editBatchOutput } = await import('../lib/batch-production/output-editing.ts');
const { setBatchPlanReviews, readBatchPlanReview } = await import('../lib/batch-production/review.ts');
const { startTaskAttempt, finishTaskAttempt } = await import('../lib/batch-production/tasks.ts');
const { retryTask } = await import('../lib/batch-production/scheduler.ts');
const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
const { fileResponse } = await import('../lib/media-core/file-response.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const sharp = (await import('sharp')).default;

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'batch-cover-team-test', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const storageRoot = path.join(root, 'storage');
const projectId = 'project-cover';

try {
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'compatibility_only');
  const insertUser = db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'employee', 'active', 'fixture', 0, 1, '2026-11-12', '2026-11-12')`);
  insertUser.run('owner', '0001', 'Owner');
  insertUser.run('other', '0002', 'Other');
  db.prepare("INSERT INTO providers(id,name,baseUrl) VALUES ('fixture-provider','Fixture','https://example.test')").run();
  db.prepare(`INSERT INTO projects(id,name,providerId,model,prompt)
    VALUES (?, 'Cover edit regression', 'fixture-provider', 'fixture', '')`).run(projectId);
  registerRootScope(db, { resourceType: 'project', resourceId: projectId, ownerUserId: 'owner' });
  const access = createTeamAccessContext({ db, principal: { userId: 'owner', role: 'employee' } });
  const otherAccess = createTeamAccessContext({ db, principal: { userId: 'other', role: 'employee' } });
  setTaskAccessContextFactory(createAcceptedTaskAccessContext);
  fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });

  const assets: string[] = [];
  let batchId = '';
  let versionId = '';
  let planId = '';
  let outputVersionId = '';
  await runWithAccessContext(access, async () => {
    batchId = createBatchProduction(db, projectId, 'Batch cover edit');
    versionId = createBatchProductionVersion(db, batchId, {
      copyCount: 1, defaultsJson: { preset: '3:4', coverTitleMode: 'none' },
    });
    for (const [index, color] of ['red', 'blue'].entries()) {
      const file = path.join(storageRoot, 'videos', `asset-${index}.mp4`);
      await runFfmpeg([
        '-f', 'lavfi', '-i', `color=c=${color}:s=96x128:r=24:d=2`,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file,
      ]);
      const assetId = await registerManagedCopy(db, projectId, { sourcePath: file, role: 'body' });
      const analysisId = createAnalysisVersion(db, {
        assetId, analyzerVersion: 'fixture', providerId: 'fixture', model: 'fixture',
        analysisJson: { durationUs: 2_000_000, usableRanges: [{ startUs: 0, endUs: 2_000_000, qualityScore: 1 }] },
      });
      addAssetToPool(db, versionId, { assetId, analysisId });
      assets.push(assetId);
    }
    const scriptId = createProjectScript(db, projectId, {
      sourceKind: 'script_draft', sourceId: 'cover-script', title: 'Test', sourceVersion: 'v1',
      bodyText: JSON.stringify({ segments: [{ id: 'segment-1', text: 'Body', startUs: 0, endUs: 1_000_000 }] }),
    });
    const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
    [planId] = createOutputPlansForSnapshot(db, versionId, snapshotId);
    db.prepare("UPDATE batch_production_versions SET inputState='frozen', frozenAt='2026-11-12' WHERE id=?").run(versionId);
    db.prepare("UPDATE batch_productions SET status='running', currentVersionId=? WHERE id=?").run(versionId, batchId);

    const narrationFile = path.join(storageRoot, 'narration.wav');
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', narrationFile]);
    const narrationFingerprint = await computeFingerprintFromFile(narrationFile);
    const narration = {
      productionReady: true, mode: 'local_ready', audioRelativePath: 'narration.wav',
      audioFingerprint: narrationFingerprint, durationUs: 1_000_000,
      segments: [{ id: 'segment-1', sourceSegmentId: 'segment-1', text: 'Body', startUs: 0, endUs: 1_000_000, timingSource: 'aligned' }],
    };
    db.prepare(`INSERT INTO batch_script_narrations (
      scriptSnapshotId, batchVersionId, narrationJson, audioRelativePath, audioFingerprint, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      snapshotId, versionId, JSON.stringify(narration), 'narration.wav', narrationFingerprint, '2026-11-12', '2026-11-12',
    );
    registerManagedFile({ absolutePath: narrationFile, mimeType: 'audio/wav', references: [{ resourceType: 'project', resourceId: projectId }] });
    const allocation = persistBatchAllocation(db, projectId, versionId, { seed: 'team-cover-edit' });
    assert.ok(allocation.outputVersionIds[planId], JSON.stringify(allocation.result));
    outputVersionId = allocation.outputVersionIds[planId];
  });

  const readArrangement = () => JSON.parse((db.prepare('SELECT arrangementJson FROM batch_output_versions WHERE id=?')
    .get(outputVersionId) as { arrangementJson: string }).arrangementJson);
  const assertVersionScope = () => {
    const scope = db.prepare(`SELECT parentType, parentId, rootType, rootId, ownerUserId
      FROM team_resource_scopes WHERE resourceType='batch_output_version' AND resourceId=?`).get(outputVersionId);
    assert.deepEqual(scope, {
      parentType: 'batch_plan', parentId: planId, rootType: 'project', rootId: projectId, ownerUserId: 'owner',
    }, 'Automatically allocated versions must inherit the actual plan owner in the same transaction');
  };
  const workspaceCard = () => runWithAccessContext(access, () => getBatchWorkspace(db, projectId, batchId))
    .cards.find(card => card.planId === planId)!;
  const executor = createBatchRenderExecutor({ storageRoot, dataRootPath: root, renderRoot: path.join(storageRoot, 'batch-renders') });
  const renderCover = async () => {
    const taskId = runWithAccessContext(access, () => scheduleRenderAfterCoverChange(db, projectId, batchId, planId));
    assert.ok(taskId);
    await runPendingOnce({ db, workerId: 'cover-worker', executors: [executor], concurrency: 1, log: () => {} });
    const task = db.prepare('SELECT status FROM batch_tasks WHERE id=?').get(taskId) as { status: string };
    const attempt = db.prepare(`SELECT resultJson, errorMessage FROM batch_task_attempts
      WHERE taskId=? ORDER BY attemptNumber DESC LIMIT 1`).get(taskId) as { resultJson: string | null; errorMessage: string | null };
    assert.equal(task.status, 'succeeded', `Valid team-owned media must render its cover: ${attempt?.errorMessage}`);
    const result = JSON.parse(attempt.resultJson!);
    const coverPath = path.join(storageRoot, result.coverRelativePath);
    const request = new Request('https://studio.example.test/cover');
    const response = runWithAccessContext(access, () => fileResponse(request, coverPath, 'image/png'));
    assert.equal(response.status, 200, 'Rendered cover must remain readable by its owner');
    const pixels = await sharp(Buffer.from(await response.arrayBuffer())).resize(1, 1).raw().toBuffer();
    assert.ok(pixels[0] + pixels[1] + pixels[2] > 50, 'Rendered cover must contain a nonblack source frame');
    assert.throws(() => runWithAccessContext(otherAccess, () => fileResponse(request, coverPath, 'image/png')), /不存在或不可用/);
    assert.equal(workspaceCard().approvable, true, 'Completed current cover must restore approval eligibility');
    return taskId;
  };

  // Start with the actual allocator, not createOutputVersion (which already registered scopes).
  assertVersionScope();
  await renderCover();
  runWithAccessContext(access, () => setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' }));
  const firstClip = readArrangement().clips[0];
  const replacementAsset = assets.find(assetId => assetId !== firstClip.assetId)!;
  const editOptions = { wakeScheduler: () => {} };
  await runWithAccessContext(access, () => editBatchOutput(db, projectId, batchId, planId,
    { type: 'replace', clipId: firstClip.clipId, assetId: replacementAsset }, editOptions));
  await runWithAccessContext(access, () => editBatchOutput(db, projectId, batchId, planId,
    { type: 'trim', clipId: firstClip.clipId, sourceStartUs: 250_000, sourceEndUs: 1_250_000 }, editOptions));
  await runWithAccessContext(access, () => editBatchOutput(db, projectId, batchId, planId,
    { type: 'set_cover', assetId: replacementAsset, timeUs: 750_000 }, editOptions));
  assert.equal(readBatchPlanReview(db, projectId, batchId, planId).decision, null, 'Changed clips must require review again');
  assert.equal(workspaceCard().approvable, false, 'Pending current cover must not bypass the approval gate');
  await renderCover();
  runWithAccessContext(access, () => setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' }));
  assert.equal(workspaceCard().approved, true);

  // Existing failed versions must recover on the same retry task, without discarding edits.
  const legacyEdit = await runWithAccessContext(access, () => editBatchOutput(db, projectId, batchId, planId,
    { type: 'set_cover', assetId: replacementAsset, timeUs: 875_000 }, editOptions));
  const legacyTaskId = legacyEdit.coverTaskId!;
  const savedArrangement = readArrangement();
  db.prepare("DELETE FROM team_file_references WHERE resourceType='batch_output_version' AND resourceId=?").run(outputVersionId);
  db.prepare("DELETE FROM team_resource_scopes WHERE resourceType='batch_output_version' AND resourceId=?").run(outputVersionId);
  const attemptId = startTaskAttempt(db, legacyTaskId);
  finishTaskAttempt(db, legacyTaskId, attemptId, { status: 'failed', errorCode: 'resource_not_found', errorMessage: '资源不存在或不可用。' });
  assert.equal(workspaceCard().coverStatus, 'failed');
  assert.equal(workspaceCard().approvable, false);
  runWithAccessContext(access, () => retryTask(db, projectId, legacyTaskId));
  assert.equal(await renderCover(), legacyTaskId, 'Retry must retain the task identity');
  assertVersionScope();
  assert.deepEqual(readArrangement(), savedArrangement, 'Repair must preserve the current clips, cover and revision');
  assert.equal((db.prepare('SELECT attemptCount FROM batch_tasks WHERE id=?').get(legacyTaskId) as { attemptCount: number }).attemptCount, 2);

  // "换一批画面" uses the same persistence path and must register each new version.
  const reallocated = runWithAccessContext(access, () => persistOutputReallocation(db, projectId, versionId, planId,
    'replace arrangement', { seed: 'team-reallocation' }));
  assert.ok(reallocated.outputVersionIds[planId]);
  assert.notEqual(reallocated.outputVersionIds[planId], outputVersionId);
  outputVersionId = reallocated.outputVersionIds[planId];
  assertVersionScope();
  await renderCover();

  // A failed ownership registration cannot leave an allocation or version half-committed.
  const before = db.prepare('SELECT COUNT(*) AS n FROM batch_output_versions').get();
  assert.throws(() => runWithAccessContext(otherAccess, () => persistOutputReallocation(db, projectId, versionId, planId,
    'foreign owner', { seed: 'foreign-owner' })), { code: 'resource_forbidden' });
  const failingAccess: ResourceAccessContext = {
    ...access,
    registerInheritedScope(input) {
      if (input.resourceType === 'batch_output_version') throw new Error('scope registration unavailable');
      access.registerInheritedScope(input);
    },
  };
  assert.throws(() => runWithAccessContext(failingAccess, () => persistOutputReallocation(db, projectId, versionId, planId,
    'atomic registration', { seed: 'registration-failure' })), /scope registration unavailable/);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM batch_output_versions').get(), before);
  assert.equal((db.prepare('SELECT currentVersionId FROM batch_output_plans WHERE id=?').get(planId) as { currentVersionId: string }).currentVersionId, outputVersionId);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM batch_tasks WHERE targetKind='output_version'").get() as { n: number }).n, 0,
    'Editing must not enqueue full movie renders');
  console.log('PASS: team allocation, replace/trim, readable cover, approval, legacy retry, reallocation and owner isolation');
} finally {
  setTaskAccessContextFactory(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
