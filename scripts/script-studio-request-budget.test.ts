/**
 * P0 请求预算与修复边界回归（方案 §2.2 / 验收 A8 / A9）：
 * - 每条方案文本 completeJson 调用不超过上限（默认 8），标题修复单独 2 次闸门；
 * - 任务总额 requestedCount × 每方案上限，持久化计数，任务恢复（新预算实例）不重置余额；
 * - 并发方案计数隔离；预算耗尽后不发新请求、不保存失败方案；
 * - 修复响应携带方向包外 ID 不能通过「删除坏 ID」伪装合格（本地引用检查 fail closed）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createLibraryRevision } from '../lib/script-studio/libraries.ts';
import { createTask, getTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask } from '../lib/script-studio/runner.ts';
import {
  applyScriptBodyRepair,
  briefCandidatePoints,
  createScriptGenerator,
  normalizeGeneratedScript,
  type ScriptBodyRepairInput,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';
import { createScriptRequestBudget } from '../lib/script-studio/request-budget.ts';
import { getScriptStudioLimits } from '../lib/script-studio/limits.ts';
import { ScriptStudioError } from '../lib/script-studio/errors.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-request-budget-'));
const now = () => new Date('2026-09-14T10:00:00.000Z');
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE shot_sets(id TEXT PRIMARY KEY, projectId TEXT); INSERT INTO projects VALUES ('p1','测试');`);
await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now });
db.prepare(`INSERT INTO script_studio_source_sets (id,projectId,contentFingerprint,imageAssetIdsJson,createdAt) VALUES ('src','p1','fp','["image-a"]',?)`).run(now().toISOString());
const library = createLibraryRevision(db, {
  projectId: 'p1', sourceSetId: 'src', sourceFingerprint: 'fp', productName: '休闲沙发', category: '沙发', brand: '',
  sellingPoints: [
    { title: '高靠背', themeTitle: '躺靠支撑', factText: '高靠背托住头颈。', evidenceQuote: '高靠背托住头颈', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'] },
    { title: '柔软扶手', themeTitle: '躺靠支撑', factText: '扶手包覆柔软面料。', evidenceQuote: '扶手包覆柔软面料', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_2'] },
  ],
}, now);

function makeBudgetTask(requestedCount: number): string {
  return createTask(db, {
    projectId: 'p1',
    requestKey: `budget-${requestedCount}-${Math.random().toString(36).slice(2, 8)}`,
    mode: 'reuse',
    libraryRevisionId: library.id,
    requestedCount,
    inputSnapshot: { targetDurationSec: 15, requestedCount },
  }, now).task.id;
}

// ── 单元：三级闸门与恢复延续 ────────────────────────────────────────
{
  const limits = getScriptStudioLimits();
  assert.equal(limits.scriptTextRequestsPerProposal, 8, '默认每方案 8 次文本请求');
  // 任务 A（requestedCount=2 → 任务总额 16）：方案级闸门 + 并发隔离。
  const taskId = makeBudgetTask(2);
  const budget = createScriptRequestBudget({ db, taskId, requestedCount: 2, now });
  for (let i = 0; i < 8; i += 1) budget.reserve({ planIndex: 1, purpose: 'generate' });
  assert.equal(budget.usedFor(1), 8);
  assert.throws(() => budget.reserve({ planIndex: 1, purpose: 'generate' }), /方案 1 的脚本文本请求预算已耗尽/);
  // 并发方案计数隔离：方案 2 有自己独立的 8 次（A8：并发 2 路隔离）。
  assert.equal(budget.usedFor(2), 0);
  for (let i = 0; i < 8; i += 1) budget.reserve({ planIndex: 2, purpose: 'generate' });
  assert.equal(budget.usedFor(2), 8);
  assert.equal(budget.taskTextUsed(), 16, '方案级隔离，任务级如实累计');
  // 任务级闸门：总额 16 耗尽后，任何方案都不得再发起新请求。
  assert.throws(
    () => budget.reserve({ planIndex: 3, purpose: 'generate' }),
    /本任务的脚本文本请求预算已耗尽（上限 16 次）/,
    '任务总额 requestedCount×每方案上限 耗尽后不得发起新请求',
  );
  // 任务恢复（新预算实例 = 新进程领取同一任务）：余额延续，不重置（A8）。
  const recovered = createScriptRequestBudget({ db, taskId, requestedCount: 2, now });
  assert.equal(recovered.taskTextUsed(), 16, '恢复后任务级计数延续');
  assert.equal(recovered.usedFor(1), 8, '恢复后方案级计数延续');
  assert.throws(() => recovered.reserve({ planIndex: 1, purpose: 'generate' }), /预算已耗尽/);
  // 任务 B（requestedCount=1 → 任务总额 8）：单方案任务的任务级闸门。
  const cappedTaskId = makeBudgetTask(1);
  const cappedBudget = createScriptRequestBudget({ db, taskId: cappedTaskId, requestedCount: 1, now });
  for (let i = 0; i < 8; i += 1) cappedBudget.reserve({ planIndex: 1, purpose: 'generate' });
  assert.throws(
    () => cappedBudget.reserve({ planIndex: 2, purpose: 'generate' }),
    /本任务的脚本文本请求预算已耗尽（上限 8 次）/,
    '任务总额耗尽后，其他方案也不得发起新请求',
  );
  const recoveredB = createScriptRequestBudget({ db, taskId: cappedTaskId, requestedCount: 1, now });
  assert.equal(recoveredB.taskTextUsed(), 8, '恢复后任务级计数延续（单方案任务）');
}

// ── 单元：标题修复单独 2 次闸门，且占用方案余额 ─────────────────────
{
  const taskId = makeBudgetTask(2);
  const budget = createScriptRequestBudget({ db, taskId, requestedCount: 2, now });
  budget.reserve({ planIndex: 1, purpose: 'title_repair' });
  budget.reserve({ planIndex: 1, purpose: 'title_repair' });
  assert.equal(budget.titleRepairUsedFor(1), 2);
  assert.throws(() => budget.reserve({ planIndex: 1, purpose: 'title_repair' }), /标题修复请求已达上限（2 次）/);
  assert.equal(budget.usedFor(1), 2, '标题修复占用方案共用余额');
  budget.reserve({ planIndex: 1, purpose: 'generate' });
  assert.equal(budget.usedFor(1), 3);
}

// ── 单元（A9）：修复响应携带包外 ID → 本地引用检查 fail closed ──────
{
  const input: ScriptGeneratorInput = {
    libraryRevision: library,
    plan: { index: 1, templateId: 'pain_point', templateName: '直击痛点', templateVersion: 1, angle: '先讲痛点再给证据', direction: 'pain_point', rationale: '测试' },
    brief: { planIndex: 1, templateId: 'pain_point', themeKey: 't', themeTitle: '躺靠支撑', requiredPointIds: library.sellingPoints.map((point) => point.id), optionalPointIds: [], candidateCount: 2, degraded: false, rationale: '测试' },
    audience: '家居人群', platform: '通用', tone: '自然', creativeBrief: '', targetDurationSec: 15, previousScripts: [],
  };
  const primary = library.sellingPoints[0]!;
  const content = normalizeGeneratedScript({
    title: '预算边界测试方案',
    coverTitleParts: { primary: '高靠背沙发', secondary: '靠背支撑体验' },
    direction: '先讲痛点再给证据',
    segments: [{ narration: '高靠背托住头颈，躺靠放松。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] }],
  }, input);
  // 包外 ID（其他修订/项目/库内但方向包外）不得通过「删除坏 ID」伪装合格。
  assert.throws(
    () => applyScriptBodyRepair({
      segments: [{ narration: '正文保留。', sellingPointIdRefs: [primary.id, 'other-revision-point'], visualIntent: '', visualKeywords: ['靠背'] }],
    }, content, input),
    /generated_script_out_of_package_ref:other-revision-point/,
    '修复响应的包外引用必须整体失败，不得静默过滤后保留口播',
  );
  // 合法修复照常应用且派生字段由服务端重算。
  const repaired = applyScriptBodyRepair({
    segments: [
      { narration: '高靠背托住头颈，躺靠放松。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
      { narration: '想了解这款沙发，就点开看看。', sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
    ],
  }, content, input);
  assert.equal(repaired.segments.length, 2);
  assert.equal(repaired.title, content.title, '标题保持冻结');
  assert.equal(repaired.targetDurationSec, content.targetDurationSec, '目标时长保持冻结');
  assert.ok(repaired.contentCharacterCount > 0 && repaired.fullScript.includes('想了解这款'));
}

// ── 集成：预算耗尽后不发新请求、不保存失败方案（A8）────────────────
{
  // 上限降到 1：首稿消耗余额，下一次修复在调用前被拒绝。
  process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_TEXT_REQUESTS_PER_PROPOSAL = '1';
  try {
    const taskId = makeBudgetTask(1);
    const budget = createScriptRequestBudget({ db, taskId, requestedCount: 1, now });
    let completeCalls = 0;
    let planAnalysisCalls = 0;
    const generator = createScriptGenerator(async (request) => {
      const task = JSON.parse(request.userPrompt).task as string;
      if (task === 'analyze_audience_profile_v1') {
        // 受众画像走 plan_analysis 独立阶段额度，不占脚本文本预算；返回不可用响应走降级画像。
        planAnalysisCalls += 1;
        return null;
      }
      completeCalls += 1;
      const primary = library.sellingPoints[0]!;
      if (task === 'generate_project_script_v1') {
        // 一直返回孤立标签收尾：正文机械校验可通过，但结尾质量不合格。
        return {
          title: '预算耗尽的失败方案',
          coverTitleParts: { primary: '高靠背沙发', secondary: '靠背支撑体验' },
          direction: '先讲痛点再给证据',
          segments: [
            { narration: '高靠背托住头颈，腰托贴合腰背，软弹座包坐着也舒服。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
            { narration: `${primary.title}。`, sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['外观'] },
          ],
        };
      }
      // 修复响应仍以孤立标签收尾：修复不成功。
      return {
        segments: [
          { narration: '高靠背托住头颈，腰托贴合腰背。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
          { narration: `${primary.title}。`, sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['外观'] },
        ],
      };
    }, { id: 'fake', model: 'fake' }, { budget });

    const inputSnapshot = { targetDurationSec: 15, requestedCount: 1 };
    const result = await executeScriptStudioTask({
      db, projectId: 'p1', taskId, libraryRevisionId: library.id, inputSnapshot, generator, now,
      visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
      reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
    });
    assert.equal(result.status, 'failed', '预算耗尽后方案必须失败');
    assert.equal(completeCalls, 1, '只发起首稿请求，修复预留被拒后不得发起调用');
    assert.equal(planAnalysisCalls, 1, '受众画像分析走独立阶段额度，只调用一次且不占文本预算');
    const task = getTask(db, 'p1', taskId)!;
    assert.match(task.errorMessage || '', /预算已耗尽/, '失败原因必须指向请求预算');
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n,
      0,
      '预算耗尽的失败方案不得保存',
    );
    assert.equal(budget.usedFor(1), 1, '方案级计数如实记录 1 次');
    assert.equal(budget.taskTextUsed(), 1, '任务级计数如实记录 1 次');
  } finally {
    delete process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_TEXT_REQUESTS_PER_PROPOSAL;
  }
}

// ── 集成（A9）：修复响应包外 ID → 失败关闭，不循环整篇重写 ──
{
  const taskId = makeBudgetTask(1);
  let generateCalls = 0;
  let repairCalls = 0;
  const generator = {
    async generate(input: ScriptGeneratorInput) {
      generateCalls += 1;
      const primary = briefCandidatePoints(input)[0]!;
      const segments = generateCalls === 1
        ? [
            { narration: '高靠背托住头颈，腰托贴合腰背，软弹座包坐着也舒服。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
            { narration: `${primary.title}。`, sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['外观'] },
          ]
        : [
            { narration: '高靠背托住头颈，腰托贴合腰背，软弹座包坐着也舒服。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
            { narration: '想给家里添个放松的位置，就从这款沙发开始了解。', sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
          ];
      return {
        content: normalizeGeneratedScript({
          title: '包外引用修复边界',
          coverTitleParts: { primary: '柔软扶手', secondary: '扶手包裹体验' },
          direction: '先讲痛点再给证据',
          segments,
        }, input),
        attempts: 1,
      };
    },
    async repairScriptContent(input: ScriptBodyRepairInput) {
      repairCalls += 1;
      const primary = briefCandidatePoints(input)[0]!;
      // 恶意修复：混入方向包外 ID，试图「删除坏 ID」后保留口播伪装合格。
      return {
        segments: [
          { narration: '高靠背托住头颈，腰托贴合腰背。', sellingPointIdRefs: [primary.id, 'foreign-point-id'], visualIntent: '', visualKeywords: ['靠背'] },
          { narration: '想了解这款沙发，就点开看看。', sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
        ],
      };
    },
  };
  const inputSnapshot = { targetDurationSec: 15, requestedCount: 1 };
  const result = await executeScriptStudioTask({
    db, projectId: 'p1', taskId, libraryRevisionId: library.id, inputSnapshot, generator, now,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
    reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  assert.equal(result.status, 'failed', '包外引用修复失败后不得保存或自动整篇重写');
  assert.equal(repairCalls, 1, '携带包外 ID 的修复只被调用一次');
  assert.equal(generateCalls, 1, '修复失败应保留原因交给补跑');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions WHERE generationTaskId = ?').get(taskId) as { n: number }).n, 0);

}

// ScriptStudioError 语义守卫：预算错误使用专用错误码，任务级处理不会伪装成其他失败。
{
  const error = new ScriptStudioError('request_budget_exhausted', '测试');
  assert.equal(error instanceof ScriptStudioError, true);
  assert.equal(error.code, 'request_budget_exhausted');
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('script-studio-request-budget.test.ts: ok (A8, A9)');
