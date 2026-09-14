/**
 * P0 脚本结尾质量与 CTA 回归（方案 §2.1-§2.3 / §4.3，验收 A1-A5 / A7 / A11）：
 * - A1/A3：51 字正文 +「浓郁栗棕配色。」式孤立标签收尾（无论模型直出还是历史补字）→
 *   不再本地补字，触发受约束正文修复并以自然 CTA 收尾；偏长候选如实保存；
 * - A2/A5：偏短/偏长不再阻断保存、不触发机械补字、不误报时长合格；
 * - A4：纯情绪收束不算 CTA；修复响应在 CTA 后追加标签也不能通过；
 * - A7/A11：20 秒框架在 15 秒任务上不再携带冲突秒数；知识库 CTA 结尾意图贯通到
 *   prompt、plan 快照与保存内容；策略未匹配但模板已使用、模板不可用、快照冻结三情形。
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
  briefCandidatePoints,
  buildScriptEndingReviewPrompt,
  buildScriptPrompt,
  createScriptGenerator,
  normalizeGeneratedScript,
  type ScriptBodyRepairInput,
  type ScriptGenerator,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';
import { checkScriptEndingQuality, parseScriptEndingReview } from '../lib/script-studio/cta-policy.ts';
import { adaptFrameworkStructureToDuration } from '../lib/script-studio/framework-adaptation.ts';
import { createScriptRequestBudget } from '../lib/script-studio/request-budget.ts';
import { serializeKnowledgeContext, type FrozenKnowledgeContext } from '../lib/script-studio/knowledge-context.ts';
import type { KnowledgePlanRecommendation } from '../lib/script-studio/template-catalog.ts';
import { buildScriptDurationBudget } from '../lib/script-duration-policy.ts';
import type { ScriptStudioScriptContent } from '../lib/script-studio/types.ts';

// ── 单元：结尾质量检查 ────────────────────────────────────────────────
const endingCandidates = [
  { id: 'c-color', title: '浓郁栗棕配色' },
  { id: 'c-back', title: '高靠背' },
];
function endingOf(segments: string[]) {
  return checkScriptEndingQuality(
    { segments: segments.map((narration, index) => ({ id: `s${index + 1}`, narration, subtitle: narration, sellingPointIdRefs: [], sellingPointRefs: [], visualIntent: '', visualKeywords: [] })) },
    endingCandidates,
  );
}
// 孤立标签收尾（与候选卖点标题一致）必须拦截（A1/A3）。
assert.deepEqual(endingOf(['正文一段。', '浓郁栗棕配色。']).issues, ['ending_bare_selling_point']);
assert.equal(endingOf(['正文一段。', '浓郁栗棕配色。']).bareSellingPointId, 'c-color');
// 纯情绪收束不算 CTA（A4）。
assert.deepEqual(endingOf(['正文一段。', '把下班后的时间留给自己。']).issues, ['cta_ending_missing']);
// 品牌口号/孤立颜色（无匹配标题时）同样缺少行动引导。
assert.deepEqual(endingOf(['正文一段。', '高级灰配色。']).issues, ['cta_ending_missing']);
// 审查 R2 反例 1：含「了解」但是陈述句，不构成行动邀请。
assert.deepEqual(endingOf(['正文一段。', '这款沙发是我了解过的。']).issues, ['cta_ending_missing']);
// 审查 R2 反例 2：CTA 后追加标签——末句是标签，同样拦截。
assert.deepEqual(endingOf(['正文一段。', '先了解这款沙发。浓郁栗棕配色。']).issues, ['ending_bare_selling_point']);
// 审查 R2 反例 3：未确认渠道/促销词默认拦截（方案 §2.3 使用条件未满足）。
assert.deepEqual(endingOf(['正文一段。', '私信领取五折优惠。']).issues, ['cta_channel_unconfirmed']);
assert.equal(endingOf(['正文一段。', '私信领取五折优惠。']).unconfirmedChannelTerm, '私信');
// 方案 §2.3 表格示例：情感/功能两类默认可用（无渠道依赖）。
assert.deepEqual(endingOf(['正文一段。', '想给下班后的自己留个放松的位置，就从这款沙发开始了解。']).issues, []);
assert.deepEqual(endingOf(['正文一段。', '选沙发时，先看看这款的靠背和腰托，再选适合自己的坐靠支撑。']).issues, []);
// 咨询/购买两类依赖已确认渠道：默认（未确认）必须拦截。
assert.deepEqual(endingOf(['正文一段。', '想看看哪款适合你家，私信告诉我客厅尺寸，一起挑一挑。']).issues, ['cta_channel_unconfirmed']);
assert.deepEqual(endingOf(['正文一段。', '尺寸和配色都合适，就点商品链接看看这款。']).issues, ['cta_channel_unconfirmed']);
// 末句提取：多句末段按最后一个句末标点切分（R2）。
assert.deepEqual(endingOf(['先了解这款沙发。想比较这些细节是否适合你家。']).issues, []);

// ── 单元：框架秒数适配（A7）────────────────────────────────────────
const ctaFramework20s = ['场景进入（3s）', '需求发生（3s）', '产品介入（4s）', '场景使用（6s）', '理想生活 / CTA（4s）'];
for (const target of [15, 30, 45, 60] as const) {
  const adapted = adaptFrameworkStructureToDuration(ctaFramework20s, target);
  assert.equal(adapted.adjusted, true, `${target} 秒目标与 20 秒框架冲突必须适配`);
  assert.equal(adapted.structure.some((beat) => /\d+s/i.test(beat)), false, `${target} 秒任务不得携带 20 秒框架的固定秒数`);
  assert.equal(adapted.ctaEndingScene, '理想生活', 'CTA 结尾意图在适配后保留');
  assert.match(adapted.structure.at(-1)!, /CTA/, '末段仍标注 CTA 结尾');
}
// 框架合计与目标一致（20 秒框架 + 20 秒任务）：不冲突，原样保留。
const kept = adaptFrameworkStructureToDuration(ctaFramework20s, 20);
assert.equal(kept.adjusted, false);
assert.deepEqual(kept.structure, ctaFramework20s);
assert.equal(kept.ctaEndingScene, '理想生活');
// 无秒数框架：不调整，仍可提取结尾意图；无 CTA 段时结尾意图为 null（走通用 CTA 规则）。
assert.equal(adaptFrameworkStructureToDuration(['痛点暴露', '产品解决'], 15).adjusted, false);
assert.equal(adaptFrameworkStructureToDuration(['痛点暴露', '产品解决'], 15).ctaEndingScene, null);
assert.equal(adaptFrameworkStructureToDuration(['场景进入', '理想生活 / CTA'], 15).ctaEndingScene, '理想生活');

// ── 场景夹具 ────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-cta-ending-'));
const now = () => new Date('2026-09-14T09:00:00.000Z');
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
    { title: '腰托贴合', themeTitle: '躺靠支撑', factText: '腰托贴合腰背。', evidenceQuote: '腰托贴合腰背', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_3'] },
    { title: '浓郁栗棕配色', themeTitle: '氛围外观', factText: '配色为浓郁栗棕。', evidenceQuote: '配色为浓郁栗棕', pointType: 'appearance', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_4'] },
  ],
}, now);

interface Captured {
  generateInputs: ScriptGeneratorInput[];
  repairInputs: ScriptBodyRepairInput[];
  primaryTitles: string[];
}
function bodySegments(primaryId: string, primaryTitle: string) {
  return [
    { narration: '沙发不该只用来坐，累了就想躺一会儿。', sellingPointIdRefs: [primaryId], visualIntent: '客厅沙发', visualKeywords: ['沙发'] },
    { narration: '躺靠时扶手留空，软软不磕身，沉醉松弛境界。', sellingPointIdRefs: [primaryId], visualIntent: '躺靠放松', visualKeywords: ['躺靠'] },
    { narration: `115°${primaryTitle}饱满，免去抱枕，侧靠也很贴身。`, sellingPointIdRefs: [primaryId], visualIntent: '靠背支撑', visualKeywords: ['靠背'] },
  ];
}
const CTA_LINE = '想给下班后的自己留个放松的位置，就从这款沙发开始了解。';

let taskSeq = 0;
async function runScenario(options: {
  knowledge?: FrozenKnowledgeContext | null;
  generator: ScriptGenerator;
}): Promise<{ result: Awaited<ReturnType<typeof executeScriptStudioTask>>; taskId: string }> {
  const inputSnapshot: Record<string, unknown> = { targetDurationSec: 15, requestedCount: 1 };
  if (options.knowledge) inputSnapshot.knowledgeContext = serializeKnowledgeContext(options.knowledge);
  const task = createTask(db, {
    projectId: 'p1',
    requestKey: `cta-scenario-${taskSeq++}`,
    mode: 'reuse',
    libraryRevisionId: library.id,
    requestedCount: 1,
    inputSnapshot,
  }, now).task;
  const result = await executeScriptStudioTask({
    db, projectId: 'p1', taskId: task.id, libraryRevisionId: library.id, inputSnapshot,
    generator: options.generator, now,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
    reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  return { result, taskId: task.id };
}

function savedContent(): { content: ScriptStudioScriptContent; validation: Record<string, unknown> } {
  const row = db.prepare(`
    SELECT contentJson, validationJson FROM project_script_revisions ORDER BY rowid DESC LIMIT 1
  `).get() as { contentJson: string; validationJson: string };
  return {
    content: JSON.parse(row.contentJson) as ScriptStudioScriptContent,
    validation: JSON.parse(row.validationJson) as Record<string, unknown>,
  };
}

// ── A1/A3：模型直出孤立颜色尾句 → 受约束修复为 CTA 收尾 + 语义审核通过后保存 ──
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  let reviewCalls = 0;
  const { result, taskId: taskIdA1 } = await runScenario({
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        captured.primaryTitles.push(primary.title);
        return {
          content: normalizeGeneratedScript({
            title: '下班躺靠的松弛角落',
            coverTitleParts: { primary: '高靠背沙发', secondary: '腰托贴合支撑' },
            direction: '以真实情绪变化带动选择',
            segments: [...bodySegments(primary.id, primary.title), { narration: `${primary.title}。`, sellingPointIdRefs: [primary.id], visualIntent: '外观', visualKeywords: ['外观'] }],
          }, input),
          attempts: 1,
        };
      },
      async repairScriptContent(input) {
        captured.repairInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] }],
        };
      },
      async reviewScriptContent(input) {
        reviewCalls += 1;
        // 审核提示词必须包含全部可用事实与完整正文（不只被引用的）。
        const prompt = JSON.parse(buildScriptEndingReviewPrompt(input).userPrompt);
        assert.equal(prompt.task, 'review_project_script_ending_v1');
        assert.ok(prompt.fullScript.length > 0, '审核必须看到完整正文');
        return { pass: true, issues: [], checks: { actionInvitation: true, followsContext: true, channelAppropriate: true, factsSupported: true, noContentAfterCta: true } };
      },
    },
  });
  assert.equal(result.status, 'succeeded', `孤立标签收尾经修复后必须能保存：${getTask(db, 'p1', taskIdA1)?.errorMessage || ''}`);
  assert.equal(captured.repairInputs.length, 1, '必须触发一次受约束正文修复（不再本地补字）');
  assert.ok(
    captured.repairInputs[0]!.qualityIssues.includes('ending_bare_selling_point')
      || captured.repairInputs[0]!.qualityIssues.includes('cta_ending_missing'),
    '修复提示词必须携带具体结尾质量问题',
  );
  assert.equal(reviewCalls, 1, '本地修复通过后必须执行一次语义审核（R2）');
  const { content, validation } = savedContent();
  assert.equal(content.segments.at(-1)!.narration, CTA_LINE, '最终末段必须是 CTA');
  assert.equal(content.fullScript.includes(`${captured.primaryTitles[0]}。`), false, '孤立标签不得保留在结尾');
  // 偏长候选如实保存（A1/A5）：修复后 77 字 > 15 秒预算上限 59 字，不误报合格。
  const budget = buildScriptDurationBudget(15);
  assert.ok(content.contentCharacterCount > budget.maxContentCharacters, '完整表达 + CTA 允许超过原字数上限');
  assert.equal(content.durationStatus, 'too_long', '偏长如实展示，不改报合格');
  assert.equal((validation as { durationStatus?: string }).durationStatus, 'too_long');
  const copyCheck = (validation as { copyCheck?: { endingStatus?: string; semanticReview?: string; reviewFingerprint?: string; policyVersion?: string } }).copyCheck;
  assert.equal(copyCheck?.endingStatus, 'passed');
  assert.equal(copyCheck?.semanticReview, 'passed', '审核通过后语义状态记为 passed');
  assert.match(copyCheck?.reviewFingerprint || '', /^[0-9a-f]{64}$/, '审核结果绑定正文指纹（R2）');
  assert.equal(copyCheck?.policyVersion, 'cta-ending-v2');
}

// ── A2/A5：偏短但表达完整 → 不机械补字，如实保存偏短候选 ──────────────
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  const { result } = await runScenario({
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          content: normalizeGeneratedScript({
            title: '窗边小坐的靠背支撑',
            coverTitleParts: { primary: '腰托沙发', secondary: '靠背贴合体验' },
            direction: '用生活场景建立代入感',
            segments: [
              { narration: '高靠背托住头颈，腰托贴合腰背。', sellingPointIdRefs: [primary.id], visualIntent: '靠背', visualKeywords: ['靠背'] },
              { narration: '想了解这款沙发，就点开看看。', sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] },
            ],
          }, input),
          attempts: 1,
        };
      },
      async repairScriptContent() { throw new Error('偏短不应触发修复'); },
    },
  });
  assert.equal(result.status, 'succeeded', '偏短不阻止保存');
  assert.equal(captured.repairInputs.length, 0, '不得为凑字数触发补字或修复');
  const { content, validation } = savedContent();
  assert.equal(content.segments.length, 2, '不得追加补字分段');
  assert.equal(content.durationStatus, 'too_short', '偏短如实展示');
  assert.equal((validation as { durationStatus?: string }).durationStatus, 'too_short');
}

// ── A4：纯情绪收束 → 修复为 CTA；修复响应在 CTA 后追加标签也不能通过 ──
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  const { result } = await runScenario({
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        if (captured.generateInputs.length === 1) {
          return {
            content: normalizeGeneratedScript({
              title: '留给自己的沙发时光',
              coverTitleParts: { primary: '柔软扶手', secondary: '下班放松角落' },
              direction: '以真实情绪变化带动选择',
              segments: [...bodySegments(primary.id, primary.title), { narration: '把下班后的时间留给自己。', sellingPointIdRefs: [], visualIntent: '放松', visualKeywords: ['放松'] }],
            }, input),
            attempts: 1,
          };
        }
        // 第二轮生成直接给合格 CTA 结尾。
        return {
          content: normalizeGeneratedScript({
            title: '留给自己的沙发时光',
            coverTitleParts: { primary: '柔软扶手', secondary: '下班放松角落' },
            direction: '以真实情绪变化带动选择',
            segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] }],
          }, input),
          attempts: 1,
        };
      },
      async repairScriptContent(input) {
        captured.repairInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        // 首次修复在 CTA 后追加颜色标签：必须被拒绝（A4）。
        return {
          segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] }, { narration: '浓郁栗棕配色。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['外观'] }],
        };
      },
    },
  });
  assert.equal(result.status, 'succeeded', 'CTA 后追加标签的修复被拒后，重生成合格方案必须能保存');
  assert.equal(captured.repairInputs.length, 1, '纯情绪收束触发修复');
  assert.ok(captured.repairInputs[0]!.qualityIssues.includes('cta_ending_missing'), '纯情绪收束识别为缺少 CTA');
  assert.equal(captured.generateInputs.length, 2, '修复被拒后进入下一轮重生成');
  const { content } = savedContent();
  assert.equal(content.segments.at(-1)!.narration, CTA_LINE, '最终以 CTA 收尾，其后无标签');
}

// ── A7/A11(a)：策略未匹配但模板已使用，20 秒 CTA 框架冻结进 15 秒任务 ──
function ctaKnowledge(recommendations: KnowledgePlanRecommendation[], usedCatalog: boolean): FrozenKnowledgeContext {
  return {
    strategy: {
      matchStatus: 'unmatched', strategyCatalogRevisionId: null, strategyEntryId: null,
      normalizedModelKey: 'sofa-x', canonicalName: null, searchTerms: [],
      primarySellingPoints: [], differentiators: [], categoryMindsets: [], sourceRows: [],
    },
    template: { templateCatalogRevisionId: usedCatalog ? 'tpl-rev-1' : null, usedCatalog, fallbackWarning: usedCatalog ? null : '未启用脚本模板库' },
    recommendations,
    fingerprint: `fp-${usedCatalog ? 'used' : 'unused'}-${recommendations.length}`,
  } as FrozenKnowledgeContext;
}
const framework20s: KnowledgePlanRecommendation = {
  planIndex: 1,
  framework: { id: 'fw-1', stableKey: '03', name: '03 理想生活型', structure: ctaFramework20s, rationale: '按证据卖点类型选框架' },
  copyHook: null,
  visualHook: null,
};
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  const knowledge = ctaKnowledge([framework20s], true);
  const { result, taskId } = await runScenario({
    knowledge,
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          content: normalizeGeneratedScript({
            title: '理想生活的松弛起点',
            coverTitleParts: { primary: '腰托沙发', secondary: '理想生活提案' },
            direction: '以真实情绪变化带动选择',
            segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] }],
          }, input),
          attempts: 1,
        };
      },
    },
  });
  assert.equal(result.status, 'succeeded');
  const plan = captured.generateInputs[0]!.plan;
  assert.ok(plan.recommendation?.framework, '策略未匹配但模板已使用时，推荐必须从冻结快照挂载');
  assert.equal(plan.recommendation!.framework!.structure.some((beat) => /\d+s/i.test(beat)), false, '15 秒任务的 prompt 不得携带 20 秒框架秒数（A7）');
  assert.match(plan.recommendation!.framework!.structure.at(-1)!, /CTA/, '有效结构末段保留 CTA 结尾意图');
  // prompt 贯通：结尾意图来自冻结框架（A11），不能仅靠 usedCatalog 判定。
  const prompt = buildScriptPrompt(captured.generateInputs[0]!);
  assert.ok(prompt.userPrompt.includes('结尾意图为「理想生活」'), 'prompt 必须携带框架结尾意图');
  assert.ok(prompt.userPrompt.includes('不得出现私信'), 'prompt 必须包含无渠道时的 CTA 约束');
  // 保存内容与 plan 快照展示同一有效结构；冻结知识上下文保留原目录结构供溯源。
  const { content } = savedContent();
  assert.deepEqual(content.recommendation!.framework!.structure, plan.recommendation!.framework!.structure, '脚本内容快照与 prompt 使用同一有效结构');
  const planStage = db.prepare(`SELECT payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = 'plan'`).get(taskId) as { payloadJson: string };
  const planPayload = JSON.parse(planStage.payloadJson) as {
    plans?: Array<{ recommendation?: { framework?: { structure?: string[] } } }>;
  };
  assert.equal(planPayload.plans?.[0]?.recommendation?.framework?.structure?.some((beat) => /\d+s/i.test(beat)), false, 'plan 快照展示有效结构');
  // 原目录结构（含秒数）保留在任务冻结的 inputSnapshot 知识上下文中供溯源。
  const taskRow = db.prepare(`SELECT inputSnapshotJson FROM script_studio_tasks WHERE id = ?`).get(taskId) as { inputSnapshotJson: string };
  const snapshot = JSON.parse(taskRow.inputSnapshotJson) as {
    knowledgeContext?: { recommendations?: Array<{ framework?: { structure?: string[] } }> };
  };
  assert.deepEqual(
    snapshot.knowledgeContext?.recommendations?.[0]?.framework?.structure,
    ctaFramework20s,
    '冻结知识上下文保留原目录结构（含秒数）供溯源',
  );
  assert.ok(content.segments.at(-1)!.narration.includes('了解'), '最终末句实际邀请行动');
}

// ── A11(b)：模板不可用 → 通用 CTA 规则，不携带框架结尾意图 ────────────
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  const knowledge = ctaKnowledge([], false);
  const { result } = await runScenario({
    knowledge,
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          content: normalizeGeneratedScript({
            title: '小户型的躺靠自由',
            coverTitleParts: { primary: '高靠背沙发', secondary: '小户型躺靠' },
            direction: '从问题到解决方案闭环',
            segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] }],
          }, input),
          attempts: 1,
        };
      },
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(!captured.generateInputs[0]!.plan.recommendation, '模板不可用时不挂载推荐');
  const prompt = buildScriptPrompt(captured.generateInputs[0]!);
  assert.ok(prompt.userPrompt.includes('最后一句口播必须是简洁、具体的 CTA'), '无框架时使用通用 CTA 规则');
  assert.ok(!prompt.userPrompt.includes('结尾意图为「'), '无框架时不得虚构结尾意图');
}

// ── A11(c)：队列期间目录切换 → 任务只用冻结快照，不重读当前目录 ────────
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  // 任务创建时冻结的是 fw-1（20 秒 CTA 框架）；模拟设置页随后切换目录（这里数据库中根本没有新目录，
  // runner 也绝不查询当前目录——若重读，推荐会消失或改变）。
  const frozen = ctaKnowledge([framework20s], true);
  const { result } = await runScenario({
    knowledge: frozen,
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          content: normalizeGeneratedScript({
            title: '快照冻结的框架推荐',
            coverTitleParts: { primary: '腰托沙发', secondary: '冻结快照验证' },
            direction: '以真实情绪变化带动选择',
            segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '产品展示', visualKeywords: ['沙发'] }],
          }, input),
          attempts: 1,
        };
      },
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(captured.generateInputs[0]!.plan.recommendation!.framework!.id, 'fw-1', '目录切换后仍使用冻结快照的框架');
  const { content } = savedContent();
  assert.ok(content.segments.at(-1)!.narration.includes('了解'), '快照链路最终末句仍邀请行动');
}

// ── R2 反例回归：陈述式「了解」/ 未确认渠道 → 本地拦截并修复 ──────────
{
  const statements = ['这款沙发是我了解过的。', '私信领取五折优惠。'];
  const expectedCodes = ['cta_ending_missing', 'cta_channel_unconfirmed'];
  for (let index = 0; index < statements.length; index += 1) {
    const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
    const { result, taskId } = await runScenario({
      generator: {
        async generate(input) {
          captured.generateInputs.push(input);
          const primary = briefCandidatePoints(input)[0]!;
          return {
            content: normalizeGeneratedScript({
              title: index === 0 ? '了解过的沙发角落' : '私信优惠的收尾',
              coverTitleParts: { primary: '腰托沙发', secondary: index === 0 ? '了解体验记录' : '优惠收尾体验' },
              direction: '以真实情绪变化带动选择',
              segments: [...bodySegments(primary.id, primary.title), { narration: statements[index]!, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] }],
            }, input),
            attempts: 1,
          };
        },
        async repairScriptContent(input) {
          captured.repairInputs.push(input);
          const primary = briefCandidatePoints(input)[0]!;
          return {
            segments: [...bodySegments(primary.id, primary.title), { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] }],
          };
        },
        async reviewScriptContent() { return { pass: true, issues: [] }; },
      },
    });
    assert.equal(result.status, 'succeeded', `审查反例 ${index + 1} 修复后必须能保存：${getTask(db, 'p1', taskId)?.errorMessage || ''}`);
    assert.equal(captured.repairInputs.length, 1, `反例 ${index + 1} 必须触发一次修复`);
    assert.ok(
      captured.repairInputs[0]!.qualityIssues.includes(expectedCodes[index]!),
      `反例 ${index + 1} 修复提示词必须携带 ${expectedCodes[index]}`,
    );
    const { content } = savedContent();
    assert.equal(content.segments.at(-1)!.narration, CTA_LINE, `反例 ${index + 1} 最终以合格 CTA 收尾`);
  }
}

// ── R2 语义审核：合法引用 ID 挡不住无证据功效，审核必须拦截并修复 ────
{
  const captured: Captured = { generateInputs: [], repairInputs: [], primaryTitles: [] };
  let reviewCalls = 0;
  const { result, taskId } = await runScenario({
    generator: {
      async generate(input) {
        captured.generateInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        // 引用了合法事实 ID，但正文宣称「治好颈椎病」——本地机械校验拦不住（审查实测反例）。
        return {
          content: normalizeGeneratedScript({
            title: '靠背支撑的真实体验',
            coverTitleParts: { primary: '腰托沙发', secondary: '靠背支撑体验' },
            direction: '先讲痛点再给证据',
            segments: [
              { narration: `115°${primary.title}饱满，还能治好颈椎病。`, sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
              { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
            ],
          }, input),
          attempts: 1,
        };
      },
      async repairScriptContent(input) {
        captured.repairInputs.push(input);
        const primary = briefCandidatePoints(input)[0]!;
        return {
          segments: [
            { narration: `115°${primary.title}饱满，侧靠也很贴身。`, sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
            { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
          ],
        };
      },
      async reviewScriptContent() {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return { pass: false, issues: ['正文宣称「治好颈椎病」，来源事实不支持该功效'], checks: { actionInvitation: true, followsContext: true, channelAppropriate: true, factsSupported: false, noContentAfterCta: true } };
        }
        return { pass: true, issues: [] };
      },
    },
  });
  assert.equal(result.status, 'succeeded', `审核拒绝后修复重审必须能保存：${getTask(db, 'p1', taskId)?.errorMessage || ''}`);
  assert.equal(reviewCalls, 2, '首审拒绝 → 修复 → 复审通过，共两次审核');
  assert.equal(captured.repairInputs.length, 1, '审核失败触发一次定向修复');
  assert.ok(
    captured.repairInputs[0]!.qualityIssues.some((issue) => issue.includes('治好颈椎病')),
    '修复提示词必须携带审核给出的具体原因',
  );
  const { content, validation } = savedContent();
  assert.equal(content.fullScript.includes('治好颈椎病'), false, '无证据功效不得保留在保存版本');
  const copyCheck = (validation as { copyCheck?: { semanticReview?: string } }).copyCheck;
  assert.equal(copyCheck?.semanticReview, 'passed', '复审通过后语义状态为 passed');
}

// ── R2 fail closed：审核始终不通过 → 修复重审仍失败 → 预算耗尽后方案失败 ──
{
  const scriptCountBefore = (db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n;
  const taskId = createTask(db, {
    projectId: 'p1',
    requestKey: 'cta-review-always-fail',
    mode: 'reuse',
    libraryRevisionId: library.id,
    requestedCount: 1,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
  }, now).task.id;
  const budget = createScriptRequestBudget({ db, taskId, requestedCount: 1, now });
  const badBody = (primaryId: string) => ({
    title: '审核始终失败的方案',
    coverTitleParts: { primary: '腰托沙发', secondary: '审核失败验证' },
    direction: '先讲痛点再给证据',
    segments: [
      { narration: '高靠背托住头颈，还能治好颈椎病。', sellingPointIdRefs: [primaryId], visualIntent: '', visualKeywords: ['靠背'] },
      { narration: CTA_LINE, sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
    ],
  });
  const generator = createScriptGenerator(async (request) => {
    const task = JSON.parse(request.userPrompt).task as string;
    const primary = library.sellingPoints[0]!;
    if (task === 'generate_project_script_v1') return badBody(primary.id);
    if (task === 'review_project_script_ending_v1') {
      return { pass: false, issues: ['正文宣称「治好颈椎病」，来源事实不支持该功效'] };
    }
    return { segments: badBody(primary.id).segments };
  }, { id: 'fake', model: 'fake' }, { budget });
  const result = await executeScriptStudioTask({
    db, projectId: 'p1', taskId, libraryRevisionId: library.id,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
    generator, now,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
    reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  assert.equal(result.status, 'failed', '审核始终不通过的方案必须失败');
  assert.match(getTask(db, 'p1', taskId)?.errorMessage || '', /预算已耗尽/, '失败原因必须指向请求预算（审核+修复共用 8 次）');
  assert.equal(budget.usedFor(1), 8, '方案级预算如实耗尽：2 轮 × (生成+审核+修复+复审)');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM project_scripts`).get() as { n: number }).n,
    scriptCountBefore,
    '审核未通过的版本不得保存',
  );
}

// ── R2 单元：审核解析 fail closed ────────────────────────────────────
assert.deepEqual(parseScriptEndingReview({ pass: true }), { pass: true, issues: [] });
assert.equal(parseScriptEndingReview({}).pass, false, '缺 pass 字段视为不通过');
assert.equal(parseScriptEndingReview('garbage').pass, false, '非对象响应视为不通过');
assert.equal(parseScriptEndingReview({ pass: false }).issues.length, 1, 'pass=false 无原因时给出兜底原因');
assert.deepEqual(
  parseScriptEndingReview({ pass: false, issues: ['渠道未确认'] }).issues,
  ['渠道未确认'],
  '审核原因透传给修复提示词',
);

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('script-studio-cta-ending.test.ts: ok (A1-A5, A7, A11, R2 ending check + semantic review)');
