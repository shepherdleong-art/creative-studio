import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { splitCoverTitle } from '../lib/media-core/cover-domain.ts';
import {
  createBatchProduction,
  createBatchProductionVersion,
  getBatchProduction,
  getBatchVersion,
  listBatchVersions,
} from '../lib/batch-production/versions.ts';
import {
  createManualProjectScript,
  createProjectScript,
  deleteManualProjectScript,
  getProjectScript,
  getScriptSnapshot,
  listProjectScripts,
  listScriptSnapshots,
  snapshotScriptIntoBatch,
  updateManualProjectScript,
} from '../lib/batch-production/scripts.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { syncProjectScripts } from '../lib/batch-production/script-catalog.ts';
import { BatchDomainError, type BatchDomainErrorCode } from '../lib/batch-production/errors.ts';
import {
  MANUAL_SCRIPT_BATCH_MAX,
  MANUAL_SCRIPT_BODY_MAX,
  normalizeManualScriptBatch,
  normalizeManualScriptInput,
  splitPastedScripts,
} from '../lib/batch-production/manual-script-import.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
    INSERT INTO shot_sets (id, projectId, name, createdAt)
    VALUES ('ss-1', 'project-1', '分镜组一', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

function assertBatchDomainError(
  fn: () => unknown,
  code: BatchDomainErrorCode,
  message?: RegExp,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BatchDomainError, '必须抛 BatchDomainError 而不是裸 Error');
    assert.equal(error.code, code, `错误码必须是 ${code}`);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function validV3Draft(title: string, narration: string[], shotSetId = 'ss-1'): string {
  return JSON.stringify({
    version: 3,
    title,
    coverTitleParts: { primary: '主标题', secondary: '副标题', source: 'model' },
    platform: 'douyin',
    tone: 'promo',
    templateId: 't1',
    template: 't1',
    shotSetId,
    targetDurationSec: 30,
    targetNarrationDurationSec: 28,
    contentCharacterCount: 20,
    estimatedNarrationDurationSec: 25,
    durationStatus: 'qualified',
    durationPolicyVersion: 'zh-tts-budget-v1',
    segments: narration.map((n) => ({ narration: n, subtitle: n, sellingPointRefs: [], visualIntent: '', visualKeywords: [] })),
    fullScript: narration.join('\n'),
    fullSubtitle: narration.join('\n'),
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-manual-script-'));

let openedDb: Database.Database | undefined;
try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  openedDb = db;

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-13T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 用例 1:导入后进入项目脚本列表,身份字段符合 manual: 约定 ---
  const manualId = createManualProjectScript(db, 'project-1', {
    title: '  夏日新品上市大促销  ',
    bodyText: '  这款新品真的很轻。带出门一整天也不累。  ',
    targetDurationSec: 30,
    now: () => new Date('2026-08-13T09:00:00.000Z'),
  });
  const manualRow = getProjectScript(db, 'project-1', manualId);
  assert.ok(manualRow, '导入的手动脚本必须可被项目脚本读取接口看到');
  assert.ok(manualRow.sourceId.startsWith('manual:'), '手动脚本必须使用 manual: sourceId 命名空间');
  assert.equal(manualRow.sourceKind, 'script_draft', '手动脚本复用项目脚本身份');
  assert.equal(manualRow.catalogManaged, 0, '手动脚本不得被同步器认领管理');
  assert.equal(manualRow.sourceAvailable, 1);
  assert.equal(manualRow.sourceVersion, '1', '手动脚本初始版本号为 1');
  assert.equal(manualRow.shotSetId, '', '手动脚本没有分镜组归属');
  assert.equal(manualRow.contentRevision, '', '手动脚本没有上游草稿修订身份');
  assert.equal(manualRow.title, '夏日新品上市大促销', '标题必须 trim');
  assert.equal(manualRow.bodyText, '这款新品真的很轻。带出门一整天也不累。', '正文必须 trim');
  assert.equal(manualRow.targetDurationSec, 30);
  assert.deepEqual(
    JSON.parse(manualRow.coverTitleJson),
    splitCoverTitle('夏日新品上市大促销'),
    '封面标题必须按标题确定性拆分,否则不会被烤进片头',
  );
  assert.ok(
    listProjectScripts(db, 'project-1').some(({ id }) => id === manualId),
    '手动脚本必须出现在项目脚本列表中',
  );

  // --- 用例 2:跑一次 syncProjectScripts 后手动脚本仍在(承重回归) ---
  db.prepare(`
    INSERT INTO script_drafts (id, projectId, inputSnapshot, outputJson, createdAt)
    VALUES ('draft-real', 'project-1', '{}', ?, '2026-08-13T09:05:00.000Z')
  `).run(validV3Draft('AI 脚本', ['第一段', '第二段']));
  const syncResult = syncProjectScripts(db, 'project-1', () => new Date('2026-08-13T09:06:00.000Z'));
  assert.equal(syncResult.synced, 1, '真草稿必须正常同步');
  const afterSync = getProjectScript(db, 'project-1', manualId);
  assert.ok(afterSync, 'syncProjectScripts 不得把手动脚本软删');
  assert.equal(afterSync.catalogManaged, 0, 'syncProjectScripts 不得认领 manual: 脚本');
  assert.ok(
    listProjectScripts(db, 'project-1').some(({ id }) => id === manualId),
    '同步后手动脚本必须仍在项目脚本列表中',
  );

  // --- 用例 3:编辑标题 → coverTitleJson 跟着变,narrationConfigJson 不丢 ---
  db.prepare(`UPDATE batch_scripts SET narrationConfigJson = ? WHERE id = ?`).run(
    JSON.stringify({ providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.2 }),
    manualId,
  );
  updateManualProjectScript(db, 'project-1', manualId, {
    title: '秋季焕新限时特惠',
    bodyText: '改写后的正文。第二句也在。',
    targetDurationSec: 45,
    now: () => new Date('2026-08-13T09:10:00.000Z'),
  });
  const editedRow = getProjectScript(db, 'project-1', manualId);
  assert.equal(editedRow?.title, '秋季焕新限时特惠');
  assert.equal(editedRow?.sourceVersion, '2', '编辑后 sourceVersion 必须递增');
  assert.equal(editedRow?.targetDurationSec, 45, '编辑必须能改目标时长');
  assert.deepEqual(
    JSON.parse(editedRow?.coverTitleJson ?? '{}'),
    splitCoverTitle('秋季焕新限时特惠'),
    '编辑标题必须同步更新封面标题拆分',
  );
  assert.deepEqual(
    JSON.parse(editedRow?.narrationConfigJson ?? '{}'),
    { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.2 },
    '编辑不得抹掉已配置的口播音色',
  );

  // --- 用例 4:编辑后重新确认不再幂等(matchesCurrentInput 判 false,形成新版本) ---
  const asset1 = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    now: () => new Date('2026-08-13T09:15:00.000Z'),
  });
  const analysis1 = createAnalysisVersion(db, {
    assetId: asset1,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-13T09:16:00.000Z'),
  });
  const batch4 = createBatchProduction(db, 'project-1', '编辑检测批次', () => new Date('2026-08-13T09:17:00.000Z'));
  const firstConfirm = createBatchSnapshot(db, 'project-1', batch4, {
    scriptSelections: [{ scriptId: manualId, copyCount: 1 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    now: () => new Date('2026-08-13T09:18:00.000Z'),
  });
  const repeatConfirm = createBatchSnapshot(db, 'project-1', batch4, {
    scriptSelections: [{ scriptId: manualId, copyCount: 1 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    now: () => new Date('2026-08-13T09:19:00.000Z'),
  });
  assert.equal(repeatConfirm.batchVersionId, firstConfirm.batchVersionId, '未修改时重复确认必须幂等复用');
  updateManualProjectScript(db, 'project-1', manualId, {
    title: '秋季焕新限时特惠',
    bodyText: '再次改写的正文。内容变了。',
    targetDurationSec: 45,
    now: () => new Date('2026-08-13T09:20:00.000Z'),
  });
  const afterEditConfirm = createBatchSnapshot(db, 'project-1', batch4, {
    scriptSelections: [{ scriptId: manualId, copyCount: 1 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    now: () => new Date('2026-08-13T09:21:00.000Z'),
  });
  assert.notEqual(
    afterEditConfirm.batchVersionId,
    firstConfirm.batchVersionId,
    '编辑手动脚本后同样的选择必须形成新批次版本(输入身份已变化)',
  );
  assert.equal(listBatchVersions(db, batch4).length, 2);

  // --- 用例 5:快照 → startBatchProduction 完整链路走通 ---
  const batch5 = createBatchProduction(db, 'project-1', '手动脚本开跑批次', () => new Date('2026-08-13T09:30:00.000Z'));
  const confirm5 = createBatchSnapshot(db, 'project-1', batch5, {
    scriptSelections: [{ scriptId: manualId, copyCount: 2 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    now: () => new Date('2026-08-13T09:31:00.000Z'),
  });
  assert.equal(confirm5.totalPlans, 2, '份数必须精确决定成片计划数量');
  startBatchProduction(db, 'project-1', batch5, () => new Date('2026-08-13T09:32:00.000Z'));
  assert.equal(getBatchVersion(db, batch5, confirm5.batchVersionId)?.inputState, 'frozen', '开跑后版本必须冻结');
  assert.equal(getBatchProduction(db, 'project-1', batch5)?.status, 'running');
  const frozenSnapshot = listScriptSnapshots(db, confirm5.batchVersionId)[0];
  assert.equal(frozenSnapshot?.bodyText, '再次改写的正文。内容变了。', '冻结快照必须锁定手动脚本最新正文');
  assert.equal(frozenSnapshot?.shotSetId, '', '手动脚本空 shotSetId 必须能进入快照');
  const stillThere = getProjectScript(db, 'project-1', manualId);
  assert.ok(stillThere, 'startBatchProduction 内部的 syncProjectScripts 不得杀掉手动脚本');

  // --- 用例 6:删除——未引用物理删;已引用软删且历史快照保留 ---
  const unreferencedId = createManualProjectScript(db, 'project-1', {
    title: '从未使用的脚本',
    bodyText: '这条没有被任何批次引用。',
    targetDurationSec: 15,
  });
  const hardDelete = deleteManualProjectScript(db, 'project-1', unreferencedId);
  assert.equal(hardDelete.mode, 'hard', '未被快照引用的手动脚本必须物理删除');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts WHERE id = ?`).get(unreferencedId) as { n: number }).n,
    0,
    '物理删除后数据库不得残留该行',
  );

  const batch6 = createBatchProduction(db, 'project-1', '软删批次', () => new Date('2026-08-13T09:40:00.000Z'));
  const version6 = createBatchProductionVersion(db, batch6, { copyCount: 1, now: () => new Date('2026-08-13T09:41:00.000Z') });
  const referencedId = createManualProjectScript(db, 'project-1', {
    title: '已被快照引用的脚本',
    bodyText: '这条已经进入批次快照。',
    targetDurationSec: 15,
  });
  const snapshotId6 = snapshotScriptIntoBatch(db, version6, {
    scriptId: referencedId,
    copyCount: 1,
    now: () => new Date('2026-08-13T09:42:00.000Z'),
  });
  const softDelete = deleteManualProjectScript(db, 'project-1', referencedId);
  assert.equal(softDelete.mode, 'soft', '已被快照引用的手动脚本只能软删(外键 ON DELETE RESTRICT)');
  assert.equal(
    listProjectScripts(db, 'project-1').some(({ id }) => id === referencedId),
    false,
    '软删后必须从项目脚本列表消失',
  );
  assert.equal(
    (db.prepare(`SELECT sourceAvailable FROM batch_scripts WHERE id = ?`).get(referencedId) as { sourceAvailable: number }).sourceAvailable,
    0,
    '软删必须把 sourceAvailable 置 0',
  );
  assert.equal(
    getScriptSnapshot(db, version6, snapshotId6)?.sourceScriptId,
    referencedId,
    '软删后历史批次快照必须保留',
  );

  // --- 用例 7:输入校验全部抛 BatchDomainError('invalid_input') ---
  const baseValid = { title: '合法标题', bodyText: '合法正文。有实义内容。', targetDurationSec: 15 };
  assertBatchDomainError(() => normalizeManualScriptInput({ ...baseValid, title: '' }), 'invalid_input', /标题/);
  assertBatchDomainError(() => normalizeManualScriptInput({ ...baseValid, title: '   ' }), 'invalid_input', /标题/);
  assertBatchDomainError(
    () => normalizeManualScriptInput({ ...baseValid, title: '标'.repeat(201) }),
    'invalid_input',
    /200/,
  );
  assertBatchDomainError(() => normalizeManualScriptInput({ ...baseValid, bodyText: '' }), 'invalid_input', /正文/);
  assertBatchDomainError(() => normalizeManualScriptInput({ ...baseValid, bodyText: '   \n  ' }), 'invalid_input', /正文/);
  assertBatchDomainError(
    () => normalizeManualScriptInput({ ...baseValid, bodyText: '正'.repeat(MANUAL_SCRIPT_BODY_MAX + 1) }),
    'invalid_input',
    /5000/,
  );
  // §6.5 回归点:这些输入能通过断句器(不在句界集合里,整串成为 tail)但没有任何实义字符
  for (const punctuationOnly of ['，，，', '……', '——', '。。。']) {
    assertBatchDomainError(
      () => normalizeManualScriptInput({ ...baseValid, bodyText: punctuationOnly }),
      'invalid_input',
      undefined,
    );
  }
  for (const badDuration of [Number.NaN, 0, 601, 15.5, -1]) {
    assertBatchDomainError(
      () => normalizeManualScriptInput({ ...baseValid, targetDurationSec: badDuration }),
      'invalid_input',
      /时长/,
    );
  }
  // 创建与编辑路径同样走校验
  assertBatchDomainError(
    () => createManualProjectScript(db, 'project-1', { ...baseValid, bodyText: '，，，' }),
    'invalid_input',
  );
  assertBatchDomainError(
    () => updateManualProjectScript(db, 'project-1', manualId, { ...baseValid, targetDurationSec: 0 }),
    'invalid_input',
  );
  // 批量上限:条数与总字符数
  const maxBatch = Array.from({ length: MANUAL_SCRIPT_BATCH_MAX + 1 }, (_, index) => ({
    title: `标题${index}`,
    bodyText: '合法正文。有实义内容。',
    targetDurationSec: 15,
  }));
  assertBatchDomainError(() => normalizeManualScriptBatch(maxBatch), 'invalid_input', /50/);
  const oversizedPaste = Array.from({ length: 21 }, (_, index) => ({
    title: `标题${index}`,
    bodyText: '字'.repeat(MANUAL_SCRIPT_BODY_MAX),
    targetDurationSec: 15,
  }));
  assertBatchDomainError(() => normalizeManualScriptBatch(oversizedPaste), 'invalid_input', /100000/);
  assert.equal(normalizeManualScriptBatch([baseValid]).length, 1, '合法批量输入必须全部通过');

  // --- 用例 8:软删后 update 抛 conflict;非 manual: 脚本 update/delete 抛 not_found ---
  assertBatchDomainError(
    () => updateManualProjectScript(db, 'project-1', referencedId, baseValid),
    'conflict',
    /已被删除/,
  );
  const aiScriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-real',
    title: 'AI 同步脚本',
    bodyText: 'AI 正文',
    sourceVersion: '3',
    now: () => new Date('2026-08-13T10:00:00.000Z'),
  });
  assertBatchDomainError(
    () => updateManualProjectScript(db, 'project-1', aiScriptId, baseValid),
    'not_found',
    /手动脚本不存在/,
  );
  assertBatchDomainError(
    () => deleteManualProjectScript(db, 'project-1', aiScriptId),
    'not_found',
    /手动脚本不存在/,
  );
  assertBatchDomainError(
    () => updateManualProjectScript(db, 'project-2', manualId, baseValid),
    'not_found',
    /手动脚本不存在/,
  );
  assertBatchDomainError(
    () => deleteManualProjectScript(db, 'project-1', 'missing-script-id'),
    'not_found',
    /手动脚本不存在/,
  );
  assertBatchDomainError(
    () => deleteManualProjectScript(db, 'project-1', referencedId),
    'not_found',
    /手动脚本不存在/,
  );

  // --- 用例 9:splitPastedScripts 切分 ---
  assert.deepEqual(
    splitPastedScripts('标题一\n正文一\n\n标题二\n正文二'),
    [
      { title: '标题一', bodyText: '正文一' },
      { title: '标题二', bodyText: '正文二' },
    ],
    '按空行切块,每块首行作标题、其余作正文',
  );
  assert.deepEqual(
    splitPastedScripts('只有一行的块'),
    [{ title: '只有一行的块', bodyText: '只有一行的块' }],
    '单行块的该行同时作标题与正文',
  );
  assert.deepEqual(
    splitPastedScripts('\n\n标题\n正文\n\n\n'),
    [{ title: '标题', bodyText: '正文' }],
    '首尾多余空行必须忽略',
  );
  assert.deepEqual(
    splitPastedScripts('A\n\n\n\nB'),
    [{ title: 'A', bodyText: 'A' }, { title: 'B', bodyText: 'B' }],
    '块间多个空行按一个分隔处理',
  );
  assert.deepEqual(splitPastedScripts('\n\n  \n\n'), [], '切完为空的块必须忽略');
  assert.deepEqual(
    splitPastedScripts('标题\n第一行\n第二行\n第三行'),
    [{ title: '标题', bodyText: '第一行\n第二行\n第三行' }],
    '多行正文按换行保留',
  );

  db.close();
  console.log('batch manual script tests passed');
} finally {
  try { openedDb?.close(); } catch { /* 已关闭则忽略 */ }
  fs.rmSync(root, { recursive: true, force: true });
}
