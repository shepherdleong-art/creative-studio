import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createTask, getTask, recoverInterruptedTasks, updateTask } from '../lib/script-studio/tasks.ts';
import { evidenceTilesForPoint, executeScriptStudioTask, type ScriptStudioRunDeps } from '../lib/script-studio/runner.ts';
import { createLibraryRevision, getCurrentLibraryRevision, manualEditLibraryRevision } from '../lib/script-studio/libraries.ts';
import type { TileSetResult } from '../lib/script-studio/tiling.ts';
import {
  requestScriptStudioTaskCancel,
  SCRIPT_STUDIO_SCHEDULER_KEY,
  type ScriptStudioSchedulerController,
} from '../lib/script-studio/scheduler.ts';
import { buildDeterministicFallbackScript } from './script-studio-fixture.ts';
import type { ScriptGenerator } from '../lib/script-studio/generator.ts';
import type { VisionExtractionResult, VisionExtractor } from '../lib/script-studio/adapters/vision-extract.ts';
import type { EvidenceReprobe } from '../lib/script-studio/adapters/reprobe.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-runner-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, role TEXT NOT NULL, filename TEXT NOT NULL,
    path TEXT NOT NULL, originalPath TEXT, mimeType TEXT NOT NULL,
    originalWidth INTEGER, originalHeight INTEGER
  );
  INSERT INTO projects (id, name) VALUES ('p1', '项目一');
  INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss1', 'p1', '组一', '2026-08-31T00:00:00.000Z');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:00.000Z'),
});

const imagePath = path.join(root, 'detail.png');
await sharp({ create: { width: 1200, height: 2400, channels: 3, background: '#fafafa' } }).png().toFile(imagePath);
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-1', 'p1', 'input', '20260909-203732.872-2.jpg', ?, ?, 'image/png', 1200, 2400)
`).run(imagePath, imagePath);
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-2', 'p1', 'input', '20260909-203732.872-14.jpg', ?, ?, 'image/png', 1200, 2400)
`).run(imagePath, imagePath);
db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('source-1', 'p1', 'fingerprint-1', '["img-1"]', '2026-08-31T00:01:00.000Z')
`).run();
db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('source-2', 'p1', 'fingerprint-2', '["img-1","img-2"]', '2026-08-31T00:01:01.000Z')
`).run();

const visionExtractor: VisionExtractor = {
  async extract(): Promise<VisionExtractionResult> {
    return {
      productName: '测试床',
      category: '家具',
      brand: '',
      providerId: 'fake-vision',
      model: 'fake-vision-1',
      promptContractVersion: 1,
      sellingPoints: [
        {
          title: '黑色外观',
          factText: '产品外观为黑色',
          pointType: 'appearance',
          evidenceQuote: '产品外观为黑色',
          sourcePageIndex: 0,
          tileRefs: ['2'],
          modelConfidence: 'medium',
          usable: true,
        },
        {
          title: '木纹结构',
          factText: '柜体采用木纹结构',
          pointType: 'structure',
          evidenceQuote: '柜体采用木纹结构',
          sourcePageIndex: 0,
          tileRefs: ['3'],
          modelConfidence: 'high',
          usable: true,
        },
      ],
    };
  },
};

const reprobe: EvidenceReprobe = {
  kind: 'vision_closed_question',
  async verify(input) {
    return { quote: input.claim };
  },
};

let fixtureTitleIndex = 0;
function fixtureContent(input: Parameters<ScriptGenerator['generate']>[0]) {
  // 各无关测试用不同自然场景标题，避免复用同一项目时触发本次新增的近期标题门禁。
  const locations = ['窗边', '客厅', '书房', '阳台', '午后', '周末', '下班', '晨间'];
  const scenes = ['阅读时光', '放松片刻', '安静独处', '观影小憩', '亲友小聚', '喝茶闲谈', '听歌休闲', '随手布置'];
  const index = fixtureTitleIndex++;
  const title = `${locations[Math.floor(index / scenes.length) % locations.length]}${scenes[index % scenes.length]}`;
  return { ...buildDeterministicFallbackScript(input), title, coverTitleParts: { primary: title, secondary: '看看这些真实细节', source: 'model' as const } };
}

