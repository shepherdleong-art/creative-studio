// scripts/batch-lut-color-snapshot.test.ts
//
// Phase D 色彩快照回归:每份素材的 LUT 选择必须进入冻结输入比较，
// createBatchSnapshot / matchesCurrentInput / getBatchSnapshotDetail 保持一致；
// 代理是否已生成不得进入正式输入身份。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import {
  createBatchSnapshot,
  getBatchSnapshotDetail,
  startBatchProduction,
} from '../lib/batch-production/batch-flow.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-03T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lut-color-snapshot-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const script = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const asset = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:lut-snapshot-test',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  const analysis = createAnalysisVersion(db, {
    assetId: asset, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:02:30.000Z'),
  });

  // 完整 LutCatalog 导入流程属于 D3;这里只关心"色彩快照进入冻结输入"这一冻结合同,
  // 因此直接造已验证的 batch_luts 行(等价于 D3 完成后的导入结果)。
  function insertLut(id: string, displayName: string, fingerprint: string, createdAt: string): void {
    db.prepare(`
      INSERT INTO batch_luts
        (id, projectId, contentFingerprint, displayName, relativePath, fileSizeBytes, verifiedAt, status, createdAt, updatedAt)
      VALUES (?, 'project-1', ?, ?, ?, 1024, ?, 'active', ?, ?)
    `).run(id, fingerprint, displayName, `storage/luts/project-1/${id}.cube`, createdAt, createdAt, createdAt);
  }
  insertLut('lut-camera-log-v1', 'LOG-A', 'sha256:1111111111111111111111111111111111111111111111111111111111111111', '2026-08-03T08:02:40.000Z');
  insertLut('lut-camera-log-v2', 'LOG-A-v2', 'sha256:2222222222222222222222222222222222222222222222222222222222222222', '2026-08-03T08:02:50.000Z');

  const batchId = createBatchProduction(db, 'project-1', 'LUT 冻结身份测试', () => new Date('2026-08-03T08:03:00.000Z'));

  // --- 场景 1:关闭 LUT 建立第一个 draft 版本 ---
  const off = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: null } }],
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });

  // --- 场景 2:同样的脚本与素材,但把该素材的 LUT 改为引用一个 LUT 身份 ——
  //             这必须被视为整体输入变化,形成新的 draft 版本,而不是被当成
  //             幂等重复确认合并回旧版本(今天 colorSnapshot 被忽略,会被误判为相同输入)。
  const withLut = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: 'lut-camera-log-v1' } }],
    now: () => new Date('2026-08-03T08:05:00.000Z'),
  });
  assert.notEqual(
    withLut.batchVersionId,
    off.batchVersionId,
    'LUT 选择变化必须形成新的批次版本,不能被当成相同整体输入幂等复用',
  );

  // --- 场景 3:批次详情必须能看到每份素材实际采用的色彩快照 ---
  const detail = getBatchSnapshotDetail(db, 'project-1', batchId);
  const poolEntry = detail.assetPool.find((item) => item.assetId === asset);
  assert.ok(poolEntry, '素材池详情必须包含该素材');
  assert.equal(
    (poolEntry as unknown as { colorSnapshot?: { lutId: string | null } }).colorSnapshot?.lutId,
    'lut-camera-log-v1',
    '批次详情必须暴露该素材当前采用的色彩快照(LUT 引用或关闭),供预览与正式导出前置检查复用',
  );

  // --- 场景 4:同一次确认(相同脚本、相同素材、相同 LUT 引用)必须保持幂等,不产生第三个版本 ---
  const repeat = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: 'lut-camera-log-v1' } }],
    now: () => new Date('2026-08-03T08:06:00.000Z'),
  });
  assert.equal(repeat.batchVersionId, withLut.batchVersionId, '相同整体输入(含相同 LUT 引用)必须幂等复用同一版本');

  // --- 场景 5:开跑冻结后,同一素材换一个新 LUT 引用必须新建版本,旧版本的色彩快照不能被覆盖 ---
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:07:00.000Z'));
  const afterFreezeDetail = getBatchSnapshotDetail(db, 'project-1', batchId);
  const frozenPoolEntry = afterFreezeDetail.assetPool.find((item) => item.assetId === asset);
  assert.equal(
    (frozenPoolEntry as unknown as { colorSnapshot?: { lutId: string | null } }).colorSnapshot?.lutId,
    'lut-camera-log-v1',
    '冻结后的批次版本色彩快照必须保持开跑时锁定的 LUT 引用',
  );

  const changedAfterFreeze = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: 'lut-camera-log-v2' } }],
    now: () => new Date('2026-08-03T08:08:00.000Z'),
  });
  assert.notEqual(changedAfterFreeze.batchVersionId, withLut.batchVersionId, '冻结后修改 LUT 引用必须创建新版本');

  const stillFrozenDetail = getBatchSnapshotDetail(db, 'project-1', batchId);
  // getBatchSnapshotDetail 读取的是"当前版本"(currentVersionId 已经指向新 draft),
  // 因此这里直接核对旧的、已冻结版本的落库色彩快照没有被就地改写。
  const oldVersionPoolRow = db.prepare(`
    SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?
  `).get(withLut.batchVersionId, asset) as { colorJson?: string } | undefined;
  assert.ok(oldVersionPoolRow, '旧冻结版本的素材池记录必须继续存在');
  const parsedOldColor = JSON.parse(oldVersionPoolRow!.colorJson ?? '{}');
  assert.equal(
    parsedOldColor.lutId,
    'lut-camera-log-v1',
    '旧冻结版本的色彩快照必须保持开跑时的 LUT 引用,不能被新版本的选择覆盖',
  );
  void stillFrozenDetail;

  // --- 场景 6:同名不同内容的新 LUT 不会覆盖旧内容,也不会让旧冻结版本改指向 ---
  insertLut('lut-camera-log-v1-same-name', 'LOG-A', 'sha256:3333333333333333333333333333333333333333333333333333333333333333', '2026-08-03T08:09:00.000Z');
  const stillOldContentRow = db.prepare(`
    SELECT contentFingerprint FROM batch_luts WHERE id = 'lut-camera-log-v1'
  `).get() as { contentFingerprint: string };
  assert.equal(stillOldContentRow.contentFingerprint, 'sha256:1111111111111111111111111111111111111111111111111111111111111111', '同名新 LUT 不能覆盖旧 LUT 的内容指纹');
  const stillReferencingOldId = db.prepare(`
    SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?
  `).get(withLut.batchVersionId, asset) as { colorJson: string };
  assert.equal(
    JSON.parse(stillReferencingOldId.colorJson).lutId,
    'lut-camera-log-v1',
    '同名新 LUT 导入后,已冻结版本必须继续引用原来的 LUT id,不能被同名新内容顶替',
  );

  db.close();
  console.log('batch-lut-color-snapshot tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
