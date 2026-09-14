import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createLibraryRevision, type LibraryRevisionView } from '../lib/script-studio/libraries.ts';
import { createTask, getTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask } from '../lib/script-studio/runner.ts';
import { createProjectScript, addProjectScriptRevision, listRecentProjectScriptTitles } from '../lib/script-studio/scripts.ts';
import { buildScriptPrompt, buildScriptTitleRepairPrompt, createScriptGenerator, normalizeGeneratedScript, type ScriptGenerator, type ScriptGeneratorInput, type ScriptTitleRepairInput } from '../lib/script-studio/generator.ts';
import { buildScriptTitleContext, areCoverTitlePairsDuplicate, areScriptTitlesDuplicate, checkScriptTitles, applyScriptTitleRepair } from '../lib/script-studio/title-policy.ts';
import { parseKnowledgeContext, serializeKnowledgeContext, type FrozenKnowledgeContext } from '../lib/script-studio/knowledge-context.ts';
import { buildScriptDurationBudget, countScriptContentCharacters } from '../lib/script-duration-policy.ts';
import type { ScriptStudioScriptContent } from '../lib/script-studio/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-title-repair-'));
const now = () => new Date('2026-09-09T12:00:00.000Z');
const knowledge: FrozenKnowledgeContext = {
  strategy: { matchStatus: 'matched', strategyCatalogRevisionId: null, strategyEntryId: null, normalizedModelKey: 'ps691-b', canonicalName: '#林氏黑森林沙发PS691', searchTerms: ['#中古客厅', '#黑森林沙发PS691'], primarySellingPoints: [], differentiators: [], categoryMindsets: [], sourceRows: [7] },
  template: { templateCatalogRevisionId: null, usedCatalog: false, fallbackWarning: null }, recommendations: [], fingerprint: 'frozen-old-knowledge',
};