function makeGenerator(failPlan?: number): ScriptGenerator {
  return {
    async generate(input) {
      if (failPlan === input.plan.index) throw new Error('fake generation failure');
      return {
        content: fixtureContent(input),
        attempts: 1,
      };
    },
  };
}

const task = createTask(db, {
  projectId: 'p1',
  requestKey: 'first-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  requestedCount: 2,
}, () => new Date('2026-08-31T00:02:00.000Z'));

let generationInFlight = 0;
let maxGenerationInFlight = 0;
const capturedBriefs: Array<{ planIndex: number; ids: string[] }> = [];
const parallelGenerator: ScriptGenerator = {
  async generate(input) {
    generationInFlight += 1;
    maxGenerationInFlight = Math.max(maxGenerationInFlight, generationInFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    generationInFlight -= 1;
    capturedBriefs.push({
      planIndex: input.plan.index,
      ids: [...(input.brief?.requiredPointIds || []), ...(input.brief?.optionalPointIds || [])],
    });
    return { content: fixtureContent(input), attempts: 1 };
  },
};

const runDeps: ScriptStudioRunDeps = {
  db,
  projectId: 'p1',
  taskId: task.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: parallelGenerator,
  now: () => new Date('2026-08-31T00:03:00.000Z'),
};
const result = await executeScriptStudioTask(runDeps);
assert.equal(result.status, 'succeeded');
assert.equal(result.succeededCount, 2);
assert.equal(result.scriptIds.length, 2);
// 已保存首轮资产与方案后重入：不得再次识图、核验或生成。
const replayed = await executeScriptStudioTask({
  ...runDeps,
  visionExtractor: { async extract() { throw new Error('恢复不得重新识图'); } },
  reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('恢复不得重新核验'); } },
  generator: { async generate() { throw new Error('恢复不得重做已保存方案'); } },
});
assert.equal(replayed.status, 'succeeded');
assert.deepEqual(replayed.scriptIds, result.scriptIds);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions WHERE generationTaskId = ?').get(task.task.id) as { n: number }).n, 2);

