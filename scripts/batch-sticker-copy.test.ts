// 运行：node scripts/batch-sticker-copy.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';
import {
  copyBatchOutputStickers,
  restoreBatchOutputStickers,
  type BatchStickerCopyTarget,
  type BatchStickerTargetMutationResult,
} from '../lib/batch-production/sticker-copy.ts';
import type {
  PackagingStickerDefaults,
  PackagingStickerInstance,
} from '../lib/media-core/packaging-stickers.ts';

interface TestPackaging {
  enabled: boolean;
  template: 'overlay-poster' | 'overlay-journal';
  varsOverrides: Record<string, string>;
  stickers?: PackagingStickerInstance[];
  stickerDefaults?: PackagingStickerDefaults;
  pointCuesLayoutVersion?: number;
  layoutRuntimeBundleVersion?: number;
  layoutResolution?: Record<string, unknown>;
}

interface TestArrangement {
  editRevision: number;
  clips: Array<Record<string, unknown>>;
  narration: { durationUs: number };
  packaging: TestPackaging;
  preserveGaps: boolean;
  music: Record<string, unknown>;
  review?: { decision: string };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-sticker-copy-'));
const previousPackagingDir = process.env.CREATIVE_STUDIO_PACKAGING_DIR;
const db = new Database(path.join(root, 'workbench.db'));

function sticker(overrides: Partial<PackagingStickerInstance> = {}): PackagingStickerInstance {
  return {
    id: 'sticker',
    assetId: 'highlight',
    styleMode: 'fixed',
    fixedStyle: 'show',
    startFrame: 40,
    endFrame: 160,
    centerXPct: 47,
    centerYPct: 53,
    visualWidthPct: 37,
    rotationDeg: 12,
    trackIndex: 7,
    animation: 'slide',
    origin: { kind: 'manual' },
    ...overrides,
  };
}

function arrangement(input: {
  revision: number;
  durationUs?: number;
  template?: TestPackaging['template'];
  title: string;
  stickers?: PackagingStickerInstance[];
  stickerDefaults?: PackagingStickerDefaults;
  reviewed?: boolean;
}): TestArrangement {
  const durationUs = input.durationUs ?? 10_000_000;
  return {
    editRevision: input.revision,
    clips: [{ clipId: `clip-${input.title}`, timelineStartUs: 0, timelineEndUs: durationUs }],
    narration: { durationUs },
    packaging: {
      enabled: true,
      template: input.template ?? 'overlay-poster',
      varsOverrides: { title: input.title, point1: `${input.title}-point` },
      ...(input.stickers === undefined ? {} : { stickers: input.stickers }),
      ...(input.stickerDefaults === undefined ? {} : { stickerDefaults: input.stickerDefaults }),
    },
    preserveGaps: true,
    music: { trackId: `music-${input.title}`, gainDb: -12 },
    ...(input.reviewed === false ? {} : { review: { decision: 'approved' } }),
  };
}

function raw(outputVersionId: string): string {
  return (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = ?`).get(outputVersionId) as { arrangementJson: string }).arrangementJson;
}

function parsed(outputVersionId: string): TestArrangement {
  return JSON.parse(raw(outputVersionId)) as TestArrangement;
}

function target(planId: string): BatchStickerCopyTarget {
  const row = db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planId) as { currentVersionId: string };
  return {
    planId,
    expectedOutputVersionId: row.currentVersionId,
    expectedEditRevision: parsed(row.currentVersionId).editRevision,
  };
}

function allRaw(): Record<string, string> {
  const rows = db.prepare(`SELECT id, arrangementJson FROM batch_output_versions ORDER BY id`).all() as Array<{ id: string; arrangementJson: string }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.arrangementJson]));
}

async function expectDomain(code: BatchDomainError['code'], operation: () => unknown | Promise<unknown>): Promise<void> {
  await assert.rejects(async () => { await operation(); }, (error: unknown) => error instanceof BatchDomainError && error.code === code);
}

function assertOnlyStickerFieldsChanged(before: TestArrangement, after: TestArrangement): void {
  const arrangementKeys = new Set(['packaging', 'editRevision', 'review']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after).filter(([key]) => !arrangementKeys.has(key))),
    Object.fromEntries(Object.entries(before).filter(([key]) => !arrangementKeys.has(key))),
    'arrangement 非贴纸字段必须原样保留',
  );
  const packagingKeys = new Set(['stickers', 'stickerDefaults']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after.packaging).filter(([key]) => !packagingKeys.has(key))),
    Object.fromEntries(Object.entries(before.packaging).filter(([key]) => !packagingKeys.has(key))),
    '目标自己的模板、文案及其他包装字段必须原样保留',
  );
  assert.equal(after.editRevision, before.editRevision + 1);
  assert.equal(after.review, undefined);
}

function restoreTargets(results: BatchStickerTargetMutationResult[], side: 'before' | 'after'): Array<BatchStickerCopyTarget & { snapshot: BatchStickerTargetMutationResult['before'] }> {
  return results.map((result) => ({
    planId: result.planId,
    expectedOutputVersionId: result.outputVersionId,
    expectedEditRevision: result.afterEditRevision,
    snapshot: result[side],
  }));
}

try {
  const packagingDir = path.join(root, 'packaging');
  fs.mkdirSync(path.join(packagingDir, 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(packagingDir, 'stickers', 'catalog.json'), JSON.stringify({ assets: [] }));
  process.env.CREATIVE_STUDIO_PACKAGING_DIR = packagingDir;

  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    productCode TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT '',
    exportDirName TEXT NOT NULL DEFAULT ''
  )`);
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');
  const now = '2026-10-28T08:00:00.000Z';
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '项目一')`).run();
  db.prepare(`INSERT INTO batch_productions (id,projectId,name,status,currentVersionId,progressJson,controlState,createdAt,updatedAt)
    VALUES ('b1','p1','批次一','running','bv1','{}','running',?,?)`).run(now, now);
  const insertBatchVersion = db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt)
    VALUES (?,?,?,1,'{}','frozen',?,?)`);
  insertBatchVersion.run('bv1', 'b1', 1, now, now);
  insertBatchVersion.run('bv2', 'b1', 2, now, now);
  db.prepare(`INSERT INTO batch_scripts (id,projectId,sourceKind,sourceId,title,bodyText,sourceVersion,createdAt,updatedAt)
    VALUES ('s1','p1','script_draft','src1','脚本标题','正文','v1',?,?)`).run(now, now);
  const insertSnapshot = db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt)
    VALUES (?,?,'s1','脚本标题','正文','v1',1,?)`);
  insertSnapshot.run('ss1', 'bv1', now);
  insertSnapshot.run('ss2', 'bv2', now);
  const insertPlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,createdAt)
    VALUES (?,?,?,?,'{}',?,?)`);
  const insertVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt)
    VALUES (?,?,1,?,?)`);
  const addPlan = (planId: string, value: TestArrangement, batchVersionId = 'bv1', seq = 1) => {
    const outputVersionId = `ov-${planId}`;
    insertPlan.run(planId, batchVersionId, batchVersionId === 'bv1' ? 'ss1' : 'ss2', seq, outputVersionId, now);
    insertVersion.run(outputVersionId, planId, JSON.stringify(value), now);
  };

  const source = arrangement({
    revision: 3,
    title: 'source',
    stickers: [sticker({ id: 'source-sticker' })],
    stickerDefaults: { animation: 'zoom' },
  });
  const targetOne = arrangement({
    revision: 4,
    durationUs: 5_000_000,
    template: 'overlay-journal',
    title: 'target-one',
    stickers: [sticker({ id: 'old-target-sticker', startFrame: 20, endFrame: 60, animation: 'none' })],
    stickerDefaults: { animation: 'soft' },
  });
  const targetTwo = arrangement({ revision: 7, title: 'target-two' });
  addPlan('source', source, 'bv1', 1);
  addPlan('target-one', targetOne, 'bv1', 2);
  addPlan('target-two', targetTwo, 'bv1', 3);
  addPlan('short', arrangement({ revision: 2, durationUs: 1_000_000, title: 'short' }), 'bv1', 4);
  addPlan('empty-source', arrangement({ revision: 1, title: 'empty', stickers: [] }), 'bv1', 5);
  addPlan('other-version', arrangement({ revision: 1, title: 'other' }), 'bv2', 1);

  const sourceRawBefore = raw('ov-source');
  let randomCalls = 0;
  const copied = await copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source',
    targets: [target('target-one'), target('target-two')],
  }, {
    random: () => { randomCalls += 1; return 0; },
    createId: (request) => request.kind === 'sticker'
      ? `copied_${request.targetIndex}_${request.sourceStickerId}`
      : `group_${request.targetIndex}_${request.sourceAutoGroupId}`,
  });
  assert.equal(randomCalls, 0, '纯手动复制不应读取随机源');
  assert.equal(copied.targets.length, 2);
  assert.equal(raw('ov-source'), sourceRawBefore, '来源 arrangement 与审核态不得改写');

  const copiedOne = parsed('ov-target-one');
  const copiedTwo = parsed('ov-target-two');
  assertOnlyStickerFieldsChanged(targetOne, copiedOne);
  assertOnlyStickerFieldsChanged(targetTwo, copiedTwo);
  assert.deepEqual(copiedOne.packaging.stickers, [{
    ...source.packaging.stickers![0],
    id: 'copied_0_source-sticker',
    startFrame: 30,
    endFrame: 90,
  }], '目标旧贴纸必须全部替换，手动时间按目标正文等比映射');
  assert.deepEqual(copiedTwo.packaging.stickers, [{
    ...source.packaging.stickers![0],
    id: 'copied_1_source-sticker',
  }]);
  assert.deepEqual(copiedOne.packaging.stickerDefaults, { animation: 'zoom' });
  assert.deepEqual(copiedTwo.packaging.stickerDefaults, { animation: 'zoom' });
  assert.ok(copied.targets.every((result) => result.reviewCleared));
  assert.deepEqual(copied.targets.map((result) => [result.beforeEditRevision, result.afterEditRevision]), [[4, 5], [7, 8]]);
  assert.deepEqual(copied.targets[0].before.stickers, targetOne.packaging.stickers);
  assert.deepEqual(copied.targets[0].after.stickers, copiedOne.packaging.stickers);

  const afterCopyRaw = allRaw();
  await expectDomain('invalid_input', () => copyBatchOutputStickers(db, 'p1', 'b1', { sourcePlanId: 'source', targets: [] }));
  await expectDomain('invalid_input', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source', targets: [target('target-one'), target('target-one')],
  }));
  await expectDomain('invalid_input', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source', targets: [target('source')],
  }));
  await expectDomain('conflict', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source', targets: [target('other-version')],
  }));
  await expectDomain('invalid_input', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'empty-source', targets: [target('target-one')],
  }));
  assert.deepEqual(allRaw(), afterCopyRaw, '空目标、重复、自复制、跨版本与空来源均须零写入');

  await expectDomain('conflict', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source',
    targets: [target('target-one'), { ...target('target-two'), expectedEditRevision: 999 }],
  }));
  assert.deepEqual(allRaw(), afterCopyRaw, '任一目标修订冲突时所有目标保持原字节与审核态');

  await expectDomain('invalid_input', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'source', targets: [target('target-one'), target('short')],
  }));
  assert.deepEqual(allRaw(), afterCopyRaw, '任一目标时长不足时不得写入先前有效目标');

  const undone = restoreBatchOutputStickers(db, 'p1', 'b1', { targets: restoreTargets(copied.targets, 'before') });
  const undoneOne = parsed('ov-target-one');
  const undoneTwo = parsed('ov-target-two');
  assertOnlyStickerFieldsChanged(copiedOne, undoneOne);
  assertOnlyStickerFieldsChanged(copiedTwo, undoneTwo);
  assert.deepEqual(undoneOne.packaging.stickers, targetOne.packaging.stickers);
  assert.deepEqual(undoneOne.packaging.stickerDefaults, targetOne.packaging.stickerDefaults);
  assert.equal(undoneTwo.packaging.stickers, undefined);
  assert.equal(undoneTwo.packaging.stickerDefaults, undefined);
  assert.deepEqual(undone.targets.map((result) => result.afterEditRevision), [6, 9]);
  assert.ok(undone.targets.every((result) => !result.reviewCleared), '复制已清审核时，撤销不得虚构新的审核清除');
  assert.equal(raw('ov-source'), sourceRawBefore, '多片恢复仍不得写来源');

  const redoTargets = copied.targets.map((result, index) => ({
    planId: result.planId,
    expectedOutputVersionId: result.outputVersionId,
    expectedEditRevision: undone.targets[index].afterEditRevision,
    snapshot: result.after,
  }));
  const redone = restoreBatchOutputStickers(db, 'p1', 'b1', { targets: redoTargets });
  assert.deepEqual(parsed('ov-target-one').packaging.stickers, copiedOne.packaging.stickers, '重做必须复用持久化变体而非重新随机');
  assert.deepEqual(parsed('ov-target-two').packaging.stickers, copiedTwo.packaging.stickers);
  assert.deepEqual(redone.targets.map((result) => result.afterEditRevision), [7, 10]);

  const beforeRestoreConflict = allRaw();
  await expectDomain('conflict', () => restoreBatchOutputStickers(db, 'p1', 'b1', {
    targets: redone.targets.map((result, index) => ({
      planId: result.planId,
      expectedOutputVersionId: result.outputVersionId,
      expectedEditRevision: index === 1 ? result.afterEditRevision - 1 : result.afterEditRevision,
      snapshot: result.before,
    })),
  }));
  assert.deepEqual(allRaw(), beforeRestoreConflict, '恢复时任一片修订冲突必须全部零写入');

  // v2：事务外 CLS 预检、Resolution 随快照持久化、撤销重做复用同一解析结果。
  const v2TargetOne = arrangement({ revision: 2, title: 'v2-target-one' });
  const v2TargetTwo = arrangement({ revision: 5, title: 'v2-target-two' });
  for (const value of [v2TargetOne, v2TargetTwo]) {
    value.packaging.pointCuesLayoutVersion = 2;
    value.packaging.layoutRuntimeBundleVersion = 2;
  }
  addPlan('v2-source', arrangement({ revision: 1, title: 'v2-source', stickers: [sticker({ id: 'v2-source-sticker' })] }), 'bv1', 6);
  addPlan('v2-target-one', v2TargetOne, 'bv1', 7);
  addPlan('v2-target-two', v2TargetTwo, 'bv1', 8);
  const v2SourceRaw = raw('ov-v2-source');
  const resolveLayout = async ({ planId, config }: { planId: string; config: { stickers?: PackagingStickerInstance[] } }) => ({
    schemaVersion: 1 as const,
    status: 'resolved' as const,
    inputHash: 'a'.repeat(64),
    runtimeBundleVersion: 2,
    geometryManifestHash: 'b'.repeat(64),
    outputWidth: 1080,
    outputHeight: 1440,
    elements: Object.fromEntries((config.stickers ?? []).map((item) => [item.id, {
      id: item.id, kind: 'sticker' as const, centerXPct: item.centerXPct, centerYPct: item.centerYPct, positionPinned: false,
    }])),
    validation: { frameCount: 1, digest: planId },
  });
  const v2Copied = await copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'v2-source',
    targets: [target('v2-target-one'), target('v2-target-two')],
  }, {
    createId: (request) => request.kind === 'sticker' ? `v2_${request.targetIndex}_${request.sourceStickerId}` : `v2_group_${request.targetIndex}`,
    resolveLayout,
  });
  assert.equal(raw('ov-v2-source'), v2SourceRaw, 'v2 预检与提交仍不得改写来源');
  assert.equal((parsed('ov-v2-target-one').packaging.layoutResolution!.validation as { digest: string }).digest, 'v2-target-one');
  assert.equal((parsed('ov-v2-target-two').packaging.layoutResolution!.validation as { digest: string }).digest, 'v2-target-two');
  assert.deepEqual(v2Copied.targets[0].after.layoutResolution, parsed('ov-v2-target-one').packaging.layoutResolution);
  const v2Undone = restoreBatchOutputStickers(db, 'p1', 'b1', { targets: restoreTargets(v2Copied.targets, 'before') });
  assert.equal(parsed('ov-v2-target-one').packaging.layoutResolution, undefined);
  assert.equal(parsed('ov-v2-target-one').packaging.layoutRuntimeBundleVersion, 2, '撤销只恢复快照字段，不回填不存在的 Resolution');
  const v2Redone = restoreBatchOutputStickers(db, 'p1', 'b1', {
    targets: v2Copied.targets.map((result, index) => ({
      planId: result.planId,
      expectedOutputVersionId: result.outputVersionId,
      expectedEditRevision: v2Undone.targets[index].afterEditRevision,
      snapshot: result.after,
    })),
  });
  assert.deepEqual(parsed('ov-v2-target-one').packaging.layoutResolution, v2Copied.targets[0].after.layoutResolution, '重做必须恢复同一 Resolution，不重新随机或重算');
  assert.equal(v2Redone.targets.length, 2);

  const beforeV2Failure = allRaw();
  await expectDomain('conflict', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'v2-source', targets: [target('v2-target-one'), target('v2-target-two')],
  }, { resolveLayout: async () => ({ status: 'infeasible' as const }) }));
  assert.deepEqual(allRaw(), beforeV2Failure, '任一目标 CLS 无解时整批零写入');

  await expectDomain('conflict', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'v2-source', targets: [target('v2-target-one')],
  }, {
    resolveLayout: async (input) => {
      const current = parsed('ov-v2-target-one');
      current.editRevision += 1;
      db.prepare(`UPDATE batch_output_versions SET arrangementJson=? WHERE id='ov-v2-target-one'`).run(JSON.stringify(current));
      return resolveLayout(input);
    },
  }));
  assert.equal(parsed('ov-v2-target-one').packaging.layoutRuntimeBundleVersion, 2);
  assert.deepEqual(parsed('ov-v2-target-one').packaging.stickers, v2Copied.targets[0].after.stickers, '预检期间目标被并发修改时必须放弃整批提交');

  await expectDomain('conflict', () => copyBatchOutputStickers(db, 'p1', 'b1', {
    sourcePlanId: 'v2-source', targets: [target('v2-target-two')],
  }, {
    resolveLayout: async (input) => {
      const current = parsed('ov-v2-source');
      current.editRevision += 1;
      db.prepare(`UPDATE batch_output_versions SET arrangementJson=? WHERE id='ov-v2-source'`).run(JSON.stringify(current));
      return resolveLayout(input);
    },
  }));
  assert.deepEqual(parsed('ov-v2-target-two').packaging.stickers, v2Copied.targets[1].after.stickers, '预检期间来源变化时目标不得写入');

  console.log('批次贴纸复制测试通过：双目标、字段隔离、替换、来源不变、审核清除、整体回滚、整体撤销/重做及 v2 预检。');
} finally {
  db.close();
  if (previousPackagingDir === undefined) delete process.env.CREATIVE_STUDIO_PACKAGING_DIR;
  else process.env.CREATIVE_STUDIO_PACKAGING_DIR = previousPackagingDir;
  fs.rmSync(root, { recursive: true, force: true });
}
