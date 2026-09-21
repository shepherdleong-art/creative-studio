/**
 * 受众画像（audience-profile-v1）回归：
 * - 解析：合法响应通过；主画像缺失整体不可用；幻觉卖点 ID 剔除；planIndex 去重/白名单；
 * - 降级：模型不可用时本地推导非空画像，perPlan 覆盖全部方向；
 * - 编排：画像点选卖点 ID 与关键词命中提升方向卖点包排序；
 * - runner：画像写入 plan 阶段快照并随指纹复用；分析失败降级不阻塞任务；
 *   prompt 携带 audienceProfile 块与反堆砌约束；
 * - 预算：plan_analysis 独立阶段上限（默认 2 次）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createLibraryRevision } from '../lib/script-studio/libraries.ts';
import { createTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask } from '../lib/script-studio/runner.ts';
import {
  AUDIENCE_PROFILE_VERSION,
  audienceProfileFingerprint,
  buildAudienceAnalysisPrompt,
  deriveFallbackAudienceProfile,
  parseAudienceProfile,
  readAudienceProfileFromStagePayload,
  serializeAudienceProfile,
} from '../lib/script-studio/audience-profile.ts';
import { planDirectionBriefs } from '../lib/script-studio/direction-briefs.ts';
import { planScriptDirections } from '../lib/script-studio/planner.ts';
import { reservePlanAnalysisRequest } from '../lib/script-studio/request-budget.ts';
import { briefCandidatePoints, buildScriptPrompt, normalizeGeneratedScript, type ScriptGenerator } from '../lib/script-studio/generator.ts';

// ── 夹具 ────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-audience-'));
const now = () => new Date('2026-09-15T09:00:00.000Z');
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE shot_sets(id TEXT PRIMARY KEY, projectId TEXT); INSERT INTO projects VALUES ('p1','测试');`);
await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now });
db.prepare(`INSERT INTO script_studio_source_sets (id,projectId,contentFingerprint,imageAssetIdsJson,createdAt) VALUES ('src','p1','fp','["image-a"]',?)`).run(now().toISOString());
const library = createLibraryRevision(db, {
  projectId: 'p1', sourceSetId: 'src', sourceFingerprint: 'fp', productName: '实木伸缩餐桌', category: '餐桌', brand: '',
  sellingPoints: [
    { title: '伸缩折叠设计', themeTitle: '小户型适配', factText: '桌面可伸缩折叠，四人位展开坐六人。', evidenceQuote: '桌面可伸缩折叠', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'], hierarchyRole: 'primary', importance: 5 },
    { title: '实木圆角打磨', themeTitle: '安全细节', factText: '桌角圆润打磨，有小孩也不担心磕碰。', evidenceQuote: '圆角打磨', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_2'], hierarchyRole: 'supporting', importance: 3 },
    { title: '小户型餐厅', themeTitle: '使用场景', factText: '适合小户型餐厅日常用餐。', evidenceQuote: '适合小户型餐厅', pointType: 'scenario', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_3'], hierarchyRole: 'supporting', importance: 2 },
    { title: 'FAS 级白蜡木', themeTitle: '材质用料', factText: 'FAS 级白蜡木桌面，木纹清晰。', evidenceQuote: 'FAS 级白蜡木', pointType: 'material', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_4'], hierarchyRole: 'supporting', importance: 2 },
  ],
}, now);
const plans = planScriptDirections(library, 2, '').plans;
const sellingPointIds = library.sellingPoints.map((point) => point.id);

// ── 单元：解析 ──────────────────────────────────────────────────────
const VALID_RAW = {
  primary: {
    segment: '25-35 岁小户型首购家庭',
    scenario: '小餐厅日常三人用餐，偶尔父母来吃饭',
    pains: ['餐厅小放不下大餐桌', '孩子跑闹怕磕碰桌角'],
    decisionDrivers: ['占地小但能伸缩', '边角安全'],
    rejections: ['夸大承重承诺'],
  },
  perPlan: [
    { planIndex: 1, segment: '小户型两口之家', scenario: '日常两人用餐', pains: ['占地大'], decisionDrivers: ['伸缩'], rejections: [], relatedSellingPointIds: [sellingPointIds[0], 'hallucinated-id'] },
    { planIndex: 2, segment: '有娃家庭', scenario: '孩子写作业兼用餐', pains: ['磕碰'], decisionDrivers: ['圆角'], rejections: [], relatedSellingPointIds: [sellingPointIds[1]] },
    { planIndex: 2, segment: '重复方向应去重', scenario: '重复', pains: [], decisionDrivers: [], rejections: [], relatedSellingPointIds: [] },
    { planIndex: 99, segment: '不存在的方向', scenario: '无效', pains: [], decisionDrivers: [], rejections: [], relatedSellingPointIds: [] },
  ],
};
{
  const parsed = parseAudienceProfile(VALID_RAW, { plans, sellingPointIds })!;
  assert.ok(parsed, '合法响应必须可解析');
  assert.equal(parsed.primary.segment, '25-35 岁小户型首购家庭');
  assert.equal(parsed.perPlan.length, 2, '重复 planIndex 去重且不存在的方向剔除');
  assert.deepEqual(parsed.perPlan[0]!.relatedSellingPointIds, [sellingPointIds[0]], '幻觉卖点 ID 被剔除');
}
assert.equal(parseAudienceProfile({ perPlan: [] }, { plans, sellingPointIds }), null, '缺主画像整体不可用');
assert.equal(parseAudienceProfile('garbage', { plans, sellingPointIds }), null, '非对象响应不可用');

// ── 单元：本地降级推导 ──────────────────────────────────────────────
{
  const fallback = deriveFallbackAudienceProfile({
    libraryRevision: library,
    plans,
    creativeBrief: '',
    targetDurationSec: 15,
    audienceLabel: '关注餐桌并正在做购买决策的人群',
    reason: '测试降级',
  });
  assert.equal(fallback.degraded, true);
  assert.equal(fallback.degradedReason, '测试降级');
  assert.ok(fallback.primary.segment.length > 0 && fallback.primary.scenario.length > 0, '降级主画像非空');
  assert.equal(fallback.perPlan.length, plans.length, '降级画像覆盖全部方向');
  assert.deepEqual(fallback.perPlan[0]!.relatedSellingPointIds, [], '降级画像不点选卖点 ID');
  assert.equal(fallback.version, AUDIENCE_PROFILE_VERSION);
}

// ── 单元：快照往返（指纹匹配复用 / 不匹配丢弃）────────────────────────
{
  const fallback = deriveFallbackAudienceProfile({
    libraryRevision: library, plans, creativeBrief: '', targetDurationSec: 15,
    audienceLabel: '测试标签', reason: 'round-trip',
  });
  const payload = { audienceProfile: serializeAudienceProfile(fallback) };
  const restored = readAudienceProfileFromStagePayload(payload, fallback.fingerprint)!;
  assert.ok(restored, '指纹匹配时必须恢复画像');
  assert.equal(restored.primary.segment, fallback.primary.segment);
  assert.equal(restored.perPlan.length, plans.length);
  assert.equal(restored.degraded, true);
  assert.equal(readAudienceProfileFromStagePayload(payload, 'other-fingerprint'), null, '指纹不匹配视为无缓存');
  assert.equal(readAudienceProfileFromStagePayload({}, fallback.fingerprint), null, '无画像字段视为无缓存');
}

// ── 单元：编排受众信号 ──────────────────────────────────────────────
{
  const noSignal = planDirectionBriefs({ sellingPoints: library.sellingPoints, plans, targetDurationSec: 15 });
  const signal = new Map([[1, {
    relatedSellingPointIds: [sellingPointIds[3]!], // FAS 级白蜡木：material 类型，默认排序靠后
    keywords: ['白蜡木'],
  }]]);
  const withSignal = planDirectionBriefs({ sellingPoints: library.sellingPoints, plans, targetDurationSec: 15, audienceSignals: signal });
  const basePlan1 = noSignal.find((brief) => brief.planIndex === 1)!;
  const boostedPlan1 = withSignal.find((brief) => brief.planIndex === 1)!;
  assert.ok(!basePlan1.requiredPointIds.includes(sellingPointIds[3]!), '无信号时材质卖点不在 plan1 必选');
  assert.ok(boostedPlan1.requiredPointIds.includes(sellingPointIds[3]!), '画像点选 + 关键词命中后进入 plan1 必选');
}

// ── 场景：runner 集成（模型画像 → 快照/prompt；失败降级；不重复调用）────
const CTA_LINE = '想给餐厅留个宽敞的位置，就从这款餐桌开始了解。';
function okContent(primaryId: string, primaryTitle: string, variant = '') {
  return {
    title: `小餐厅的伸缩自由${variant}`,
    coverTitleParts: { primary: '伸缩餐桌', secondary: `小户型餐厅${variant}` },
    direction: '先讲痛点再给证据',
    segments: [
      { narration: `小餐厅摆张大桌子，转身都费劲${variant}。`, sellingPointIdRefs: [], visualIntent: '小餐厅', visualKeywords: ['餐厅'] },
      { narration: `${primaryTitle}，四人位展开能坐六人。`, sellingPointIdRefs: [primaryId], visualIntent: '伸缩展示', visualKeywords: ['伸缩'] },
      { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['餐桌'] },
    ],
  };
}
async function runAudienceScenario(generator: ScriptGenerator, requestKey: string) {
  const task = createTask(db, {
    projectId: 'p1', requestKey, mode: 'reuse', libraryRevisionId: library.id, requestedCount: 1,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
  }, now).task;
  const result = await executeScriptStudioTask({
    db, projectId: 'p1', taskId: task.id, libraryRevisionId: library.id,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
    generator, now,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
    reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  const planStage = db.prepare(`SELECT payloadJson, status FROM script_studio_task_stages WHERE taskId = ? AND stage = 'plan'`)
    .get(task.id) as { payloadJson: string; status: string };
  return { result, taskId: task.id, planPayload: JSON.parse(planStage.payloadJson) as Record<string, unknown> };
}

// (a) 模型画像成功：快照含画像，生成 prompt 带画像块与反堆砌约束，相关卖点进必选
{
  let analyzeCalls = 0;
  let capturedPrompt: Record<string, unknown> | null = null;
  const { result, planPayload } = await runAudienceScenario({
    async generate(input) {
      const prompt = buildScriptPrompt(input);
      capturedPrompt = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
      const primary = briefCandidatePoints(input)[0]!;
      return { content: normalizeGeneratedScript(okContent(primary.id, primary.title), input), attempts: 1 };
    },
    async analyzeAudienceProfile(input) {
      analyzeCalls += 1;
      // 提示词必须携带卖点与方向清单，且明确禁止空泛标签。
      const prompt = JSON.parse(buildAudienceAnalysisPrompt(input).userPrompt) as { requirements: string[]; sellingPoints: unknown[]; plans: unknown[] };
      assert.ok(prompt.sellingPoints.length >= 4 && prompt.plans.length >= 1, '画像提示词必须携带卖点与方向');
      assert.ok(prompt.requirements.some((item) => item.includes('空泛标签')), '提示词必须禁止空泛标签');
      return VALID_RAW;
    },
  }, 'audience-model-ok');
  assert.equal(result.status, 'succeeded', '模型画像下任务必须成功');
  assert.equal(analyzeCalls, 1, '画像分析只调用一次');
  const profile = planPayload.audienceProfile as { degraded: boolean; summary: string; fingerprint: string; perPlan: unknown[] };
  assert.equal(profile.degraded, false, '模型画像非降级');
  assert.ok(profile.summary.includes('25-35'), '快照含主画像摘要');
  const expectedFingerprint = audienceProfileFingerprint({
    libraryRevisionId: library.id, plans: planScriptDirections(library, 1, '').plans, creativeBrief: '', targetDurationSec: 15,
  });
  assert.equal(profile.fingerprint, expectedFingerprint, '快照指纹与计划一致');
  assert.ok(capturedPrompt, '必须捕获生成 prompt');
  assert.ok((capturedPrompt! as { audienceProfile?: { segment?: string } }).audienceProfile?.segment, '生成 prompt 携带结构化画像块');
  const requirements = (capturedPrompt! as { requirements?: string[] }).requirements || [];
  assert.ok(requirements.some((item) => item.includes('audienceProfile')), '生成要求必须绑定画像');
  assert.ok(requirements.some((item) => item.includes('不引用任何卖点')), '必须包含反堆砌约束');
}

// (b) 画像分析抛错：降级画像写入快照，任务照常成功
{
  const { result, planPayload } = await runAudienceScenario({
    async generate(input) {
      const primary = briefCandidatePoints(input)[0]!;
      assert.ok(input.audienceSegment, '降级画像也必须绑定到方向');
      return { content: normalizeGeneratedScript(okContent(primary.id, primary.title, '之二'), input), attempts: 1 };
    },
    async analyzeAudienceProfile() { throw new Error('网关 500'); },
  }, 'audience-model-fail');
  assert.equal(result.status, 'succeeded', '画像分析失败不得阻塞任务');
  const profile = planPayload.audienceProfile as { degraded: boolean; degradedReason?: string };
  assert.equal(profile.degraded, true, '失败时写入降级画像');
  assert.match(profile.degradedReason || '', /500/, '降级原因保留');
}

// (c) 预算：plan_analysis 独立上限（默认 2 次）
{
  const budgetTask = createTask(db, {
    projectId: 'p1', requestKey: 'audience-budget', mode: 'reuse', libraryRevisionId: library.id,
    requestedCount: 1, inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
  }, now).task;
  reservePlanAnalysisRequest(db, budgetTask.id, now);
  reservePlanAnalysisRequest(db, budgetTask.id, now);
  assert.throws(() => reservePlanAnalysisRequest(db, budgetTask.id, now), /已达上限/, '第三次调用必须被预算拦截');
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('script-studio-audience-profile.test.ts: ok (parse, fallback, snapshot, signals, runner, budget)');