assert.equal(maxGenerationInFlight, 2, '多条初稿应有界并行生成，避免纯串行累加供应商长尾');
// plan 阶段快照必须记录本轮全部方向卖点包：主题、必选/可选卖点 ID、候选数量与编排理由。
const planStageRow = db.prepare(`
  SELECT payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = 'plan'
`).get(task.task.id) as { payloadJson: string };
const planPayload = JSON.parse(planStageRow.payloadJson) as {
  briefs?: Array<{
    planIndex: number;
    templateId: string;
    themeKey: string;
    requiredPointIds: string[];
    optionalPointIds: string[];
    candidateCount: number;
    rationale: string;
  }>;
};
assert.equal(planPayload.briefs?.length, 2, 'plan 快照必须记录本轮全部方向卖点包');
for (const brief of planPayload.briefs || []) {
  assert.equal(brief.candidateCount, brief.requiredPointIds.length + brief.optionalPointIds.length);
  assert.equal(brief.candidateCount <= 8, true, '15 秒脚本每个方向最多向模型提供 8 条候选');
  assert.ok(brief.rationale.includes(brief.templateId), '编排理由必须可回看');
  assert.equal(brief.candidateCount > 0, true, '有可用卖点时卖点包不能为空');
}
// 生成器在首稿与校验重试中都只收到卖点包内的库内卖点 ID。
assert.equal(capturedBriefs.length >= 2, true);
const libraryPointIds = new Set(
  (db.prepare(`SELECT id FROM script_studio_selling_points`).all() as Array<{ id: string }>).map((row) => row.id),
);
for (const captured of capturedBriefs) {
  assert.equal(captured.ids.length > 0 && captured.ids.length <= 8, true);
  for (const id of captured.ids) {
    assert.equal(libraryPointIds.has(id), true, '卖点包只能包含库内卖点，不得引入库外 ID');
  }
}
const firstRunBriefIds = capturedBriefs.slice(0, 2).map((captured) => captured.ids.sort().join('|'));
const planBriefIds = (planPayload.briefs || []).map((brief) => [...brief.requiredPointIds, ...brief.optionalPointIds].sort().join('|'));
assert.deepEqual(firstRunBriefIds, planBriefIds, '生成使用的卖点包必须与 plan 快照一致（首稿与重试复用同一份包）');
const finalTask = getTask(db, 'p1', task.task.id)!;
assert.equal(finalTask.status, 'succeeded');
assert.equal(finalTask.succeededCount, 2);
assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n, 2);
assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM script_studio_library_revisions`).get() as { n: number }).n, 1);
assert.equal((db.prepare(`SELECT stage FROM script_studio_task_stages WHERE taskId=? AND status='succeeded'`).all(task.task.id) as Array<{ stage: string }>).length >= 7, true);

// 同一产品的两张详情页：逐页提取的身份措辞不一致（真机样本：「PC615软床框架|软床|林氏家居」
// 对「软床|床|」）不得再被跨商品保护误拦，任务必须走通。
function makeVariantIdentityExtractor(pageIdentities: VisionExtractionResult['pageIdentities']): VisionExtractor {
  return {
    async extract(): Promise<VisionExtractionResult> {
      const base = await visionExtractor.extract({ pages: [] });
      return { ...base, pageIdentities };
    },
  };
}
const variantTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'variant-identity-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:03:10.000Z'));
const variantResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: variantTask.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor: makeVariantIdentityExtractor([
    { pageIndex: 0, productName: 'PC615软床框架', category: '软床', brand: '林氏家居' },
    { pageIndex: 1, productName: '软床', category: '床', brand: '' },
  ]),
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:03:20.000Z'),
});
assert.equal(variantResult.status, 'succeeded', '同一产品多页身份措辞差异不得触发跨商品拦截');

// 真实两段来源：文件名同主干、不同编号是同组分段弱证据；“摩卡沙发”/“林氏沙发”
// 的品牌+品类泛称差异不得把已提取到的同一商品拦截。
const splitVariantTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'split-variant-identity-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-2',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:03:21.000Z'));
const splitVariantResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: splitVariantTask.task.id,
  sourceSetId: 'source-2',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor: makeVariantIdentityExtractor([
    { pageIndex: 0, productName: '摩卡沙发', category: '沙发', brand: '林氏' },
    { pageIndex: 1, productName: '林氏沙发', category: '沙发', brand: '林氏家居' },
  ]),
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:03:22.000Z'),
});
assert.equal(splitVariantResult.status, 'succeeded', '真实同主干分段文件名与泛称身份不得误拦');

// 同一文件主干不能覆盖两边都已识别出的具体系列；应在提取阶段拦截，且不写入新的卖点库/脚本。
const libraryCountBeforeConcreteConflict = (db.prepare(`
  SELECT COUNT(*) AS n FROM script_studio_library_revisions
`).get() as { n: number }).n;
const scriptCountBeforeConcreteConflict = (db.prepare(`
  SELECT COUNT(*) AS n FROM project_scripts
`).get() as { n: number }).n;
const concreteConflictTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'concrete-identity-conflict-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-2',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:03:23.000Z'));
const concreteConflictResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: concreteConflictTask.task.id,
  sourceSetId: 'source-2',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor: makeVariantIdentityExtractor([
    { pageIndex: 0, productName: '摩卡沙发', category: '沙发', brand: '林氏家居' },
    { pageIndex: 1, productName: '黑森林沙发', category: '沙发', brand: '林氏家居' },
  ]),
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:03:24.000Z'),
});
assert.equal(concreteConflictResult.status, 'failed', '同主干的两个具体系列仍须拦截');
assert.equal(concreteConflictResult.errorCode, 'invalid_input');
assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM script_studio_library_revisions`).get() as { n: number }).n, libraryCountBeforeConcreteConflict);
assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n, scriptCountBeforeConcreteConflict);