let databaseSequence = 0;
async function fixture() {
  const db = new Database(path.join(root, `fixture-${databaseSequence++}.db`));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE shot_sets(id TEXT PRIMARY KEY, projectId TEXT);
    INSERT INTO projects VALUES ('p1','测试'),('p2','其他项目');`);
  const readiness = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now });
  assert.ok(readiness.state === 'ready' || readiness.state === 'current', JSON.stringify(readiness));
  db.prepare(`INSERT INTO script_studio_source_sets (id,projectId,contentFingerprint,imageAssetIdsJson,createdAt) VALUES ('src','p1','fp','["image-a","image-b"]',?)`).run(now().toISOString());
  const library = createLibraryRevision(db, {
    projectId: 'p1', sourceSetId: 'src', sourceFingerprint: 'fp', productName: 'PS691-B', category: '沙发', brand: '3M',
    sellingPoints: [
      { title: '靠背网布', themeTitle: '靠背轻透的秘密', factText: '靠背采用网布，座深60cm。', evidenceQuote: '靠背采用网布，座深60cm。', pointType: 'material', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_2'] },
      { title: '柔软扶手', themeTitle: '靠在扶手上歇一会', factText: '扶手外部包覆柔软面料。', evidenceQuote: '扶手外部包覆柔软面料。', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 1, tileRefs: ['tile_1'] },
    ],
  }, now);
  return { db, library };
}

function generationInput(library: LibraryRevisionView): ScriptGeneratorInput {
  return { libraryRevision: library, plan: { index: 1, templateId: 'pain_point', templateName: '痛点切入', templateVersion: 1, angle: '客厅阅读', direction: 'pain_point', rationale: '测试' }, brief: { planIndex: 1, templateId: 'pain_point', themeKey: 't', themeTitle: '靠背轻透的秘密', requiredPointIds: library.sellingPoints.map((p) => p.id), optionalPointIds: [], candidateCount: 2, degraded: false, rationale: '测试' }, audience: '家居人群', platform: '通用', tone: '自然', creativeBrief: '', targetDurationSec: 15, previousScripts: [], knowledgeContext: knowledge };
}

function content(input: ScriptGeneratorInput, index = 0): ScriptStudioScriptContent {
  const seeds = ['坐下之后，看看柔软扶手怎样包覆手臂，阅读听歌都能放松，日常休闲有个自在角落，靠背网布让家居多些层次。', '围绕窗边安排书桌与灯光，夜晚翻阅喜欢的杂志，周末约朋友喝茶聊天，把客厅变成温暖的交流场所，想找这样的角落，就从了解这款沙发开始。'];
  const budget = buildScriptDurationBudget(15);
  let narration = seeds[index % seeds.length]!;
  while (countScriptContentCharacters(narration) < budget.minContentCharacters) narration += seeds[index % seeds.length];
  while (countScriptContentCharacters(narration) > budget.maxContentCharacters) narration = narration.slice(0, -1);
  return normalizeGeneratedScript({ title: index ? '窗边阅读的惬意时光' : '柔软扶手里的休闲时光', coverTitleParts: { primary: '靠背轻透的秘密', secondary: '看看这些真实细节' }, segments: [{ narration, sellingPointIdRefs: input.brief.requiredPointIds, visualIntent: '客厅', visualKeywords: ['扶手'] }] }, input);
}

function store(db: Database.Database, value: ScriptStudioScriptContent, options: { projectId?: string; at?: string } = {}) {
  return createProjectScript(db, options.projectId || 'p1', { origin: 'manual_edit', contentJson: value as unknown as Record<string, unknown>, targetDurationSec: 15 }, () => new Date(options.at || now().toISOString()));
}

let request = 0;
async function run(db: Database.Database, library: LibraryRevisionView, generator: ScriptGenerator, options: { count?: number; targetScriptId?: string; signal?: AbortSignal } = {}) {
  const inputSnapshot = { targetDurationSec: 15, requestedCount: options.count || 1, targetScriptId: options.targetScriptId || '', knowledgeContext: serializeKnowledgeContext(knowledge) };
  const task = createTask(db, { projectId: 'p1', requestKey: `test-${request++}`, mode: 'reuse', libraryRevisionId: library.id, requestedCount: options.count || 1, inputSnapshot }, now).task;
  const result = await executeScriptStudioTask({ db, projectId: 'p1', taskId: task.id, libraryRevisionId: library.id, inputSnapshot, now, generator, signal: options.signal, fallbackOnInvalid: false,
    visionExtractor: { async extract() { throw new Error('不得重新提取图片'); } }, reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得重新调用模型核验'); } },
  });
  return { result, task: getTask(db, 'p1', task.id)! };
}

function protectedContent(value: ScriptStudioScriptContent) {
  return { segments: value.segments, fullScript: value.fullScript, fullSubtitle: value.fullSubtitle, sellingPointUsage: value.sellingPointUsage, targetDurationSec: value.targetDurationSec, targetNarrationDurationSec: value.targetNarrationDurationSec, estimatedNarrationDurationSec: value.estimatedNarrationDurationSec, durationStatus: value.durationStatus, contentCharacterCount: value.contentCharacterCount, libraryRevisionId: value.libraryRevisionId, direction: value.direction, templateId: value.templateId };
}

try {
  const { db, library } = await fixture();
  const input = generationInput(library);
  const titleContext = buildScriptTitleContext(library, knowledge);
  assert.equal(titleContext.displayName, '林氏黑森林沙发');
  assert.ok(titleContext.modelKeys.includes('ps691'));
  assert.equal(knowledge.strategy.canonicalName, '#林氏黑森林沙发PS691', '不能改写冻结的目录身份');
  assert.deepEqual(JSON.parse(JSON.stringify(parseKnowledgeContext(serializeKnowledgeContext(knowledge)))), knowledge, '缺少新身份字段的旧快照无损兼容');
  for (const value of ['PS691', 'ps691-b', 'ＰＳ６９１', 'PS691口播方案']) {
    assert.ok(checkScriptTitles({ ...content(input), title: value }, { libraryRevision: library, context: titleContext }).some((issue) => issue.code === 'title_contains_model'));
  }
  const brandSize = { ...content(input), title: '3M靠背60cm座深' };
  assert.equal(checkScriptTitles(brandSize, { libraryRevision: library, context: titleContext }).length, 0, '不能把正常品牌与尺寸当作型号');
  assert.ok(checkScriptTitles({ ...content(input), title: '6cm舒适座深' }, { libraryRevision: library, context: titleContext }).some((issue) => issue.code === 'title_unsupported_fact'), '60cm 的证据不能支持 6cm');
  const newKnowledge = { ...knowledge, productIdentity: { modelKey: 'PS691', submodel: 'B' }, strategy: { ...knowledge.strategy, canonicalName: null } };
  assert.equal(buildScriptTitleContext(library, newKnowledge).displayName, '沙发', '完整型号须先于主型号清理，避免遗留子型号');
  assert.ok(checkScriptTitles({ ...content(input), title: '真皮永久抗菌沙发' }, { libraryRevision: library, context: titleContext }).some((issue) => issue.code === 'title_unsupported_fact'));
  assert.ok(checkScriptTitles({ ...content(input), title: '这是一个已经明显超出十六字限制的超长标题' }, { libraryRevision: library }).some((issue) => issue.code === 'title_length'));
  assert.equal(areScriptTitlesDuplicate('靠背轻透的秘密', '靠背轻透的秘密（2）'), true);
  assert.equal(areScriptTitlesDuplicate('林氏沙发靠背轻透', '林氏沙发柔软扶手'), false, '可共享品牌、品类词');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断' } },
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅隔断高颜值' } },
  ), true, '副标题词序调换仍属于同一完整封面组合');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断' } },
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '大户型舒适不挡路' } },
  ), false, '同商品展示名主标题配不同实质卖点应放行');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断' } },
    { coverTitleParts: { primary: '林氏黑森林沙发', secondary: '横厅高颜值隔断' } },
  ), false, '不同主标题配同副标题不等同于完整组合重复');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '宽大柔软' } },
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '柔软宽大' } },
  ), true, '四字副标题的词序调换也属于近似重复');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '宽大柔软贴' } },
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '柔软宽大贴' } },
  ), true, '五字副标题的词序调换也属于近似重复');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '宽大柔软' } },
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '靠背轻柔承托' } },
  ), false, '短副标题字符不同的实质卖点应放行');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断' } },
    { coverTitleParts: { primary: '林氏摩卡沙发呀', secondary: '横厅高颜值隔断' } },
  ), true, '主标题只增加语气字时仍应拦截完整组合近似');
  assert.equal(areCoverTitlePairsDuplicate(
    { coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断' } },
    { coverTitleParts: { primary: '林氏摩卡沙发呀', secondary: '横厅隔断高颜值' } },
  ), true, '主标题小变体搭配副标题词序调换仍应拦截');
  const displayNameBase = content(input);
  const displayNameCover = { ...displayNameBase, coverTitleParts: { ...displayNameBase.coverTitleParts, primary: titleContext.displayName, secondary: '靠背轻透体验' } };
  assert.equal(checkScriptTitles(displayNameCover, { libraryRevision: library, context: titleContext }).some((issue) => issue.code === 'title_bare_product_name'), false, '封面主标题允许使用展示商品名');
  assert.ok(checkScriptTitles({ ...displayNameCover, title: titleContext.displayName }, { libraryRevision: library, context: titleContext }).some((issue) => issue.code === 'title_bare_product_name'), '内部脚本标题仍不得只写商品名');
  const promptProduct = JSON.parse(buildScriptPrompt(input).userPrompt).product;
  assert.equal(promptProduct.displayName, '林氏黑森林沙发');
  assert.ok(promptProduct.modelKeysForMatchingOnly.includes('ps691'));
  assert.equal(normalizeGeneratedScript({ ...content(input), title: '', coverTitleParts: {} }, input).title, '', '缺标题不能用型号兜底，也不能丢弃正文');

  // 同批不同正文、不同脚本标题、相同封面组合：保持并发，仅修复第二条的封面副标题。
  const originals: ScriptStudioScriptContent[] = [];
  let inFlight = 0; let maxInFlight = 0; let repairCalls = 0;
  const batch = await run(db, library, {
    async generate(actual) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5)); inFlight--;
      const value = content(actual, actual.plan.index - 1); originals[actual.plan.index - 1] = value;
      return { content: value, attempts: 1 };
    },
    async repairTitles(actual) {
      repairCalls++;
      assert.deepEqual([...new Set(actual.titleIssues.map((issue) => issue.field))], ['coverTitleParts.secondary']);
      assert.ok(actual.titleIssues.some((issue) => issue.code === 'duplicate_cover_combo' && issue.conflictingText?.includes('靠背轻透的秘密')));
      const prompt = JSON.parse(buildScriptTitleRepairPrompt(actual).userPrompt);
      assert.ok(prompt.previousTitles.some((item: { coverTitleParts?: { primary: string; secondary: string } }) => item.coverTitleParts?.primary === '靠背轻透的秘密' && item.coverTitleParts?.secondary === '看看这些真实细节'));
      return { title: '不应覆盖合格标题', coverTitleParts: { primary: '不应覆盖合格主标题', secondary: '靠在扶手上歇一会' }, fullScript: '恶意修改正文', fullSubtitle: '改字幕', targetDurationSec: 60, segments: [], sellingPointUsage: [] };
    },
  }, { count: 2 });
  assert.equal(batch.result.status, 'succeeded', batch.task.errorMessage || '');
  assert.equal(maxInFlight, 2); assert.equal(repairCalls, 1);
  const rows = db.prepare('SELECT contentJson FROM project_script_revisions ORDER BY rowid').all() as Array<{ contentJson: string }>;
  const saved = JSON.parse(rows[1]!.contentJson);
  assert.equal(saved.title, originals[1]!.title); assert.equal(saved.coverTitleParts.secondary, '靠在扶手上歇一会');
  assert.deepEqual(protectedContent(saved), protectedContent(originals[1]!));
  assert.equal(saved.coverTitleParts.primary, originals[1]!.coverTitleParts.primary, '完整组合重复时保留合格的商品展示名主标题');

  // 同项目近期再次生成：只修重复标题。自身再生成则排除自己的所有旧版本。
  const prior = originals[0]!;
  let historicalRepairs = 0;
  const historical = await run(db, library, { async generate() { return { content: prior, attempts: 1 }; }, async repairTitles(actual) {
    historicalRepairs++; assert.ok(actual.titleIssues.some((issue) => issue.code === 'duplicate_title'));
    assert.ok(actual.titleIssues.some((issue) => issue.code === 'duplicate_cover_combo'));
    return { title: '给阅读留个自在角落', coverTitleParts: { secondary: '窗边放松好时光' } };
  } });
  assert.equal(historical.result.status, 'succeeded'); assert.equal(historicalRepairs, 1);
  const selfDb = (await fixture());
  const selfInput = generationInput(selfDb.library); const selfContent = content(selfInput);
  const selfScript = store(selfDb.db, selfContent);
  addProjectScriptRevision(selfDb.db, 'p1', selfScript.id, { origin: 'manual_edit', contentJson: selfContent as unknown as Record<string, unknown>, targetDurationSec: 15 }, now);
  let selfRepairs = 0;
  const regenerated = await run(selfDb.db, selfDb.library, { async generate() { return { content: selfContent, attempts: 1 }; }, async repairTitles() { selfRepairs++; throw new Error('不应修复'); } }, { targetScriptId: selfScript.id });
  assert.equal(regenerated.result.status, 'succeeded'); assert.equal(selfRepairs, 0);
  assert.equal((selfDb.db.prepare('SELECT COUNT(*) AS n FROM project_scripts').get() as { n: number }).n, 1);
  selfDb.db.close();

  // 冻结目录名称带真实型号：runner 只重写标题，成功保存不含型号的新标题。
  const modelFixture = await fixture();
  const modelBody = content(generationInput(modelFixture.library));
  const modelContent = { ...modelBody, title: '#林氏黑森林沙发PS691 #中古客厅', coverTitleParts: { ...modelBody.coverTitleParts, primary: '林氏PS691沙发' } };
  let modelRepairs = 0;
  const modelFixed = await run(modelFixture.db, modelFixture.library, {
    async generate() { return { content: modelContent, attempts: 1 }; },
    async repairTitles(actual) {
      modelRepairs++;
      assert.ok(actual.titleIssues.some((issue) => issue.code === 'title_contains_model'));
      return { title: '扶手柔软的客厅角落', coverTitleParts: { primary: '坐下享受柔软包覆' } };
    },
  });
  assert.equal(modelFixed.result.status, 'succeeded'); assert.equal(modelRepairs, 1);
  const modelSaved = JSON.parse((modelFixture.db.prepare('SELECT contentJson FROM project_script_revisions').get() as { contentJson: string }).contentJson);
  assert.equal(modelSaved.title, '扶手柔软的客厅角落');
  assert.deepEqual(protectedContent(modelSaved), protectedContent(modelBody));
  assert.equal(modelSaved.knowledgeContext.canonicalName, knowledge.strategy.canonicalName);
  assert.equal(modelSaved.knowledgeContext.normalizedModelKey, 'ps691-b');
  assert.deepEqual(modelSaved.knowledgeContext.searchTerms, knowledge.strategy.searchTerms);
  modelFixture.db.close();

  // 不合格标题最多修复两次；不能因此重新生成正文，也不能保存任何不合格新版本。
  let bodyCalls = 0; let failedRepairs = 0;
  const before = (db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions').get() as { n: number }).n;
  const failed = await run(db, library, { async generate() { bodyCalls++; return { content: { ...prior, title: 'PS691', coverTitleParts: { primary: 'PS691', secondary: '看看这些真实细节', source: 'model' as const } }, attempts: 1 }; }, async repairTitles() { failedRepairs++; return { title: 'PS691', coverTitleParts: { primary: 'PS691' } }; } });
  assert.equal(failed.result.status, 'failed'); assert.equal(bodyCalls, 1); assert.equal(failedRepairs, 2);
  assert.match(failed.task.errorMessage || '', /标题未通过校验.*最多修复 2 次.*本方案未保存/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions').get() as { n: number }).n, before);

  // 模型等待期间有其他任务保存了拟用标题：下一次校验读取新历史，并在预算内再次修复。
  let interleavedRepairs = 0;
  const interleaved = await run(db, library, {
    async generate() { return { content: prior, attempts: 1 }; },
    async repairTitles(actual) {
      interleavedRepairs++;
      if (interleavedRepairs === 1) {
        const candidate = { ...prior, title: '下班后的闲适角落', coverTitleParts: { ...prior.coverTitleParts, secondary: '下班后柔软靠坐' } };
        store(db, candidate);
        return candidate;
      }
      assert.ok(actual.previousTitles?.some((item) => item.title === '下班后的闲适角落'));
      return { title: '翻开杂志享受慢时光', coverTitleParts: { secondary: '给闲暇添点温柔' } };
    },
  });
  assert.equal(interleaved.result.status, 'succeeded'); assert.equal(interleavedRepairs, 2);

  // 标题修复阶段中断：不保存候选，沿用任务的可恢复中断语义。
  const abort = new AbortController();
  const beforeAbort = (db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions').get() as { n: number }).n;
  const aborted = await run(db, library, {
    async generate() { return { content: prior, attempts: 1 }; },
    async repairTitles(actual) {
      assert.equal(actual.signal, abort.signal);
      abort.abort();
      return { title: '清晨沙发阅读片刻', coverTitleParts: { primary: '慢享晨间好时光' } };
    },
  }, { signal: abort.signal });
  assert.equal(aborted.task.status, 'queued');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_script_revisions').get() as { n: number }).n, beforeAbort);

  // 时间边界、项目隔离、100 版本上限，包含仍可追溯的旧修订。
  const history = await fixture(); const hc = content(generationInput(history.library));
  const outside = store(history.db, hc, { at: '2026-08-10T11:59:59.999Z' });
  const boundary = store(history.db, hc, { at: '2026-08-10T12:00:00.000Z' });
  const other = store(history.db, hc, { projectId: 'p2' });
  const list = listRecentProjectScriptTitles(history.db, 'p1', { now });
  assert.ok(list.some((item) => item.scriptId === boundary.id));
  assert.ok(!list.some((item) => [outside.id, other.id].includes(item.scriptId!)));
  for (let i = 0; i < 105; i++) store(history.db, hc);
  assert.equal(listRecentProjectScriptTitles(history.db, 'p1', { now }).length, 100);
  history.db.close();

  // 真实生成器接缝只做一次标题 JSON 请求，使用同一信号，不重新走正文生成。
  let completeCalls = 0;
  const gen = createScriptGenerator(async (request) => {
    completeCalls++; assert.equal(JSON.parse(request.userPrompt).task, 'repair_project_script_titles_v1');
    return { title: '午后阅读的小角落' };
  }, { id: 'fake', model: 'fake' });
  const bad = { ...prior, title: '' };
  const titleIssues = checkScriptTitles(bad, { libraryRevision: library, context: titleContext });
  const repairInput: ScriptTitleRepairInput = { ...input, content: bad, titleIssues };
  const repaired = applyScriptTitleRepair(bad, await gen.repairTitles!(repairInput), titleIssues);
  assert.equal(completeCalls, 1); assert.deepEqual(protectedContent(repaired), protectedContent(bad));
  db.close();
  console.log('script-studio-title-repair.test.ts: ok (identity, prompts, batch, history, self, bounded repair, body preservation)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
