import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import {
  createBatchTask,
  finishTaskAttempt,
  startTaskAttempt,
} from '../lib/batch-production/tasks.ts';
import { claimNextTask } from '../lib/batch-production/scheduler.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-render-narration-gate-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '闸门测试项目');`);
const migrated = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.notEqual(migrated.state, 'compatibility_only');

let sequence = 0;

/** 批次 → 版本 → 脚本快照 → 两条成片计划 → 两个成片版本,均未建任何任务。 */
function createBatchFixture(): { batchId: string; versionId: string; snapshotId: string; outputVersionIds: string[] } {
  sequence += 1;
  const batchId = createBatchProduction(db, 'project-1', `闸门批次 ${sequence}`);
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 2 });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: `gate-source-${sequence}`,
    title: '脚本',
    bodyText: '正文',
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 2 });
  const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);
  const outputVersionIds = planIds.map((planId) => createOutputVersion(db, planId, { now: () => new Date() }));
  return { batchId, versionId, snapshotId, outputVersionIds };
}

function createNarrationTask(batchId: string, snapshotId: string, key: string): string {
  return createBatchTask(db, 'project-1', {
    batchId,
    workType: 'narration',
    targetKind: 'script_snapshot',
    targetId: snapshotId,
    requestKey: `narration:${key}`,
  });
}

function createRenderTask(batchId: string, outputVersionId: string, key: string): string {
  return createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionId,
    requestKey: `render:${key}`,
  });
}

function createAssetForPrepare(): string {
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/gate-asset.mp4' },
    contentFingerprint: 'sha256:' + 'a'.repeat(64),
    mediaKind: 'video',
  });
  return assetId;
}

function finishWithStatus(taskId: string, status: 'succeeded' | 'failed' | 'cancelled'): void {
  const attemptId = startTaskAttempt(db, taskId);
  finishTaskAttempt(db, taskId, attemptId, { status });
}

// 1. narration queued 时:只领 narration,两条 render 领不到
{
  const { batchId, snapshotId, outputVersionIds } = createBatchFixture();
  const narrationTaskId = createNarrationTask(batchId, snapshotId, 'case-1');
  createRenderTask(batchId, outputVersionIds[0]!, 'case-1-r1');
  createRenderTask(batchId, outputVersionIds[1]!, 'case-1-r2');
  const first = claimNextTask(db, { workerId: 'w1' });
  assert.equal(first?.task.id, narrationTaskId, '口播 queued 时必须先领口播');
  assert.equal(claimNextTask(db, { workerId: 'w2' }), null, '口播未完成时两条 render 都领不到');
}

// 2. narration succeeded 后:两条 render 都能被领到
{
  const { batchId, snapshotId, outputVersionIds } = createBatchFixture();
  const narrationTaskId = createNarrationTask(batchId, snapshotId, 'case-2');
  const render1 = createRenderTask(batchId, outputVersionIds[0]!, 'case-2-r1');
  const render2 = createRenderTask(batchId, outputVersionIds[1]!, 'case-2-r2');
  const claimedNarration = claimNextTask(db, { workerId: 'w1' });
  assert.equal(claimedNarration?.task.id, narrationTaskId);
  finishWithStatus(narrationTaskId, 'succeeded');
  // 断言"两条都放行",不断言先后:claimNextTask 是 ORDER BY createdAt, id,
  // 同毫秒创建的两条 render 由随机 uuid 决定次序,写死顺序会 flaky。
  const claimedRenders = [
    claimNextTask(db, { workerId: 'w2' })?.task.id,
    claimNextTask(db, { workerId: 'w3' })?.task.id,
  ].sort();
  assert.deepEqual(claimedRenders, [render1, render2].sort(), '口播成功后两条渲染都必须放行');
}

// 3. narration failed:render 仍领不到(有意的门禁,不是 bug)
{
  const { batchId, snapshotId, outputVersionIds } = createBatchFixture();
  const narrationTaskId = createNarrationTask(batchId, snapshotId, 'case-3');
  createRenderTask(batchId, outputVersionIds[0]!, 'case-3-r1');
  const claimedNarration = claimNextTask(db, { workerId: 'w1' });
  assert.equal(claimedNarration?.task.id, narrationTaskId);
  finishWithStatus(narrationTaskId, 'failed');
  assert.equal(claimNextTask(db, { workerId: 'w2' }), null, '口播失败时 render 必须被挡住,不得产出无配音样片');
}

// 4. narration cancelled:render 可以领到(旧版本被取代时取消的口播不挡新渲染)
{
  const { batchId, snapshotId, outputVersionIds } = createBatchFixture();
  const narrationTaskId = createNarrationTask(batchId, snapshotId, 'case-4');
  const render1 = createRenderTask(batchId, outputVersionIds[0]!, 'case-4-r1');
  const claimedNarration = claimNextTask(db, { workerId: 'w1' });
  assert.equal(claimedNarration?.task.id, narrationTaskId);
  finishWithStatus(narrationTaskId, 'cancelled');
  const claimedRender = claimNextTask(db, { workerId: 'w2' });
  assert.equal(claimedRender?.task.id, render1, 'cancelled 的口播不挡渲染');
}

// 5. 计划对应的脚本快照没有口播任务(等同 scriptSnapshotId 为 NULL 的
//    无口播计划):render 不受闸门影响。
{
  const { batchId, outputVersionIds } = createBatchFixture();
  const render1 = createRenderTask(batchId, outputVersionIds[0]!, 'case-5-r1');
  const claimedRender = claimNextTask(db, { workerId: 'w1' });
  assert.equal(claimedRender?.task.id, render1, '无口播任务时 render 不被闸门影响');
}

// 6. 反饥饿:队首是被闸门挡住的 render、队尾是可领取的 asset_prepare,
//    claimNextTask 必须跳过被挡住的 render 返回 asset_prepare,而不是 null。
{
  const { batchId, snapshotId, outputVersionIds } = createBatchFixture();
  const narrationTaskId = createNarrationTask(batchId, snapshotId, 'case-6');
  createRenderTask(batchId, outputVersionIds[0]!, 'case-6-r1');
  const claimedNarration = claimNextTask(db, { workerId: 'w1' });
  assert.equal(claimedNarration?.task.id, narrationTaskId);
  finishWithStatus(narrationTaskId, 'failed');
  const assetId = createAssetForPrepare();
  const assetPrepareId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'asset_prepare',
    targetKind: 'asset',
    targetId: assetId,
    requestKey: `asset_prepare:case-6:${assetId}`,
  });
  const claimedPrepare = claimNextTask(db, { workerId: 'w2' });
  assert.equal(claimedPrepare?.task.id, assetPrepareId, '被挡住的 render 不得让整批停摆,应跳过领取下一条可执行任务');
}

db.close();
console.log('batch render narration gate tests passed');

fs.rmSync(root, { recursive: true, force: true });