// 真混商品：两页识别出明显不同的商品名，仍必须拦截并报出各页识别结果。
const conflictTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'conflict-identity-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:03:25.000Z'));
const conflictResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: conflictTask.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor: makeVariantIdentityExtractor([
    { pageIndex: 0, productName: '林氏PC615真皮储物床', category: '软床', brand: '林氏家居' },
    { pageIndex: 1, productName: '全友科技布沙发A100', category: '沙发', brand: '全友' },
  ]),
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:03:26.000Z'),
});
assert.equal(conflictResult.status, 'failed', '真混商品仍必须被拦截');
assert.equal(conflictResult.errorCode, 'invalid_input');
assert.ok(conflictResult.errorMessage?.includes('第 1 页识别为「林氏PC615真皮储物床」'), '报错必须指出各页识别结果');
assert.ok(conflictResult.errorMessage?.includes('第 2 页识别为「全友科技布沙发A100」'), '报错必须指出各页识别结果');
const conflictStage = db.prepare(`
  SELECT status, payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = 'extract'
`).get(conflictTask.task.id) as { status: string; payloadJson: string };
const conflictPayload = JSON.parse(conflictStage.payloadJson) as {
  candidateCount?: number;
  pageIdentities?: unknown[];
  identityComparisons?: Array<{ verdict: string }>;
};
assert.equal(conflictStage.status, 'failed');
assert.equal(conflictPayload.candidateCount, 2, '跨商品拦截要保留已提取候选数');
assert.equal(conflictPayload.pageIdentities?.length, 2, '跨商品拦截要保留逐页身份诊断');
assert.equal(conflictPayload.identityComparisons?.some((item) => item.verdict === 'conflict'), true);

// F1：requestedCount=6 的复用任务也能完成 6 次生成并落 succeededCount=6。
const sixTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'six-request-1',
  mode: 'reuse',
  libraryRevisionId: (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p1'`).get() as { currentRevisionId: string }).currentRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 6, creativeBrief: '' },
  requestedCount: 6,
}, () => new Date('2026-08-31T00:03:30.000Z'));
const sixResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: sixTask.task.id,
  libraryRevisionId: (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p1'`).get() as { currentRevisionId: string }).currentRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 6, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:04:00.000Z'),
});
assert.equal(sixResult.status, 'succeeded', '6 条复用必须能完整完成');
assert.equal(sixResult.succeededCount, 6, 'runner 必须完成 6 次生成');
assert.equal(getTask(db, 'p1', sixTask.task.id)!.succeededCount, 6, '任务必须落 succeededCount=6');
const sixPlanStage = db.prepare(`SELECT payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = 'plan'`).get(sixTask.task.id) as { payloadJson: string };
const sixPlan = JSON.parse(sixPlanStage.payloadJson) as { plans?: Array<{ templateId: string; angle: string }> };
assert.equal(sixPlan.plans?.length, 6, 'plan 阶段必须规划 6 个方向');
assert.equal(new Set((sixPlan.plans || []).map((plan) => plan.templateId)).size, 6, '6 个方向必须模板各不相同');

const partialTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'partial-request-1',
  mode: 'reuse',
  libraryRevisionId: (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p1'`).get() as { currentRevisionId: string }).currentRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  requestedCount: 2,
}, () => new Date('2026-08-31T00:04:00.000Z'));
const partialResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: partialTask.task.id,
  libraryRevisionId: (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p1'`).get() as { currentRevisionId: string }).currentRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: makeGenerator(2),
  now: () => new Date('2026-08-31T00:05:00.000Z'),
});
assert.equal(partialResult.status, 'partial');
assert.equal(partialResult.succeededCount, 1);
assert.equal(partialResult.failedCount, 1);
assert.equal(getTask(db, 'p1', partialTask.task.id)!.status, 'partial');

const staleTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'stale-request-1',
  mode: 'reuse',
  libraryRevisionId: (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p1'`).get() as { currentRevisionId: string }).currentRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:06:00.000Z'));
updateTask(db, 'p1', staleTask.task.id, { status: 'running', leaseUntil: '2026-08-30T00:00:00.000Z' }, () => new Date('2026-08-31T00:06:01.000Z'));
assert.equal(recoverInterruptedTasks(db, () => new Date('2026-08-31T00:06:02.000Z')), 1);
assert.equal(getTask(db, 'p1', staleTask.task.id)!.status, 'queued');

