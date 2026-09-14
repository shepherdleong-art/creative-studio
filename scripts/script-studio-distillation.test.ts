/**
 * P1 卖点提炼层回归（方案 §3，验收 B1-B9）：
 * - B3：失败证据/用户禁用/包外事实不得被提炼（整条丢弃）；
 * - B4：5/8/10 字符标签上限逐字符计数，超限置 null 不截断；
 * - B5：范围扩大（框架质保→整件质保）、材质替换（鹅毛→鹅绒）、功效替换（耐折→防猫抓）不得自动通过；
 * - B7：模型返回来源之外的数字不得自动通过；
 * - B1：合并「同名不同参数」来源事实进入 needs_review；
 * - B8：draft → approved 只能由显式确认触发；
 * - B9：缓存按项目+来源修订+规则版本+模型身份区分，复用不提升确认状态、不重复请求；
 * - B6：旧修订派生结果不可变，新修订生成新批次；提炼失败/预算耗尽只降级跳过，不阻断脚本生成。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createLibraryRevision, manualEditLibraryRevision } from '../lib/script-studio/libraries.ts';
import { createTask, getTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask } from '../lib/script-studio/runner.ts';
import {
  approveDistilledPoint,
  buildDistillationPrompt,
  countDistilledStatus,
  createSellingPointDistiller,
  distillableFacts,
  distilledExpressionRefs,
  distillationFingerprint,
  editDistilledPoint,
  findCachedDistilledPoints,
  getDistilledPointById,
  listDistilledPointsForRevision,
  parseAndValidateDistilledPoints,
  saveDistilledPoints,
  SELLING_POINT_DISTILL_RULE_VERSION,
  type DistillableFact,
  type SellingPointDistiller,
} from '../lib/script-studio/distillation.ts';
import {
  briefCandidatePoints,
  buildScriptPrompt,
  normalizeGeneratedScript,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';

// ── 单元：解析与本地校验 ────────────────────────────────────────────
const unitFacts: DistillableFact[] = [
  { id: 'f-frame', title: '框架质保', factText: '框架质保 20 年。', evidenceQuote: '框架质保20年', pointType: 'spec', riskLevel: 'high' },
  { id: 'f-feather', title: '鹅毛填充', factText: '靠包填充鹅毛。', evidenceQuote: '填充鹅毛', pointType: 'material', riskLevel: 'high' },
  { id: 'f-fabric', title: '面料耐折', factText: '接触面面料耐折。', evidenceQuote: '面料耐折', pointType: 'material', riskLevel: 'low' },
  { id: 'f-depth', title: '座深', factText: '标准款座深 60cm。', evidenceQuote: '座深60cm', pointType: 'spec', riskLevel: 'low' },
  { id: 'f-depth-plus', title: '座深', factText: '加大款座深 65cm。', evidenceQuote: '座深65cm', pointType: 'spec', riskLevel: 'low' },
  { id: 'f-color', title: '栗棕配色', factText: '配色为浓郁栗棕。', evidenceQuote: '栗棕', pointType: 'appearance', riskLevel: 'low' },
];

// 合法条目 → draft；引用失败/禁用/未知事实的条目整条丢弃（B3）。
const valid = parseAndValidateDistilledPoints({
  distilledPoints: [
    {
      title: '框架长期可靠', benefitText: '框架结构有长期保障', shortCopy: '框架用得住，坐着更安心',
      tags: { max5: '框架可靠', max8: '框架结构可靠', max10: '框架长期可靠安心' },
      role: 'core', priority: 80, scope: '框架', limitations: ['仅框架结构'],
      sourceFactIds: ['f-frame'],
    },
    {
      title: '坏引用', benefitText: '不该出现', shortCopy: '坏引用短句',
      tags: {}, role: 'spec', priority: 10, sourceFactIds: ['f-feather', 'not-a-fact'],
    },
  ],
}, unitFacts);
assert.equal(valid.points.length, 1, '只有合法条目保留');
assert.equal(valid.rejectedCount, 1, '引用未知事实的条目整条丢弃（B3）');
assert.equal(valid.points[0]!.reviewStatus, 'draft', '合法条目进入待确认状态');
assert.equal(valid.points[0]!.tags.max5, '框架可靠');
assert.equal(valid.points[0]!.tags.max8, '框架结构可靠');
assert.equal(valid.points[0]!.tags.max10, '框架长期可靠安心');

// B4：标签逐字符计数（数字、字母、标点都算），超限置 null 而非截断。
const tagLimits = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '座深规格', benefitText: '座深 60cm 落座宽松', shortCopy: '座深宽敞落座舒服',
    tags: { max5: '座深60cm', max8: '标准款座深60厘米', max10: '标准款座深60厘米落座宽松' },
    role: 'spec', priority: 30, scope: '', limitations: [], sourceFactIds: ['f-depth'],
  }],
}, unitFacts);
assert.deepEqual(
  tagLimits.points[0]!.tags,
  { max5: null, max8: null, max10: null },
  '「座深60cm」6 字符、「标准款座深60厘米」9 字符等均超对应上限 → null，不截断',
);

// B5：范围扩大 / 材质替换 / 功效替换 → needs_review，不自动通过。
const scopeExpansion = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '整件质保', benefitText: '整件商品质保 20 年', shortCopy: '整件质保 20 年更放心',
    tags: { max5: null, max8: null, max10: null },
    role: 'core', priority: 70, scope: '整件', limitations: [],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(scopeExpansion.points[0]!.reviewStatus, 'needs_review', '「框架质保」扩大为「整件质保」不得自动通过');
assert.ok(scopeExpansion.points[0]!.reviewIssues.some((issue) => issue.includes('范围被扩大')));

// 审查 R3：展示标签不得绕过事实核验——「终身质保」「整件质保99年」必须进 needs_review。
const tagBypass = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '质保承诺', benefitText: '框架结构有长期质保', shortCopy: '框架质保用得更安心',
    tags: { max5: '终身质保', max8: '整件质保99年', max10: null },
    role: 'core', priority: 70, scope: '框架', limitations: ['仅框架结构'],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(tagBypass.points[0]!.reviewStatus, 'needs_review', '标签绕过核验的反例必须拦截（R3）');
assert.ok(tagBypass.points[0]!.reviewIssues.some((issue) => issue.includes('范围被扩大：终身')), '「终身质保」标签命中范围扩大');
assert.ok(tagBypass.points[0]!.reviewIssues.some((issue) => issue.includes('数字未受来源支持：99')), '「99年」标签命中数字落地');
assert.equal(tagBypass.points[0]!.tags.max5, null, '丢限定的「终身质保」标签置空（P2）');
assert.equal(tagBypass.points[0]!.tags.max8, null, '丢限定的「整件质保99年」标签置空（P2）');

// 审查 R3：限定条件丢失——来源「框架质保」，短句/标签写成「质保20年」不得自动通过。
const qualifierLoss = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '质保年限', benefitText: '质保 20 年更放心', shortCopy: '质保 20 年用得安心',
    tags: { max5: null, max8: null, max10: null },
    role: 'core', priority: 70, scope: '', limitations: [],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(qualifierLoss.points[0]!.reviewStatus, 'needs_review', '丢掉「框架」限定的质保短句不得自动通过（R3）');
assert.ok(qualifierLoss.points[0]!.reviewIssues.some((issue) => issue.includes('限定条件丢失')), '必须指出限定条件丢失');

// R3 反向：输出保留了来源限定词（提到质保且含「框架」）→ 不触发限定丢失。
const qualifierKept = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '框架质保', benefitText: '框架结构质保 20 年', shortCopy: '框架质保 20 年更安心',
    tags: { max5: '框架质保', max8: null, max10: null },
    role: 'core', priority: 70, scope: '框架', limitations: [],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(qualifierKept.points[0]!.reviewStatus, 'draft', '保留限定词的提炼正常进入待确认');

// 复审 P2：限定条件逐字段核验——其他字段（title/benefitText）保留「框架」不能代替短句/标签自身保留。
const perFieldQualifier = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '框架质保',                    // 保留「框架」
    benefitText: '框架结构质保 20 年',    // 保留「框架」
    shortCopy: '质保 20 年用得安心',      // 丢限定 → 待复核
    tags: { max5: '20年质保', max8: '框架质保', max10: null },
    role: 'core', priority: 70, scope: '', limitations: [],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(perFieldQualifier.points[0]!.reviewStatus, 'needs_review', '其他字段保留限定不能让丢限定的短句通过（P2）');
assert.equal(perFieldQualifier.points[0]!.tags.max5, null, '丢限定的标签必须置空（P2）');
assert.equal(perFieldQualifier.points[0]!.tags.max8, '框架质保', '保留限定的标签不受影响');
assert.ok(
  perFieldQualifier.points[0]!.reviewIssues.some((issue) => issue.includes('短句「质保 20 年用得安心」未保留来源限定「框架」')),
  '必须指出具体丢限定的短句',
);

// 复审 P2：仅 scope 保留限定同样不能代替短句/标签。
const scopeOnlyQualifier = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '质保承诺', benefitText: '长期质保更放心', shortCopy: '质保 20 年用得安心',
    tags: { max5: '20年质保', max8: null, max10: null },
    role: 'core', priority: 70, scope: '框架', limitations: [],
    sourceFactIds: ['f-frame'],
  }],
}, unitFacts);
assert.equal(scopeOnlyQualifier.points[0]!.reviewStatus, 'needs_review', '仅 scope 保留限定不能让短句/标签通过（P2）');
assert.equal(scopeOnlyQualifier.points[0]!.tags.max5, null, 'scope 里的限定不能救回标签（P2）');

const materialSwap = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '鹅绒填充', benefitText: '靠包填充鹅绒更蓬松', shortCopy: '鹅绒靠包蓬松舒适',
    tags: {}, role: 'core', priority: 60, scope: '靠包', limitations: [], sourceFactIds: ['f-feather'],
  }],
}, unitFacts);
assert.equal(materialSwap.points[0]!.reviewStatus, 'needs_review', '来源是鹅毛时不得写成鹅绒');

const efficacySwap = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '防猫抓面料', benefitText: '面料防猫抓更耐用', shortCopy: '养猫家庭也能放心用',
    tags: {}, role: 'supporting', priority: 50, scope: '接触面', limitations: [], sourceFactIds: ['f-fabric'],
  }],
}, unitFacts);
assert.equal(efficacySwap.points[0]!.reviewStatus, 'needs_review', '来源只说耐折时不得写成防猫抓');

// B7：来源之外的数字不得自动通过。
const unsupportedDigit = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '加大座深', benefitText: '座深 65cm 更宽敞', shortCopy: '大座深坐得更宽松',
    tags: {}, role: 'spec', priority: 30, scope: '', limitations: [], sourceFactIds: ['f-depth'],
  }],
}, unitFacts);
assert.equal(unsupportedDigit.points[0]!.reviewStatus, 'needs_review', '60cm 的证据不能支持 65cm');
assert.ok(unsupportedDigit.points[0]!.reviewIssues.some((issue) => issue.includes('数字未受来源支持')));

// B1：合并「同名不同参数」事实 → needs_review。
const mergeConflict = parseAndValidateDistilledPoints({
  distilledPoints: [{
    title: '座深可选', benefitText: '标准与加大座深都可选', shortCopy: '两种座深按需选',
    tags: {}, role: 'spec', priority: 30, scope: '', limitations: [], sourceFactIds: ['f-depth', 'f-depth-plus'],
  }],
}, unitFacts);
assert.equal(mergeConflict.points[0]!.reviewStatus, 'needs_review', '同名不同参数（60cm/65cm）不得被合并成一条通过');

// 重复短句去重。
const deduped = parseAndValidateDistilledPoints({
  distilledPoints: [
    { title: '配色氛围', benefitText: '栗棕配色有氛围', shortCopy: '栗棕配色有氛围', tags: {}, role: 'atmosphere', priority: 20, sourceFactIds: ['f-color'] },
    { title: '配色氛围2', benefitText: '栗棕配色有氛围', shortCopy: '栗棕配色有氛围', tags: {}, role: 'atmosphere', priority: 20, sourceFactIds: ['f-color'] },
  ],
}, unitFacts);
assert.equal(deduped.points.length, 1, '重复推荐短句只保留首条');

// 提炼提示词约束：范围保护与「null 而非截断」必须写进要求。
const distillPrompt = buildDistillationPrompt({ facts: unitFacts, productName: '测试沙发' });
assert.ok(distillPrompt.userPrompt.includes('不得截断或偷偷扩大承诺'), '提示词必须包含范围保护规则');
assert.ok(distillPrompt.userPrompt.includes('框架20年质保」不可写成「20年质保'), '提示词必须带 B5 反例');

// ── 持久化 / 缓存 / 状态（B6 / B8 / B9）─────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-distillation-'));
const now = () => new Date('2026-09-14T11:00:00.000Z');
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE shot_sets(id TEXT PRIMARY KEY, projectId TEXT); INSERT INTO projects VALUES ('p1','测试');`);
await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now });
db.prepare(`INSERT INTO script_studio_source_sets (id,projectId,contentFingerprint,imageAssetIdsJson,createdAt) VALUES ('src','p1','fp','["image-a"]',?)`).run(now().toISOString());
const library = createLibraryRevision(db, {
  projectId: 'p1', sourceSetId: 'src', sourceFingerprint: 'fp', productName: '休闲沙发', category: '沙发', brand: '',
  sellingPoints: [
    { title: '高靠背', themeTitle: '躺靠支撑', factText: '高靠背托住头颈。', evidenceQuote: '高靠背托住头颈', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'] },
    { title: '腰托贴合', themeTitle: '躺靠支撑', factText: '腰托贴合腰背。', evidenceQuote: '腰托贴合腰背', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_2'] },
    { title: '栗棕配色', themeTitle: '氛围外观', factText: '配色为浓郁栗棕。', evidenceQuote: '栗棕', pointType: 'appearance', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_3'] },
    { title: '失败证据', themeTitle: '其他', factText: '这条没通过核验。', evidenceQuote: '失败', pointType: 'spec', evidenceGate: 'failed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_4'] },
  ],
}, now);

const fingerprintA = distillationFingerprint({
  projectId: 'p1', sourceLibraryRevisionId: library.id,
  ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION, providerId: 'fake-text', model: 'model-a',
});
const savedA = saveDistilledPoints(db, {
  projectId: 'p1', sourceLibraryRevisionId: library.id,
  providerId: 'fake-text', model: 'model-a', fingerprint: fingerprintA,
  points: parseAndValidateDistilledPoints({
    distilledPoints: [
      { title: '躺靠支撑', benefitText: '高靠背与腰托让躺靠更放松', shortCopy: '累了就往这张沙发一躺', tags: { max5: '躺靠支撑', max8: '下班躺靠放松', max10: '高靠背腰托都托住' }, role: 'core', priority: 80, scope: '', limitations: [], sourceFactIds: [library.sellingPoints[0]!.id, library.sellingPoints[1]!.id] },
      { title: '栗棕氛围', benefitText: '浓郁栗棕配色更显家居氛围', shortCopy: '栗棕配色很有氛围', tags: { max5: '栗棕氛围', max8: null, max10: null }, role: 'atmosphere', priority: 40, scope: '', limitations: [], sourceFactIds: [library.sellingPoints[2]!.id] },
    ],
  }, distillableFacts(library)).points,
}, now);
assert.equal(savedA.length, 2);

// B9：缓存按指纹区分——不同模型身份不误命中。
const cachedA = findCachedDistilledPoints(db, 'p1', fingerprintA);
assert.equal(cachedA.length, 2, '同指纹整批命中');
assert.equal(findCachedDistilledPoints(db, 'p1', distillationFingerprint({
  projectId: 'p1', sourceLibraryRevisionId: library.id,
  ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION, providerId: 'fake-text', model: 'model-b',
})).length, 0, '模型身份不同不得复用缓存');

// 复审 P2：规则版本升级后，旧规则（v1）的缓存指纹不被新任务命中——
// 指纹含规则版本，v2 任务必然 miss 并按新规则重新提炼；旧 v1 行原样保留、不被覆盖。
assert.equal(findCachedDistilledPoints(db, 'p1', distillationFingerprint({
  projectId: 'p1', sourceLibraryRevisionId: library.id,
  ruleVersion: 'distill-rules-v1', providerId: 'fake-text', model: 'model-a',
})).length, 0, '旧规则版本的缓存指纹不被新任务命中（P2）');

// 复用不提升确认状态：缓存命中后仍是 draft。
assert.equal(cachedA.every((point) => point.reviewStatus === 'draft'), true, '复用不提升确认状态');

// B8：draft → approved 只能由显式确认触发。
const approvedPoint = approveDistilledPoint(db, 'p1', savedA[0]!.id, now);
assert.equal(approvedPoint?.reviewStatus, 'approved');
assert.equal(approveDistilledPoint(db, 'p2', savedA[1]!.id, now), null, '跨项目不得确认');
assert.deepEqual(countDistilledStatus(listDistilledPointsForRevision(db, 'p1', library.id)), {
  total: 2, core: 1, approved: 1, needsReview: 0, draft: 1,
});
// 只有 approved 进入生成表达参考。
const expressionRefs = distilledExpressionRefs(listDistilledPointsForRevision(db, 'p1', library.id));
assert.equal(expressionRefs.length, 1);
assert.equal(expressionRefs[0]!.shortCopy, '累了就往这张沙发一躺');

// B6：新修订（用户编辑产生）→ 新批次；旧修订派生结果保持不变。
const edited = manualEditLibraryRevision(db, 'p1', [{
  sellingPointId: library.sellingPoints[0]!.id, usable: false, disabledByUser: true,
}], { now });
assert.notEqual(edited.id, library.id, '编辑产生新修订');
assert.equal(listDistilledPointsForRevision(db, 'p1', library.id).length, 2, '旧修订派生结果不可变');
assert.equal(listDistilledPointsForRevision(db, 'p1', edited.id).length, 0, '新修订尚无派生结果');

// ── Runner 集成：提炼阶段、降级与缓存 ────────────────────────────────
let distillCalls = 0;
let distillError: Error | null = null;
function makeDistiller(providerId: string, model: string): SellingPointDistiller {
  return {
    providerId,
    model,
    async distill(input) {
      distillCalls += 1;
      if (distillError) throw distillError;
      const usableIds = new Set(input.facts.map((fact) => fact.id));
      return {
        distilledPoints: [
          {
            title: '躺靠支撑', benefitText: '高靠背与腰托让躺靠更放松', shortCopy: '累了就往这张沙发一躺',
            tags: { max5: '躺靠支撑', max8: '下班躺靠放松', max10: '高靠背腰托都托住' },
            role: 'core', priority: 80, scope: '', limitations: [],
            sourceFactIds: input.facts.filter((fact) => usableIds.has(fact.id)).slice(0, 2).map((fact) => fact.id),
          },
          { title: '失败引用', benefitText: '不应存在', shortCopy: '不应存在', tags: {}, role: 'spec', priority: 1, sourceFactIds: ['failed-gate-id'] },
        ],
      };
    },
  };
}
const capturedGenerateInputs: ScriptGeneratorInput[] = [];
// 每个任务用实质不同的标题（同批只换编号会被标题去重拦截，这是既有规则的设计意图）。
const TITLE_POOL = [
  { title: '下班回家的躺靠角落', secondary: '支撑体验放松' },
  { title: '客厅小憩的靠背细节', secondary: '腰托贴合日常' },
  { title: '周末在家的舒服坐感', secondary: '久坐也不累人' },
  { title: '追剧夜晚的放松位置', secondary: '窝进去就不想起来' },
  { title: '家里最想坐的那一处', secondary: '给自己留个角落' },
  { title: '读书角落的安稳支撑', secondary: '安静待着的底气' },
];
let titleCursor = 0;
function makeGenerator(): ScriptGeneratorShim {
  return {
    async generate(input) {
      capturedGenerateInputs.push(input);
      const seed = TITLE_POOL[titleCursor++ % TITLE_POOL.length]!;
      const primary = briefCandidatePoints(input)[0]!;
      return {
        content: normalizeGeneratedScript({
          title: seed.title,
          coverTitleParts: { primary: '腰托沙发', secondary: seed.secondary },
          direction: '先讲痛点再给证据',
          segments: [
            { narration: '高靠背托住头颈，腰托贴合腰背，软弹座包坐着也舒服。', sellingPointIdRefs: [primary.id], visualIntent: '', visualKeywords: ['靠背'] },
            { narration: '想给家里添个放松的位置，就从了解这款沙发开始。', sellingPointIdRefs: [], visualIntent: '', visualKeywords: ['沙发'] },
          ],
        }, input),
        attempts: 1,
      };
    },
  };
}
type ScriptGeneratorShim = NonNullable<Parameters<typeof executeScriptStudioTask>[0]['generator']>;

let taskSeq = 0;
async function runGenerationTask(options: { distiller?: SellingPointDistiller }): Promise<string> {
  const inputSnapshot = { targetDurationSec: 15, requestedCount: 1 };
  const task = createTask(db, {
    projectId: 'p1',
    requestKey: `distill-${taskSeq++}`,
    mode: 'reuse',
    libraryRevisionId: library.id,
    requestedCount: 1,
    inputSnapshot,
  }, now).task;
  const result = await executeScriptStudioTask({
    db, projectId: 'p1', taskId: task.id, libraryRevisionId: library.id, inputSnapshot,
    generator: makeGenerator(), distiller: options.distiller, now,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } },
    reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  assert.equal(result.status, 'succeeded', `提炼阶段的问题不得阻断脚本生成：${getTask(db, 'p1', task.id)?.errorMessage || JSON.stringify(result)}`);
  return task.id;
}
function distillStageRow(taskId: string): { status: string; payloadJson: string } {
  return db.prepare(`SELECT status, payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = 'distill'`).get(taskId) as { status: string; payloadJson: string };
}

// 场景 1：无提炼器 → 阶段跳过，任务照常完成。
{
  const taskId = await runGenerationTask({});
  const stage = distillStageRow(taskId);
  assert.equal(stage.status, 'skipped');
  assert.equal(JSON.parse(stage.payloadJson).reason, 'no_distiller');
}

// 场景 2：正常提炼 → 阶段成功，draft 保存；尚未确认 → 生成提示词不含提炼表达。
{
  const taskId = await runGenerationTask({ distiller: makeDistiller('fake-text', 'model-a') });
  const stage = distillStageRow(taskId);
  assert.equal(stage.status, 'succeeded', '提炼阶段必须成功');
  const payload = JSON.parse(stage.payloadJson) as { cached?: boolean; total?: number; rejectedCount?: number; draft?: number };
  assert.equal(payload.cached, true, '此前单元已按同指纹入库，本任务应缓存复用');
  assert.equal(distillCalls, 0, '缓存命中不得重复调用模型（B9）');
  // 单元部分已保存 2 条（1 approved + 1 draft）→ 表达参考只含 approved。
  const input = capturedGenerateInputs.at(-1)!;
  assert.ok(input.distilledExpressions?.some((ref) => ref.shortCopy === '累了就往这张沙发一躺'), '已确认表达进入生成输入');
  const prompt = buildScriptPrompt(input);
  assert.ok(prompt.userPrompt.includes('累了就往这张沙发一躺'), '已确认短句作为表达参考进入提示词');
  assert.ok(prompt.userPrompt.includes('不是新的事实来源'), '提示词必须声明短句不是新的事实来源');
  assert.ok(prompt.userPrompt.includes('不应存在') === false, '引用失败证据的条目不得进入任何下游（B3）');
  const savedRow = db.prepare(`SELECT contentJson FROM project_script_revisions ORDER BY rowid DESC LIMIT 1`).get() as { contentJson: string };
  const content = JSON.parse(savedRow.contentJson) as { distilledContext?: { ruleVersion: string; pointIds: string[] } };
  assert.equal(content.distilledContext?.ruleVersion, SELLING_POINT_DISTILL_RULE_VERSION, '脚本冻结所用派生版本');
  assert.equal(content.distilledContext?.pointIds?.length, 1);
}

// 场景 3：不同模型身份（新指纹）→ 真实调用一次；提炼失败 → 阶段跳过但任务成功。
{
  distillError = new Error('模型暂时不可用');
  const taskId = await runGenerationTask({ distiller: makeDistiller('fake-text', 'model-b') });
  const stage = distillStageRow(taskId);
  assert.equal(stage.status, 'skipped', '提炼失败只降级跳过');
  assert.equal(JSON.parse(stage.payloadJson).reason, 'distill_failed');
  assert.equal(distillCalls, 1, '不同模型身份不命中缓存，真实调用一次');
  distillError = null;
  // 恢复后再跑一次同模型任务：本次成功提炼并入库。
  const taskId2 = await runGenerationTask({ distiller: makeDistiller('fake-text', 'model-b') });
  assert.equal(distillStageRow(taskId2).status, 'succeeded');
  assert.equal(distillCalls, 2);
  const payload2 = JSON.parse(distillStageRow(taskId2).payloadJson) as { rejectedCount?: number; draft?: number };
  assert.equal(payload2.rejectedCount, 1, '失败证据引用条目被丢弃并计数');
  assert.equal(payload2.draft, 1);
}

// 场景 4：提炼预算独立计账——同任务多次提炼共享上限（这里通过直接预留验证接口契约）。
{
  const budgetTaskId = createTask(db, {
    projectId: 'p1', requestKey: `distill-budget-${taskSeq++}`, mode: 'reuse',
    libraryRevisionId: library.id, requestedCount: 1,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1 },
  }, now).task.id;
  const { reserveDistillRequest, distillRequestUsed } = await import('../lib/script-studio/request-budget.ts');
  reserveDistillRequest(db, budgetTaskId, now);
  reserveDistillRequest(db, budgetTaskId, now);
  assert.equal(distillRequestUsed(db, budgetTaskId), 2, '提炼请求计数独立记录');
  process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_DISTILL_REQUESTS_PER_TASK = '2';
  try {
    assert.throws(() => reserveDistillRequest(db, budgetTaskId, now), /提炼请求已达上限/);
  } finally {
    delete process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_DISTILL_REQUESTS_PER_TASK;
  }
}

// ── 审查 R4：多事实归并表达只在全部来源都属于方向包时进入 prompt ──────
{
  const f1 = library.sellingPoints[0]!;
  const f2 = library.sellingPoints[1]!;
  const basePlan = { index: 1, templateId: 'pain_point', templateName: '直击痛点', templateVersion: 1, angle: '先讲痛点再给证据', direction: 'pain_point', rationale: '测试' };
  const audience = '家居人群';
  const platform = '通用';
  const tone = '自然';
  const targetDurationSec = 15;
  const crossFactExpression = [{
    id: 'expr-f1-f2',
    sourceFactIds: [f1.id, f2.id],
    shortCopy: '高靠背搭配腰托支撑',
    benefitText: '靠背与腰托一起托住身体',
    scope: '',
    limitations: [],
  }];
  // 方向包只有 f1：表达来自 f1+f2 → 不得进入提示词，也不得冻结进 distilledContext。
  const partialInput: ScriptGeneratorInput = {
    libraryRevision: library,
    plan: basePlan,
    brief: { planIndex: 1, templateId: 'pain_point', themeKey: 't', themeTitle: '躺靠支撑', requiredPointIds: [f1.id], optionalPointIds: [], candidateCount: 1, degraded: false, rationale: '测试' },
    audience, tone, platform, creativeBrief: '', targetDurationSec, previousScripts: [],
    distilledExpressions: crossFactExpression,
  };
  const partialPrompt = buildScriptPrompt(partialInput);
  assert.equal(partialPrompt.userPrompt.includes('高靠背搭配腰托支撑'), false, '部分来源在方向包外的表达不得进入提示词（R4）');
  const partialNormalized = normalizeGeneratedScript({
    title: '部分来源表达边界',
    coverTitleParts: { primary: '腰托沙发', secondary: '表达边界验证' },
    direction: '先讲痛点再给证据',
    segments: [{ narration: '高靠背托住头颈。', sellingPointIdRefs: [f1.id], visualIntent: '', visualKeywords: ['靠背'] }],
  }, partialInput);
  assert.equal(partialNormalized.distilledContext, undefined, '未实际使用的表达不得冻结进内容快照（R4）');
  // 方向包含 f1+f2：表达进入提示词，且附带完整来源事实 ID。
  const fullInput: ScriptGeneratorInput = {
    ...partialInput,
    brief: { ...partialInput.brief, requiredPointIds: [f1.id, f2.id], candidateCount: 2 },
  };
  const fullPrompt = buildScriptPrompt(fullInput);
  assert.ok(fullPrompt.userPrompt.includes('高靠背搭配腰托支撑'), '全部来源都在方向包内时表达进入提示词');
  const distilledField = JSON.parse(fullPrompt.userPrompt).sellingPoints.find(
    (point: { distilled?: { sourceFactIds?: string[] } }) => point.distilled,
  )?.distilled as { sourceFactIds?: string[] };
  assert.deepEqual(distilledField.sourceFactIds, [f1.id, f2.id], 'distilled 字段必须附带全部来源事实 ID（R4）');
  const fullNormalized = normalizeGeneratedScript({
    title: '完整来源表达边界',
    coverTitleParts: { primary: '腰托沙发', secondary: '完整来源验证' },
    direction: '先讲痛点再给证据',
    segments: [{ narration: '高靠背托住头颈，腰托贴合腰背。', sellingPointIdRefs: [f1.id, f2.id], visualIntent: '', visualKeywords: ['靠背'] }],
  }, fullInput);
  assert.deepEqual(fullNormalized.distilledContext?.pointIds, ['expr-f1-f2'], '实际使用的表达集合被冻结');
}

// ── 审查 R5：提炼请求贯通 AbortSignal ────────────────────────────────
{
  let providerCalled = false;
  let providerReceivedSignal: AbortSignal | undefined;
  const distiller = createSellingPointDistiller(async (request) => {
    providerCalled = true;
    providerReceivedSignal = request.signal;
    return { distilledPoints: [] };
  }, { id: 'fake-text', model: 'model-signal' });
  const controller = new AbortController();
  controller.abort();
  await distiller.distill({ facts: distillableFacts(library), productName: '休闲沙发', signal: controller.signal });
  assert.equal(providerCalled, true, '提炼器必须把请求发给供应商适配层');
  assert.equal(providerReceivedSignal, controller.signal, '取消信号必须贯通到 completeJson（R5）');
}

// ── 复审 P1：手动编辑产生不可变新版本，旧版本内容与确认状态保留 ──────
{
  const fingerprintEdit = distillationFingerprint({
    projectId: 'p1', sourceLibraryRevisionId: library.id,
    ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION, providerId: 'fake-text', model: 'model-edit',
  });
  const savedEdit = saveDistilledPoints(db, {
    projectId: 'p1', sourceLibraryRevisionId: library.id,
    providerId: 'fake-text', model: 'model-edit', fingerprint: fingerprintEdit,
    points: parseAndValidateDistilledPoints({
      distilledPoints: [{
        title: '躺靠支撑', benefitText: '高靠背让躺靠更放松', shortCopy: '往这张沙发一躺就放松',
        tags: { max5: '躺靠放松', max8: null, max10: null },
        role: 'core', priority: 80, scope: '', limitations: [], sourceFactIds: [library.sellingPoints[0]!.id],
      }],
    }, distillableFacts(library)).points,
  }, now);
  const original = savedEdit[0]!;
  assert.equal(original.reviewIssues.length, 0);
  assert.equal(original.editHistory.length, 0);
  assert.equal(original.supersededById, null);
  // 先确认再编辑：编辑产生新版本行（新 ID），旧版本不可变。
  approveDistilledPoint(db, 'p1', original.id, now);
  const edited = editDistilledPoint(db, 'p1', original.id, { shortCopy: '下班回家就想往这躺' }, now);
  assert.ok(edited, '编辑必须返回新版本');
  assert.notEqual(edited!.id, original.id, '每次编辑产生可寻址的新版本 ID（P1）');
  assert.equal(edited!.shortCopy, '下班回家就想往这躺');
  assert.equal(edited!.reviewStatus, 'draft', '新版本回到 draft，不继承旧批准（方案 §3.3）');
  assert.equal(edited!.editHistory.length, 1, '旧值追加进编辑历史');
  assert.equal(edited!.editHistory[0]!.previousVersionId, original.id, '历史条目可寻址到上一版本行');
  assert.equal(edited!.editHistory[0]!.shortCopy, '往这张沙发一躺就放松', '模型原始短句保留在历史中');
  // 旧版本行不可变：ID 仍解析到原内容与确认状态——脚本冻结的 pointIds 不受编辑影响。
  const frozenVersion = getDistilledPointById(db, 'p1', original.id);
  assert.equal(frozenVersion?.shortCopy, '往这张沙发一躺就放松', '旧版本内容不被覆盖（P1）');
  assert.equal(frozenVersion?.reviewStatus, 'approved', '旧版本确认状态保留（P1）');
  assert.equal(frozenVersion?.supersededById, edited!.id, '旧行仅标记被取代');
  // 缓存/当前指针与冻结引用分开：只返回新草稿。
  const cachedAfterEdit = findCachedDistilledPoints(db, 'p1', fingerprintEdit);
  assert.equal(cachedAfterEdit.length, 1);
  assert.equal(cachedAfterEdit[0]!.id, edited!.id, '当前列表指向新版本（P1）');
  // 已被取代的版本不可再编辑/确认；空编辑与跨项目编辑被拒绝。
  assert.equal(editDistilledPoint(db, 'p1', original.id, { shortCopy: '再次编辑旧版本' }, now), null, '已取代版本不可编辑（P1）');
  assert.equal(approveDistilledPoint(db, 'p1', original.id, now), null, '已取代版本不可确认（P1）');
  assert.equal(editDistilledPoint(db, 'p1', edited!.id, { shortCopy: '  ' }, now), null, '空编辑不得生效');
  assert.equal(editDistilledPoint(db, 'p2', edited!.id, { shortCopy: '跨项目' }, now), null, '跨项目不得编辑');
  // 复审反例：连续编辑 22 次 → 24 行全部保留，原始内容不消失（旧行不会只剩 1 行 + 20 条截断历史）。
  let latest = edited!;
  for (let i = 0; i < 22; i += 1) {
    const next = editDistilledPoint(db, 'p1', latest.id, { shortCopy: `第${i + 1}次编辑后的短句` }, now);
    assert.ok(next, `第 ${i + 1} 次编辑必须产生新版本`);
    latest = next!;
  }
  const rowCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM script_studio_distilled_points WHERE fingerprint = ?
  `).get(fingerprintEdit) as { n: number }).n;
  assert.equal(rowCount, 1 + 1 + 22, '模型原版 + 首次编辑 + 22 次编辑 = 24 行全保留（P1 复审反例）');
  const originalAfterManyEdits = getDistilledPointById(db, 'p1', original.id);
  assert.equal(originalAfterManyEdits?.shortCopy, '往这张沙发一躺就放松', '多次编辑后原始内容仍在（P1）');
  assert.equal(originalAfterManyEdits?.reviewStatus, 'approved', '原始确认状态仍在（P1）');
  // 当前指针指向最新版本；确认后缓存读取到 approved。
  const currentPointer = findCachedDistilledPoints(db, 'p1', fingerprintEdit);
  assert.equal(currentPointer.length, 1);
  assert.equal(currentPointer[0]!.id, latest.id, '当前指针指向最新版本');
  approveDistilledPoint(db, 'p1', latest.id, now);
  const current = findCachedDistilledPoints(db, 'p1', fingerprintEdit)[0]!;
  assert.equal(current.reviewStatus, 'approved', '新版本确认后成为当前已确认版本');
}

// ── 审查补齐：needs_review 原因（reviewIssues）持久化往返 ────────────
{
  const fingerprintIssues = distillationFingerprint({
    projectId: 'p1', sourceLibraryRevisionId: library.id,
    ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION, providerId: 'fake-text', model: 'model-issues',
  });
  const savedIssues = saveDistilledPoints(db, {
    projectId: 'p1', sourceLibraryRevisionId: library.id,
    providerId: 'fake-text', model: 'model-issues', fingerprint: fingerprintIssues,
    points: parseAndValidateDistilledPoints({
      distilledPoints: [{
        title: '终身质保', benefitText: '终身质保更放心', shortCopy: '终身质保用得安心',
        tags: {}, role: 'core', priority: 70, scope: '', limitations: [],
        sourceFactIds: [library.sellingPoints[0]!.id],
      }],
    }, distillableFacts(library)).points,
  }, now);
  assert.equal(savedIssues[0]!.reviewStatus, 'needs_review');
  const reloadedIssues = findCachedDistilledPoints(db, 'p1', fingerprintIssues)[0]!;
  assert.ok(
    reloadedIssues.reviewIssues.some((issue) => issue.includes('范围被扩大：终身')),
    '复核原因持久化并可在读取时拿到（R3）',
  );
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('script-studio-distillation.test.ts: ok (B1-B9, R3, R4, R5, edit)');
