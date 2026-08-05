import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  createBatchProduction,
  createBatchProductionVersion,
  deleteBatchProduction,
  getBatchProduction,
  listProjectBatchProductions,
} from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlan, createOutputVersion } from '../lib/batch-production/plans.ts';
import { createBatchTask, finishTaskAttempt, startTaskAttempt } from '../lib/batch-production/tasks.ts';
import { resolveBatchOutputMedia } from '../lib/batch-production/output-media.ts';
import {
  getArtifact,
  getCurrentArtifactId,
  listPlanArtifacts,
  registerArtifact,
  setCurrentArtifact,
} from '../lib/batch-production/artifacts.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '旧项目');
  `);
  return { db, databasePath };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-artifacts-'));

try {
  const dbRoot = path.join(root, 'healthy');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { db } = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 结构 ---
  const artifactColumns = db.prepare(`PRAGMA table_info(batch_artifacts)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const artifactNames = new Map(artifactColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'projectId', 'batchId', 'batchVersionId', 'outputPlanId', 'outputVersionId', 'kind', 'relativePath', 'checksum', 'createdAt']) {
    assert.ok(artifactNames.has(name), `batch_artifacts 缺少列 ${name}`);
  }
  assert.equal(artifactNames.get('id')?.pk, 1);
  const artifactForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_artifacts)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  for (const [table, from] of [
    ['batch_productions', 'batchId'],
    ['batch_production_versions', 'batchVersionId'],
    ['batch_output_plans', 'outputPlanId'],
    ['batch_output_versions', 'outputVersionId'],
  ] as const) {
    assert.ok(artifactForeignKeys.some((fk) => (
      fk.table === table && fk.from === from && fk.to === 'id' && fk.on_delete.toUpperCase() === 'RESTRICT'
    )), `正式产物表必须限制被删除(${from})`);
  }
  const artifactIndexes = db.prepare(`PRAGMA index_list(batch_artifacts)`).all() as Array<{ name: string }>;
  assert.ok(artifactIndexes.some(({ name }) => name === 'idx_batch_artifacts_plan'), '缺少正式产物计划索引');

  // 成片计划表追加了当前成片指向列
  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{ name: string }>;
  assert.ok(planColumns.some(({ name }) => name === 'currentArtifactId'), 'batch_output_plans 缺少当前成片指向列');

  // --- 准备:批次 → 版本 → 快照 → 计划 → 成片版本 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T09:00:00.000Z'));
  const version1 = createBatchProductionVersion(db, batchId, { copyCount: 1, now: () => new Date('2026-08-01T09:05:00.000Z') });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-1',
    title: '口播',
    bodyText: '正文',
    sourceVersion: 'v1',
    now: () => new Date('2026-08-01T09:10:00.000Z'),
  });
  const snapshotId = snapshotScriptIntoBatch(db, version1, { scriptId, copyCount: 1, now: () => new Date('2026-08-01T09:15:00.000Z') });
  const planId = createOutputPlan(db, version1, { scriptSnapshotId: snapshotId, seq: 1, now: () => new Date('2026-08-01T09:20:00.000Z') });
  const outputVersionId = createOutputVersion(db, planId, { now: () => new Date('2026-08-01T09:25:00.000Z') });

  // --- 关联链校验:批次/版本/计划必须属于同一项目同一链路 ---
  db.prepare(`INSERT INTO projects (id, name) VALUES ('project-2', '项目二')`).run();
  const otherBatch = createBatchProduction(db, 'project-2', '项目二批次', () => new Date('2026-08-01T09:26:00.000Z'));
  assert.throws(
    () => registerArtifact(db, 'project-1', {
      batchId: otherBatch,
      batchVersionId: version1,
      outputPlanId: planId,
      outputVersionId: outputVersionId,
      kind: 'video',
      relativePath: 'final-edits/plan-1/x.mp4',
      checksum: 'sha256:x',
    }),
    /不属于/,
    '其他项目的批次不能登记本项目的产物',
  );
  assert.equal(listPlanArtifacts(db, planId).length, 0, '关联链校验失败不得写入任何产物');

  // --- 同一成片版本重新导出三次:三份不覆盖的正式产物,最新版自动成为当前成片 ---
  const artifact1 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId,
    kind: 'video',
    relativePath: 'final-edits/plan-1/export-1.mp4',
    checksum: 'sha256:one',
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  const artifact2 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId,
    kind: 'video',
    relativePath: 'final-edits/plan-1/export-2.mp4',
    checksum: 'sha256:two',
    now: () => new Date('2026-08-01T10:10:00.000Z'),
  });
  const artifact3 = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId,
    kind: 'video',
    relativePath: 'final-edits/plan-1/export-3.mp4',
    checksum: 'sha256:three',
    now: () => new Date('2026-08-01T10:20:00.000Z'),
  });

  assert.notEqual(artifact1, artifact2);
  assert.notEqual(artifact2, artifact3);
  const allArtifacts = listPlanArtifacts(db, planId);
  assert.equal(allArtifacts.length, 3, '同一成片版本每次成功导出都必须新增正式产物,不覆盖旧文件');
  assert.deepEqual(allArtifacts.map(({ relativePath }) => relativePath), [
    'final-edits/plan-1/export-1.mp4',
    'final-edits/plan-1/export-2.mp4',
    'final-edits/plan-1/export-3.mp4',
  ]);
  assert.equal(getCurrentArtifactId(db, planId), artifact3, '最新导出必须自动成为当前成片');
  assert.equal(getArtifact(db, 'project-1', artifact1)?.relativePath, 'final-edits/plan-1/export-1.mp4');

  // 同一文件路径重复登记:拒绝
  assert.throws(
    () => registerArtifact(db, 'project-1', {
      batchId,
      batchVersionId: version1,
      outputPlanId: planId,
      outputVersionId,
      kind: 'video',
      relativePath: 'final-edits/plan-1/export-1.mp4',
      checksum: 'sha256:one-dup',
      now: () => new Date('2026-08-01T10:30:00.000Z'),
    }),
    /已登记/,
    '同一文件路径的正式产物不能重复登记',
  );
  assert.equal(listPlanArtifacts(db, planId).length, 3);

  // --- 从历史恢复旧版为当前成片:历史产物不删除 ---
  setCurrentArtifact(db, 'project-1', planId, artifact1);
  assert.equal(getCurrentArtifactId(db, planId), artifact1, '用户可恢复旧版为当前成片');
  assert.equal(listPlanArtifacts(db, planId).length, 3, '恢复旧版不得删除历史产物');

  // --- 其他成片失败不影响已登记的正式产物 ---
  assert.equal(getArtifact(db, 'project-1', artifact3)?.checksum, 'sha256:three', '登记过的产物不受其他成片失败影响');

  // --- 封面登记不改变当前成片;当前成片只能指向视频 ---
  const cover = registerArtifact(db, 'project-1', {
    batchId,
    batchVersionId: version1,
    outputPlanId: planId,
    outputVersionId,
    kind: 'cover',
    relativePath: 'final-edits/plan-1/cover-3.jpg',
    checksum: 'sha256:cover',
    now: () => new Date('2026-08-01T11:10:00.000Z'),
  });
  assert.ok(cover);
  assert.equal(listPlanArtifacts(db, planId).length, 4, '封面与视频是不同产物类型');
  assert.equal(getCurrentArtifactId(db, planId), artifact1, '登记封面不得改写当前成片指向');
  assert.throws(
    () => setCurrentArtifact(db, 'project-1', planId, cover),
    /视频/,
    '当前成片不能指向封面',
  );
  assert.equal(getCurrentArtifactId(db, planId), artifact1);

  // 候选口径(问题 3-C):同一 render 任务 attempt#1 成功、attempt#2 失败时,
  // 候选仍解析出 attempt#1 的产物——重渲染期间与失败后,老版本始终可播放。
  {
    const renderTaskId = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: outputVersionId,
      requestKey: `render:${outputVersionId}:candidate-fixture`,
    });
    const renderResult = {
      projectId: 'project-1', batchId, batchVersionId: version1, planId,
      outputVersionId, planSeq: 1, outputVersionNumber: 1,
      videoRelativePath: 'batch-renders/candidate/video.mp4',
      coverRelativePath: 'batch-renders/candidate/cover.jpg',
      videoChecksum: 'sha256:video', coverChecksum: 'sha256:cover',
      durationUs: 4_000_000, audioMode: 'narration', productionReady: true,
    };
    const attempt1 = startTaskAttempt(db, renderTaskId);
    finishTaskAttempt(db, renderTaskId, attempt1, { status: 'succeeded', resultJson: renderResult });
    // 重试:任务打回 queued 后产生失败的 attempt#2(任务汇总状态 failed)
    const attempt2 = startTaskAttempt(db, renderTaskId);
    finishTaskAttempt(db, renderTaskId, attempt2, { status: 'failed', errorMessage: '重渲染失败' });
    assert.equal((db.prepare(`SELECT status, attemptCount FROM batch_tasks WHERE id = ?`).get(renderTaskId) as { status: string; attemptCount: number }).status, 'failed', '任务汇总状态应为 failed');
    const candidateRoot = path.join(root, 'storage', 'batch-renders', 'candidate');
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, 'video.mp4'), Buffer.from('candidate-video'));
    fs.writeFileSync(path.join(candidateRoot, 'cover.jpg'), Buffer.from('candidate-cover'));
    const stillPlayable = resolveBatchOutputMedia(db, 'project-1', batchId, planId, 'video', 'candidate', path.join(root, 'storage'));
    assert.equal(stillPlayable.absolutePath, path.join(root, 'storage', 'batch-renders', 'candidate', 'video.mp4'), '重渲染失败后老候选仍可播放');
    assert.equal(stillPlayable.productionReady, true, '老候选的 productionReady 校验不变');
    const coverStill = resolveBatchOutputMedia(db, 'project-1', batchId, planId, 'cover', 'candidate', path.join(root, 'storage'));
    assert.equal(coverStill.absolutePath, path.join(root, 'storage', 'batch-renders', 'candidate', 'cover.jpg'), '封面候选同样回落到最近一次成功尝试');
  }

  // --- 用户删除批次是逻辑删除:列表隐藏，但正式产物及谱系继续保留 ---
  deleteBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-01T12:00:00.000Z'));
  assert.equal(getBatchProduction(db, 'project-1', batchId), undefined, '逻辑删除后的批次不得继续作为活跃工作单读取');
  assert.ok(!listProjectBatchProductions(db, 'project-1').some(({ id }) => id === batchId));
  assert.equal(listPlanArtifacts(db, planId).length, 4, '逻辑删除批次不得删除正式产物');
  assert.equal(getArtifact(db, 'project-1', artifact1)?.relativePath, 'final-edits/plan-1/export-1.mp4');
  assert.throws(
    () => registerArtifact(db, 'project-1', {
      batchId,
      batchVersionId: version1,
      outputPlanId: planId,
      outputVersionId,
      kind: 'video',
      relativePath: 'final-edits/plan-1/after-delete.mp4',
      checksum: 'sha256:after-delete',
    }),
    /批次不存在/,
    '逻辑删除后不得继续向该批次登记新产物',
  );

  // 物理删除仍被外键阻止，避免绕过领域接口破坏正式产物
  assert.throws(
    () => db.prepare(`DELETE FROM batch_productions WHERE id = ?`).run(batchId),
    /FOREIGN KEY|foreign key/i,
    '批次仍被正式产物引用时,删除批次必须被拒绝,产物记录不得级联消失',
  );
  assert.equal(listPlanArtifacts(db, planId).length, 4, '产物记录必须保留');

  db.close();
  console.log('batch domain artifacts tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