// 手动停止：带取消标记的中断落库为 cancelled（区别于停机恢复的 queued），不会再被领取。
const cancelTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'cancel-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:10:00.000Z'));
const cancelController = new AbortController();
assert.equal(requestScriptStudioTaskCancel(cancelTask.task.id), false, '未运行的任务没有可中断的控制器');
const cancelResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: cancelTask.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: {
    async generate() {
      cancelController.abort();
      throw new DOMException('已取消', 'AbortError');
    },
  },
  signal: cancelController.signal,
  now: () => new Date('2026-08-31T00:11:00.000Z'),
});
assert.equal(cancelResult.errorCode, 'cancelled');
assert.equal(getTask(db, 'p1', cancelTask.task.id)!.status, 'cancelled');
assert.equal(getTask(db, 'p1', cancelTask.task.id)!.leaseUntil, null);

// 提取阶段抛错：任务失败且 running 阶段行补写为 failed（过程页不能停在「进行中」）。
const failTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'fail-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:12:00.000Z'));
const failResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: failTask.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor: {
    async extract() { throw new Error('fake 返回了无效 JSON'); },
  },
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:13:00.000Z'),
});
assert.equal(failResult.status, 'failed');
assert.equal(getTask(db, 'p1', failTask.task.id)!.status, 'failed');
const failedStageRow = db.prepare(`SELECT status FROM script_studio_task_stages WHERE taskId = ? AND stage = 'extract'`).get(failTask.task.id) as { status: string };
assert.equal(failedStageRow.status, 'failed', '失败任务的中断阶段行必须落库为 failed');

// Next.js 会把 instrumentation 和 API route 编译成不同模块实例。
// 取消必须通过 globalThis 上真正运行的调度器转发，不能只查当前 bundle 的模块内 Map。
const globalScope = globalThis as Record<PropertyKey, unknown>;
const previousScheduler = globalScope[SCRIPT_STUDIO_SCHEDULER_KEY];
let forwardedTaskId = '';
globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] = {
  async stop() {},
  async runPendingOnce() { return 0; },
  requestCancel(taskId: string) {
    forwardedTaskId = taskId;
    return true;
  },
} satisfies ScriptStudioSchedulerController;
assert.equal(requestScriptStudioTaskCancel('cross-bundle-running-task'), true);
assert.equal(forwardedTaskId, 'cross-bundle-running-task', '取消必须转发给全局调度器实例');
if (previousScheduler === undefined) delete globalScope[SCRIPT_STUDIO_SCHEDULER_KEY];
else globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] = previousScheduler;

// 证据定位配对：跨页合并的卖点，每条引用回到自己的页面与切片。
function fakeTile(pageIndex: number, tileIndex: number, key: string): TileSetResult['pages'][number]['tiles'][number] {
  return { pageIndex, tileIndex, width: 100, height: 100, mimeType: 'image/jpeg', imageBase64: key };
}
const tileSet: TileSetResult = {
  pages: [
    {
      pageIndex: 0, imageAssetId: 'img-a', filename: 'a.png', sourceWidth: 100, sourceHeight: 100, degraded: false,
      tiles: [fakeTile(0, 0, 'p0-t1'), fakeTile(0, 1, 'p0-t2'), fakeTile(0, 2, 'p0-t3')],
    },
    {
      pageIndex: 1, imageAssetId: 'img-b', filename: 'b.png', sourceWidth: 100, sourceHeight: 100, degraded: false,
      tiles: [fakeTile(1, 0, 'p1-t1'), fakeTile(1, 1, 'p1-t2')],
    },
  ],
  totalTiles: 5,
  maxImagesPerRequest: 50,
  degraded: false,
};
const crossPageTiles = evidenceTilesForPoint({
  evidenceRefs: [{ pageIndex: 0, tileRef: 'tile_2' }, { pageIndex: 1, tileRef: 'tile_1' }],
}, tileSet);
assert.equal(crossPageTiles.some((tile) => tile.imageBase64 === 'p0-t2'), true, '第一条引用必须定位到第 0 页 tile_2');
assert.equal(crossPageTiles.some((tile) => tile.imageBase64 === 'p1-t1'), true, '第二条引用必须定位到第 1 页 tile_1');
assert.equal(crossPageTiles.every((tile) => !tile.imageBase64.startsWith('p1-t') || tile.imageBase64 === 'p1-t1' || tile.imageBase64 === 'p1-t2'), true);
// 旧结构输入按同一页合成配对，行为与此前一致。
const legacyTiles = evidenceTilesForPoint({ sourcePageIndex: 1, tileRefs: ['tile_2'] }, tileSet);
assert.equal(legacyTiles.some((tile) => tile.imageBase64 === 'p1-t2'), true);

// 二次核验单点图预算硬生效：6 条引用各自带相邻片时不得膨胀到 18 图。
const bigTileSet: TileSetResult = {
  pages: [{
    pageIndex: 0, imageAssetId: 'img-c', filename: 'c.png', sourceWidth: 100, sourceHeight: 100, degraded: false,
    tiles: Array.from({ length: 18 }, (_, index) => fakeTile(0, index, `big-t${index + 1}`)),
  }],
  totalTiles: 18,
  maxImagesPerRequest: 50,
  degraded: false,
};
const sixRefs = {
  evidenceRefs: [1, 4, 7, 10, 13, 16].map((tileNumber) => ({ pageIndex: 0, tileRef: `tile_${tileNumber}` })),
};
const capped = evidenceTilesForPoint(sixRefs, bigTileSet, 6);
assert.equal(capped.length <= 6, true, `单条卖点不得突破 6 图预算（实际 ${capped.length}）`);
assert.deepEqual(
  capped.map((tile) => tile.imageBase64),
  ['big-t1', 'big-t4', 'big-t7', 'big-t10', 'big-t13', 'big-t16'],
  '预算耗尽前必须优先保留全部精确切片',
);
const expanded = evidenceTilesForPoint({ evidenceRefs: [{ pageIndex: 0, tileRef: 'tile_3' }] }, bigTileSet, 6);
assert.deepEqual(
  expanded.map((tile) => tile.imageBase64),
  ['big-t3', 'big-t2', 'big-t4'],
  '引用较少时精确片在前、相邻片在后',
);

// 证据边界 fail closed：卖点库全部不可用时任务明确失败（可用证据不足），不得产出零引用脚本。
const currentBeforeLock = getCurrentLibraryRevision(db, 'p1')!;
manualEditLibraryRevision(db, 'p1', currentBeforeLock.sellingPoints.map((point) => ({
  sellingPointId: point.id,
  usable: false,
  disabledByUser: true,
})), { now: () => new Date('2026-08-31T00:14:00.000Z') });
assert.throws(() => manualEditLibraryRevision(db, 'p1', [], { baseRevisionId: currentBeforeLock.id }), /卖点列表已更新/, '旧版选择不能覆盖新版卖点库');
const lockedRevisionId = getCurrentLibraryRevision(db, 'p1')!.id;
const scriptCountBefore = (db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n;
const insufficientTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'insufficient-request-1',
  mode: 'reuse',
  libraryRevisionId: lockedRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  requestedCount: 2,
}, () => new Date('2026-08-31T00:15:00.000Z'));
const insufficientResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: insufficientTask.task.id,
  libraryRevisionId: lockedRevisionId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:16:00.000Z'),
});
assert.equal(insufficientResult.status, 'failed');
assert.equal(insufficientResult.errorCode, 'evidence_insufficient');
const insufficientFinal = getTask(db, 'p1', insufficientTask.task.id)!;
assert.equal(insufficientFinal.status, 'failed');
assert.ok(insufficientFinal.errorMessage?.includes('可用证据不足'), '失败原因必须明确为可用证据不足');
const insufficientPlanStage = db.prepare(`
  SELECT status FROM script_studio_task_stages WHERE taskId = ? AND stage = 'plan'
`).get(insufficientTask.task.id) as { status: string };
assert.equal(insufficientPlanStage.status, 'failed', 'plan 阶段必须落库为失败');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n,
  scriptCountBefore,
  '可用证据不足时不得创建任何脚本（包括零引用脚本）',
);

// 复用历史卖点库时 runner 必须把来源页数传给本地结构重验，不能让 pageIndex=999 继续生成。
// 快方案必须在慢方案仍运行时落库；中断恢复不重做已保存方向。
{
  const inputSnapshot = { targetDurationSec: 15, requestedCount: 2 };
  const streamingTask = createTask(db, {
    projectId: 'p1', requestKey: 'stream-ready-before-slow', mode: 'reuse',
    libraryRevisionId: currentBeforeLock.id, requestedCount: 2, inputSnapshot,
  }).task;
  updateTask(db, 'p1', streamingTask.id, { status: 'running' });
  const controller = new AbortController();
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const streamingDeps: ScriptStudioRunDeps = {
    db, projectId: 'p1', taskId: streamingTask.id, inputSnapshot,
    libraryRevisionId: currentBeforeLock.id, visionExtractor, reprobe,
    signal: controller.signal,
    generator: {
      async generate(input) {
        if (input.plan.index === 1) {
          await slow;
          throw new DOMException('stopped slow proposal', 'AbortError');
        }
        return { content: fixtureContent(input), attempts: 1 };
      },
    },
  };
  const running = executeScriptStudioTask(streamingDeps);
  const savedCount = () => (db.prepare(
    'SELECT COUNT(*) AS n FROM project_script_revisions WHERE generationTaskId = ?',
  ).get(streamingTask.id) as { n: number }).n;
  const deadline = Date.now() + 500;
  while (savedCount() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const savedWhileSlow = savedCount();
  const liveCount = getTask(db, 'p1', streamingTask.id)!.succeededCount;
  controller.abort();
  releaseSlow();
  await running;
  assert.equal(savedWhileSlow, 1, '快方案应在慢方案未完成时保存，不能等待整组 Promise.all');
  assert.equal(liveCount, 1, '运行中成功数应立即更新，供前端加载结果');
  const resumedPlans: number[] = [];
  const resumed = await executeScriptStudioTask({
    ...streamingDeps, signal: undefined,
    generator: { async generate(input) {
      resumedPlans.push(input.plan.index);
      throw new Error('missing proposal still fails');
    } },
  });
  assert.deepEqual(resumedPlans, [1], '恢复时只执行尚未保存的方向');
  assert.equal(resumed.succeededCount, 1);
  assert.equal(resumed.status, 'partial');
  assert.equal(savedCount(), 1, '恢复不能产生重复版本');
}

const invalidHistoricalRevision = createLibraryRevision(db, {
  projectId: 'p1',
  sourceSetId: 'source-1',
  sourceFingerprint: 'fingerprint-1',
  productName: '测试床',
  category: '家具',
  extractProviderId: 'legacy-provider',
  extractModel: 'legacy-model',
  promptContractVersion: 2,
  origin: 'extraction',
  sellingPoints: [{
    title: '历史黑色外观',
    factText: '产品外观为黑色',
    pointType: 'appearance',
    evidenceQuote: '产品外观为黑色',
    evidenceRefs: [{ pageIndex: 999, tileRef: 'tile_1' }],
    evidenceGate: 'skipped',
    usable: true,
  }],
}, () => new Date('2026-08-31T00:17:00.000Z'));
const invalidHistoricalTask = createTask(db, {
  projectId: 'p1',
  requestKey: 'invalid-historical-location-1',
  mode: 'reuse',
  libraryRevisionId: invalidHistoricalRevision.id,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  requestedCount: 1,
}, () => new Date('2026-08-31T00:18:00.000Z'));
const invalidHistoricalResult = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: invalidHistoricalTask.task.id,
  libraryRevisionId: invalidHistoricalRevision.id,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '' },
  visionExtractor,
  reprobe,
  generator: makeGenerator(),
  now: () => new Date('2026-08-31T00:19:00.000Z'),
});
assert.equal(invalidHistoricalResult.status, 'failed');
assert.equal(
  invalidHistoricalResult.errorCode,
  'evidence_insufficient',
  '历史页码越界卖点必须在复用 plan 阶段失败关闭',
);

db.close();
console.log('script-studio-runner.test.ts: ok');
