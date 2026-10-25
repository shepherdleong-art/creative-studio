import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { register } from 'node:module';

// 数据根在业务模块加载前固定，直接运行本测试也不会触碰工作台数据。
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-template-execution-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;
register('./typescript-extension-loader.mjs', import.meta.url);
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { createTask, createScriptStudioTaskRequestKey, getTask, mergeStagePayload } = await import('../lib/script-studio/tasks.ts');
import type { ScriptStudioRunDeps } from '../lib/script-studio/runner.ts';
const { executeScriptStudioTask } = await import('../lib/script-studio/runner.ts');
const { createLibraryRevision } = await import('../lib/script-studio/libraries.ts');
const { createScriptGenerator } = await import('../lib/script-studio/generator.ts');
const { createScriptRequestBudget } = await import('../lib/script-studio/request-budget.ts');
const { listReadableProjectScripts } = await import('../lib/media-core/project-script-reader.ts');
import type { ScriptStudioCompleteJson, ScriptStudioCompleteJsonRequest } from '../lib/script-studio/llm-contract.ts';
import type { VisionExtractionResult, VisionExtractor } from '../lib/script-studio/adapters/vision-extract.ts';
import type { EvidenceReprobe } from '../lib/script-studio/adapters/reprobe.ts';
import type { FrozenViralTemplateSpec, ScriptStudioScriptContent } from '../lib/script-studio/types.ts';
const { charBoundsForTarget, scriptCnLen, templatePlanFingerprint } = await import('../lib/script-studio/template-rewrite.ts');
const { validateScriptContent } = await import('../lib/script-studio/validation.ts');

/**
 * 爆文模板改写模式全链行为测试（迁移方案 §7：A04–A12、A14）。
 * 假 completeJson 记录全部请求并按 systemPrompt 路由脚本化响应：
 * 不只断言提示词含关键词，还检查假供应商实际收到的参数、调用顺序与最终数据库结果。
 */

const FIXED_NOW = () => new Date('2026-09-17T08:00:00.000Z');

function createDb(root: string): Database.Database {
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
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT '', inputSnapshot TEXT NOT NULL DEFAULT '{}',
      outputJson TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL DEFAULT '2026-08-31T00:00:00.000Z',
      generationDurationMs INTEGER
    );
    INSERT INTO projects (id, name) VALUES ('p1', '项目一');
  `);
  return db;
}

const visionExtractor: VisionExtractor = {
  async extract(): Promise<VisionExtractionResult> {
    throw new Error('模板改写测试走 reuse 模式，不应触发视觉提取');
  },
};
const reprobe: EvidenceReprobe = { kind: 'vision_closed_question', async verify(input) { return { quote: input.claim }; } };

// ---------------------------------------------------------------------------
// 测试夹具：卖点库（verified×2 + unverified + 用户排除 + 证据失败）与冻结模板
// ---------------------------------------------------------------------------

async function seedLibrary(db: Database.Database) {
  db.prepare(`
    INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
    VALUES ('source-1', 'p1', 'fp-1', '["img-1"]', '2026-09-17T00:00:10.000Z')
  `).run();
  return createLibraryRevision(db, {
    projectId: 'p1',
    sourceSetId: 'source-1',
    sourceFingerprint: 'fp-1',
    productName: '林氏伸缩岩板餐桌',
    category: '餐桌椅',
    brand: '林氏',
    sellingPoints: [
      {
        title: '伸缩桌面', factText: '桌面可伸缩，四人位变六人位', pointType: 'structure',
        evidenceQuote: '桌面可伸缩 四人位变六人位', sourcePageIndex: 0, tileRefs: ['1'],
        detailText: '平时四人位不占地，朋友来了拉出来秒变六人位。',
        usable: true,
      },
      {
        title: '岩板台面', factText: '台面为岩板材质，耐高温', pointType: 'material',
        evidenceQuote: '岩板台面 耐高温', sourcePageIndex: 0, tileRefs: ['2'],
        detailText: '热锅直接上桌不怕烫，日常擦一擦就干净。',
        usable: true,
      },
      {
        title: '未核验详解卖点', factText: '普通事实', pointType: 'other',
        evidenceQuote: '普通事实', sourcePageIndex: 0, tileRefs: ['3'],
        detailText: '承重 500kg 超强', // 数字无据 → unverified
        usable: true,
      },
      {
        title: '用户排除卖点', factText: '被排除的事实', pointType: 'other',
        evidenceQuote: '被排除的事实', sourcePageIndex: 0, tileRefs: ['4'],
        detailText: '被排除的详解',
        usable: true, disabledByUser: true,
      },
      {
        title: '证据失败卖点', factText: '未通过核验的材质', pointType: 'material',
        evidenceQuote: '未通过核验的材质', sourcePageIndex: 0, tileRefs: ['5'],
        detailText: '未通过核验的详解',
        usable: false, evidenceGate: 'failed',
      },
    ],
  }, FIXED_NOW);
}

function makeTemplate(overrides: Partial<FrozenViralTemplateSpec> = {}): FrozenViralTemplateSpec {
  return {
    entryId: 'entry-1',
    revisionId: 'vtpl-rev-1',
    sourceTemplateId: 'tpl-src-1',
    scriptCode: 'J1',
    name: '小户型餐桌爆款',
    title: '小户型也能用上大餐桌',
    category: '餐桌椅',
    subCategory: '伸缩餐桌',
    refText: '标题：小户型也能用上大餐桌\n正文：谁说小房子不配拥有大餐桌？我家这款伸缩餐桌平时就收起来，两个人吃饭刚刚好。朋友聚餐一拉就开，坐六七个人都不挤。岩板桌面我用了一年，热锅直接放，擦起来也不费劲，真心推荐给纠结的姐妹。',
    structure: '钩子>痛点>卖点>逼单',
    structureOrigin: 'fallback',
    contentHash: 'hash-tpl-1',
    ...overrides,
  };
}

function templatePlanOf(templates: FrozenViralTemplateSpec[]): { templates: FrozenViralTemplateSpec[]; fingerprint: string } {
  return { templates, fingerprint: templatePlanFingerprint(templates) };
}

// 字数夹具（20 秒 → 目标 120 中文字，±15% 即 102–138）：
// 每段约 48–52 中文字 + 标题约 7 字 → 合计约 103–111，落在区间内。
// 正文池按 draft 调用次序轮换，避免同任务多模板正文相似触发 duplicate_script。
const DRAFT_TEXT_POOL: Array<[string, string]> = [
  ['这款伸缩岩板餐桌真的绝了'.repeat(4), '岩板台面耐高温热锅直接上桌'.repeat(4)],
  ['家里有张好用的桌子太重要了'.repeat(4), '伸缩设计小户型也能轻松驾驭'.repeat(4)],
  ['选对餐桌每天吃饭都开心呀'.repeat(4), '耐高温岩板一擦就干净了呢'.repeat(4)],
  ['小户型的餐桌就要这么选嘛'.repeat(4), '四人位六人位随心切换方便'.repeat(4)],
];
const SEG_OK_1 = DRAFT_TEXT_POOL[0]![0]!;
const SEG_OK_2 = DRAFT_TEXT_POOL[0]![1]!;
const LONG_REF = '标题：长参考\n正文：' + '这款意式极简沙发真的太好看了吧放在客厅特别有氛围感'.repeat(30); // 约 800 字，验证筛选用前 600 字

type FakeCall = ScriptStudioCompleteJsonRequest;
interface FakeLlm {
  calls: FakeCall[];
  completeJson: ScriptStudioCompleteJson;
  noteCount: number;
  titleRepairCount: number;
}

interface FakeLlmOptions {
  draftTitle?: () => string;
  draftCover?: { primary: string; secondary: string } | null | (() => { primary: string; secondary: string } | null);
  titleRepairResult?: unknown;
  draftSegments?: () => Array<{ label: string; text: string; refs: string[] }>;
  draftNote?: string;
  filterKeep?: unknown;
  styleResult?: unknown;
  failDraftFor?: string;
  humanizeResult?: unknown;
  smoothResult?: unknown;
  noteResult?: unknown;
  /** draft 文本池起始下标（恢复场景避免与已成功模板正文重复）。 */
  initialDraftIndex?: number;
}

function makeFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  let draftIndex = options.initialDraftIndex ?? 0;
  const state: FakeLlm = {
    calls: [],
    noteCount: 0,
    titleRepairCount: 0,
    completeJson: null as unknown as ScriptStudioCompleteJson,
  };
  state.completeJson = async (request) => {
    state.calls.push(request);
    const system = request.systemPrompt ?? '';
    if (system.includes('卖点甄别')) {
      if (options.filterKeep !== undefined) return options.filterKeep;
      return { keep: ['1', '2'] };
    }
    if (system.includes('天天刷带货视频')) {
      if (options.styleResult !== undefined) return options.styleResult;
      return { 说话感觉: '像朋友聊天', 开头词: ['姐妹们', '说真的'], 句长: '短句多', 钩子套路: '反问开场', 结尾方式: '自然推荐', 禁用词: ['家人们'] };
    }
    if (system.includes('带货文案改写专家')) {
      if (options.failDraftFor && request.userPrompt.includes(options.failDraftFor)) {
        throw new Error('模拟模板生成失败（网络错误）');
      }
      const poolEntry = DRAFT_TEXT_POOL[draftIndex % DRAFT_TEXT_POOL.length]!;
      draftIndex += 1;
      return {
        title: options.draftTitle ? options.draftTitle() : '窗边餐桌真香款',
        coverTitleParts: options.draftCover === undefined
          ? { primary: '小户型聚餐有招', secondary: '桌面拉开坐六人' }
          : (typeof options.draftCover === 'function' ? options.draftCover() : options.draftCover),
        note: options.draftNote !== undefined ? options.draftNote : '把参考里的沙发换成了餐桌，痛点精简为 1 个',
        segments: options.draftSegments
          ? options.draftSegments()
          : [
              { label: '钩子', text: poolEntry[0], refs: ['1'] },
              { label: '卖点', text: poolEntry[1], refs: ['2'] },
            ],
      };
    }
    if (system.includes('把AI写的东西改成真人')) {
      if (options.humanizeResult !== undefined) return options.humanizeResult;
      const body = request.userPrompt.match(/原文：\n([\s\S]*)$/)![1]!;
      return { text: body };
    }
    if (system.includes('带货口播文案审校')) {
      if (options.smoothResult !== undefined) return options.smoothResult;
      const body = request.userPrompt.match(/文案：\n([\s\S]*)$/)![1]!;
      return { text: body };
    }
    if (system.includes('文案修改说明的记录员')) {
      state.noteCount += 1;
      if (options.noteResult !== undefined) return options.noteResult;
      return { note: '替换了产品品类与人群，保留钩子到逼单结构' };
    }
    if (system.includes('标题编辑')) {
      state.titleRepairCount += 1;
      return options.titleRepairResult ?? {
        title: '修复后餐桌新标题',
        coverTitleParts: { primary: '朋友来家吃顿饭', secondary: '热锅放上岩板桌' },
        segments: [], fullScript: '错误修改正文',
      };
    }
    throw new Error(`未路由的 completeJson 请求：${system.slice(0, 40)}`);
  };
  return state;
}

function createRewriteTask(
  db: Database.Database,
  libraryRevisionId: string,
  templates: FrozenViralTemplateSpec[],
  requestKey: string,
  durationSec = 20,
  providerModel = 'fake-text-1',
): string {
  const requestedCount = templates.length;
  const inputSnapshot = {
    targetDurationSec: durationSec,
    requestedCount,
    creativeBrief: '',
    productionMode: 'template_rewrite',
    providerId: 'fake-text',
    providerModel,
    templatePlan: templatePlanOf(templates),
  };
  const task = createTask(db, {
    projectId: 'p1',
    requestKey,
    mode: 'reuse',
    libraryRevisionId,
    inputSnapshot,
    requestedCount,
  }, FIXED_NOW);
  return task.task.id;
}

function makeTaskDeps(
  db: Database.Database,
  taskId: string,
  llm: FakeLlm,
  requestedCount: number,
  signal?: AbortSignal,
): ScriptStudioRunDeps {
  const task = getTask(db, 'p1', taskId)!;
  const budget = createScriptRequestBudget({ db, taskId, requestedCount, now: FIXED_NOW });
  const generator = createScriptGenerator(llm.completeJson, { id: 'fake-text', model: (JSON.parse(task.inputSnapshotJson) as { providerModel: string }).providerModel }, { budget });
  return {
    db,
    projectId: 'p1',
    taskId,
    sourceSetId: null,
    libraryRevisionId: task.libraryRevisionId,
    inputSnapshot: JSON.parse(task.inputSnapshotJson) as Record<string, unknown>,
    visionExtractor,
    reprobe,
    generator,
    signal: signal ?? new AbortController().signal,
    now: FIXED_NOW,
  };
}

function savedRewriteContents(db: Database.Database): ScriptStudioScriptContent[] {
  const rows = db.prepare(`
    SELECT r.contentJson FROM project_script_revisions r
    JOIN project_scripts s ON s.id = r.scriptId
    WHERE s.projectId = 'p1' ORDER BY r.rowid
  `).all() as Array<{ contentJson: string }>;
  return rows.map((row) => JSON.parse(row.contentJson) as ScriptStudioScriptContent);
}

async function freshEnv(name: string): Promise<{ db: Database.Database; root: string }> {
  const root = fs.mkdtempSync(path.join(testRoot, `${name}-`));
  const db = createDb(root);
  await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: FIXED_NOW });
  return { db, root };
}

// ---------------------------------------------------------------------------
// S1：全链成功（A04/A06/A08/A11/A12/A14）
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s1');
  const library = await seedLibrary(db);
  const templates = [
    makeTemplate({ refText: LONG_REF, contentHash: 'hash-long', entryId: 'entry-long', sourceTemplateId: 'tpl-long' }),
    makeTemplate({ entryId: 'entry-2', sourceTemplateId: 'tpl-2', contentHash: 'hash-2', name: '第二模板' }),
  ];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s1');
  const llm = makeFakeLlm();
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  if (result.status !== 'succeeded') {
    const stages = getTask(db, 'p1', taskId)!.stages.map((s) => `${s.stage}:${s.status}:${s.errorCode ?? ''}:${s.payloadJson.slice(0, 300)}`);
    console.error('S1 stages:\n' + stages.join('\n'));
  }
  assert.equal(result.status, 'succeeded', `应全部成功：${result.errorMessage ?? ''}`);
  assert.equal(result.succeededCount, 2);

  // A06：筛选请求参考文本截断到前 600 字；候选只含 verified 且用户保留的卖点（含详解）。
  const filterCalls = llm.calls.filter((call) => call.systemPrompt?.includes('卖点甄别'));
  assert.equal(filterCalls.length, 2, '每个模板一次筛选');
  const longFilter = filterCalls[0]!;
  const refInPrompt = longFilter.userPrompt.match(/【参考文案】\n([\s\S]*?)\n\n【候选卖点】/)![1]!;
  assert.ok(refInPrompt.length <= 600, `筛选参考文本应截断到前 600 字，实际 ${refInPrompt.length}`);
  assert.ok(longFilter.userPrompt.includes('伸缩桌面（平时四人位不占地'), '候选含「标题（详解）」完整组');
  assert.ok(!longFilter.userPrompt.includes('未核验详解卖点'), 'detailStatus=unverified 不进候选');
  assert.ok(!longFilter.userPrompt.includes('用户排除卖点'), '用户排除不进候选');
  assert.ok(!longFilter.userPrompt.includes('证据失败卖点'), '证据失败不进候选');

  // A06：首稿收到完整参考全文、完整组详解、本模板白名单；含 TPL_GEN_HINT；无方向轮换。
  const draftCalls = llm.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家'));
  assert.ok(draftCalls.length >= 2);
  const firstDraft = draftCalls[0]!;
  assert.ok(firstDraft.userPrompt.includes(LONG_REF.slice(-60)), '首稿收到完整参考全文（非截断）');
  assert.ok(firstDraft.userPrompt.includes('痛点精简'), '首稿含 TPL_GEN_HINT 原约束');
  assert.ok(firstDraft.userPrompt.includes('"coverTitleParts"'), '首稿要求同时生成主副标题');
  assert.ok(firstDraft.userPrompt.includes('不能只写商品名或零部件名'), '封面主标题要求具体钩子');
  assert.ok(firstDraft.userPrompt.includes('【风格要求——照这个来】'), '首稿含风格分析要求');
  assert.ok(firstDraft.userPrompt.includes('伸缩桌面（平时四人位不占地，朋友来了拉出来秒变六人位）'), '首稿含完整组详解（免责/尾部标点净化后）');
  assert.ok(!firstDraft.userPrompt.includes('方向轮换') && !firstDraft.userPrompt.includes('必须行动号召'), '新模式不混入旧模式策略');

  // A12/A14：内容与元数据落库；说明不进口播；下游可读。
  const contents = savedRewriteContents(db);
  assert.equal(contents.length, 2);
  const first = contents.find((c) => c.templateRewrite?.sourceTemplateId === 'tpl-long')!;
  assert.equal(first.productionMode, 'template_rewrite');
  assert.equal(first.version, 4);
  assert.deepEqual(
    { primary: first.coverTitleParts.primary, secondary: first.coverTitleParts.secondary },
    { primary: '小户型聚餐有招', secondary: '桌面拉开坐六人' },
    '模板改写应保留生成的封面钩子和卖点，不能覆盖成商品名加空副标题',
  );
  const meta = first.templateRewrite!;
  assert.equal(meta.scriptCode, 'J1', '冻结编号必须穿过完整生成链路');
  assert.equal(meta.whitelistPointIds.length, 2, '白名单为筛选后的两个 verified 卖点');
  assert.equal(meta.targetChars, 120, '20 秒目标 120 中文字');
  assert.equal(meta.structureOrigin, 'fallback', '缺失结构如实标 fallback');
  assert.ok(meta.note.includes('沙发'), '修改说明落库');
  assert.equal(meta.noteMissing, false);
  assert.equal(meta.styleAnalysis?.['说话感觉'], '像朋友聊天', '风格分析结果落库');
  assert.ok(!first.fullScript.includes('修改说明'), '修改说明不进正文');
  assert.ok(!first.segments.some((seg) => seg.narration.includes('把参考里的沙发')), '修改说明不进任何分段');
  assert.ok(first.segments.every((seg) => seg.sellingPointIdRefs.length > 0), '每段都有事实引用');
  const readable = listReadableProjectScripts(db, 'p1', {});
  assert.equal(readable.length, 2, '下游统一读取可见');
  assert.ok(readable.every((row) => {
    const output = JSON.parse(row.outputJson) as ScriptStudioScriptContent;
    return output.version === 4 && output.segments.length > 0 && output.segments.every((seg) => seg.narration.trim().length > 0);
  }), '下游契约：version 4 + segments 非空 + 口播非空');

  // A08：写作字数口径（含标题、排除段名与说明；±15% 边界）。
  const cnCount = scriptCnLen(first.title, first.segments.map((seg) => ({ narration: seg.narration })));
  assert.deepEqual(charBoundsForTarget(120), { min: 102, max: 138 }, '20 秒 ±15% 边界');
  assert.ok(cnCount >= 102 && cnCount <= 138, `全链字数 ${cnCount} 应在 102-138`);

  // A11/A10：恢复不重复——再跑同任务，已完成模板全跳过，零新请求。
  const callsBefore = llm.calls.length;
  const again = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  assert.equal(again.status, 'succeeded');
  assert.equal(llm.calls.length, callsBefore, '恢复不应重新收费跑已完成模板');
  assert.equal(savedRewriteContents(db).length, 2, '恢复不重复保存');
  db.close();
}

// ---------------------------------------------------------------------------
// S2：筛选降级（keep 全非法保留全部合格卖点）与短参考跳过（A05/A06）
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s2');
  const library = await seedLibrary(db);
  const templates = [
    makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-empty-keep', contentHash: 'h-e1' }),
    makeTemplate({ entryId: 'e2', sourceTemplateId: 'tpl-short', contentHash: 'h-e2', refText: '标题：短参考\n正文：适配不同场景' }),
  ];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s2');
  const llm = makeFakeLlm({ filterKeep: { keep: ['99', 'abc'] } });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  assert.equal(result.status, 'succeeded', `降级应仍可完成：${result.errorMessage ?? ''}`);
  const contents = savedRewriteContents(db);
  const degraded = contents.find((c) => c.templateRewrite?.sourceTemplateId === 'tpl-empty-keep')!;
  assert.equal(degraded.templateRewrite!.filterDegraded, '筛选无有效结果，保留全部合格卖点');
  assert.equal(degraded.templateRewrite!.whitelistPointIds.length, 2, '降级保留全部合格卖点（2 个 verified）');
  const shortRef = contents.find((c) => c.templateRewrite?.sourceTemplateId === 'tpl-short')!;
  assert.equal(shortRef.templateRewrite!.filterDegraded, '参考文案过短，按源规则跳过筛选，使用全部合格卖点');
  assert.equal(shortRef.templateRewrite!.styleDegraded, '参考文案过短，按源规则跳过风格分析，使用文风预设');
  assert.equal(llm.calls.filter((call) => call.systemPrompt?.includes('卖点甄别')).length, 1, '短参考模板不发筛选请求');
  assert.equal(llm.calls.filter((call) => call.systemPrompt?.includes('天天刷带货视频')).length, 1, '短参考模板不发风格分析请求');
  db.close();
}

// ---------------------------------------------------------------------------
// S3：字数修复一致性——带当前稿件、保留 TPL_GEN_HINT、用冻结白名单（A07/A08）
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s3');
  const library = await seedLibrary(db);
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s3', contentHash: 'h-s3' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s3', 60); // 60 秒 → 360 字目标
  let draftN = 0;
  const llm = makeFakeLlm({
    draftSegments: () => {
      draftN += 1;
      return draftN === 1
        ? [{ label: '钩子', text: '短稿只有几十个字', refs: ['1'] }]
        : [
            { label: '钩子', text: SEG_OK_1.repeat(3), refs: ['1'] },
            { label: '卖点', text: SEG_OK_2.repeat(3), refs: ['2'] },
            { label: '逼单', text: SEG_OK_1, refs: ['1'] },
          ];
    },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `字数修复后应成功：${result.errorMessage ?? ''}`);
  const draftCalls = llm.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家'));
  assert.ok(draftCalls.length >= 2, '首稿字数不足触发定向修正');
  const fixCall = draftCalls[1]!;
  assert.ok(fixCall.userPrompt.includes('【字数修正】当前约'), '修正请求带当前字数');
  assert.ok(fixCall.userPrompt.includes('【当前稿件——在它的基础上修正'), '修正请求带当前稿件（源缺陷修复）');
  assert.ok(fixCall.userPrompt.includes('痛点精简'), '修正保留 TPL_GEN_HINT 原约束（源缺陷修复）');
  assert.ok(fixCall.userPrompt.includes('伸缩桌面（'), '修正用冻结白名单卖点（源缺陷修复）');
  assert.ok(!fixCall.userPrompt.includes('未核验详解卖点'), '修正不扩回全库');
  const content = savedRewriteContents(db)[0]!;
  assert.equal(content.templateRewrite!.targetChars, 360, '60 秒目标 360 中文字');
  db.close();
}

// ---------------------------------------------------------------------------
// S4：预算调度（每方案上限、失败计入、耗尽不再请求、可选阶段降级）（A09/A14）
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s4');
  const library = await seedLibrary(db);
  process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_TEXT_REQUESTS_PER_PROPOSAL = '3';
  try {
    const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s4', contentHash: 'h-s4' })];
    const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s4');
    const llm = makeFakeLlm({ draftNote: '' });
    const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
    assert.equal(result.status, 'succeeded', `核心链在预算内应完成：${result.errorMessage ?? ''}`);
    // 筛选1 + 风格1 + 首稿1 = 3 次用尽；humanize/smooth/note 全部预算耗尽降级。
    assert.equal(llm.calls.length, 3, `预算耗尽后不再请求，实际 ${llm.calls.length} 次`);
    const content = savedRewriteContents(db)[0]!;
    assert.ok(content.templateRewrite!.humanizeDegraded.includes('预算'), '去 AI 味预算不足降级并记录');
    assert.ok(content.templateRewrite!.smoothDegraded.includes('预算'), '朗读检查预算不足降级并记录');
    assert.equal(content.templateRewrite!.noteMissing, true, '说明缺失如实标记（不伪造）');
    assert.equal(content.templateRewrite!.note, '', '说明缺失不补假内容');
  } finally {
    delete process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_TEXT_REQUESTS_PER_PROPOSAL;
  }
  db.close();
}

// ---------------------------------------------------------------------------
// S5：参考产品信息残留检查（A07）：修复成功可保存；仍残留则该模板失败
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s5a');
  const library = await seedLibrary(db);
  const residualSentence = '谁说小房子不配拥有大餐桌我家这款伸缩餐桌平时就收起来';
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s5', contentHash: 'h-s5' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s5a');
  let draftN = 0;
  const llm = makeFakeLlm({
    draftSegments: () => {
      draftN += 1;
      // 首稿字数落在区间内（避免先走字数修复），且含参考原文残留句；末段带逼单段名避免触发结尾修复。
      return draftN === 1
        ? [
            { label: '钩子', text: residualSentence + SEG_OK_1, refs: ['1'] },
            { label: '逼单', text: SEG_OK_2, refs: ['2'] },
          ]
        : [
            { label: '钩子', text: SEG_OK_1, refs: ['1'] },
            { label: '逼单', text: SEG_OK_2, refs: ['2'] },
          ];
    },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `残留修复后应成功：${result.errorMessage ?? ''}`);
  const repairCalls = llm.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家') && call.userPrompt.includes('参考产品信息残留'));
  assert.equal(repairCalls.length, 1, '残留触发一次定向修复');
  assert.ok(repairCalls[0]!.userPrompt.includes('【当前稿件'), '残留修复带当前稿');
  assert.ok(!savedRewriteContents(db)[0]!.fullScript.includes(residualSentence), '保存结果无残留');
  db.close();
}
{
  const { db } = await freshEnv('s5b');
  const library = await seedLibrary(db);
  const residualSentence = '谁说小房子不配拥有大餐桌我家这款伸缩餐桌平时就收起来';
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s5b', contentHash: 'h-s5b' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s5b');
  const llm = makeFakeLlm({
    draftSegments: () => [
      { label: '钩子', text: residualSentence + SEG_OK_1, refs: ['1'] },
      { label: '逼单', text: SEG_OK_2, refs: ['2'] },
    ],
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'failed', '修复后仍残留不得保存');
  assert.equal(savedRewriteContents(db).length, 0, '残留未清不保存');
  const taskRow = getTask(db, 'p1', taskId)!;
  assert.ok((taskRow.errorMessage ?? '').includes('residual'), `错误能定位实际阶段（残留检查），实际：${taskRow.errorMessage}`);
  db.close();
}

// ---------------------------------------------------------------------------
// S6：合格卖点收口（A05）：全部缺详解/未核验 → 任务失败并给出原因
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s6');
  db.prepare(`
    INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
    VALUES ('source-1', 'p1', 'fp-1', '[]', '2026-09-17T00:00:10.000Z')
  `).run();
  const library = createLibraryRevision(db, {
    projectId: 'p1',
    sourceSetId: 'source-1',
    sourceFingerprint: 'fp-1',
    sellingPoints: [
      {
        title: '缺详解卖点', factText: '普通事实', pointType: 'other',
        evidenceQuote: '普通事实', sourcePageIndex: 0, tileRefs: ['1'],
        usable: true, // detailStatus=missing
      },
      {
        title: '无据详解卖点', factText: '另一事实', pointType: 'other',
        evidenceQuote: '另一事实', sourcePageIndex: 0, tileRefs: ['2'],
        detailText: '承重 999kg', // unverified
        usable: true,
      },
    ],
  }, FIXED_NOW);
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s6', contentHash: 'h-s6' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s6');
  const llm = makeFakeLlm();
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'evidence_insufficient');
  assert.ok(result.errorMessage!.includes('详解'), '失败原因指向详解缺失/未核验');
  assert.equal(llm.calls.length, 0, '无合格卖点不发任何模型请求');
  db.close();
}

// ---------------------------------------------------------------------------
// S7：幂等与身份（A03/A10）：同 key 重送一个任务；模板计划变更不同 key；同 key 不同计划冲突
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s7');
  const library = await seedLibrary(db);
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s7', contentHash: 'h-s7' })];
  const snapshot = {
    targetDurationSec: 20,
    requestedCount: 1,
    creativeBrief: '',
    productionMode: 'template_rewrite',
    providerId: 'fake-text',
    providerModel: 'fake-text-1',
    templatePlan: templatePlanOf(templates),
  };
  const first = createTask(db, { projectId: 'p1', requestKey: 'tpl-idem-1', mode: 'reuse', libraryRevisionId: library.id, inputSnapshot: snapshot, requestedCount: 1 }, FIXED_NOW);
  assert.equal(first.created, true);
  const replay = createTask(db, { projectId: 'p1', requestKey: 'tpl-idem-1', mode: 'reuse', libraryRevisionId: library.id, inputSnapshot: snapshot, requestedCount: 1 }, FIXED_NOW);
  assert.equal(replay.created, false, '同动作重送只建一个任务');
  assert.equal(replay.task.id, first.task.id);
  let conflict: unknown;
  try {
    createTask(db, {
      projectId: 'p1', requestKey: 'tpl-idem-1', mode: 'reuse', libraryRevisionId: library.id,
      inputSnapshot: { ...snapshot, templatePlan: templatePlanOf([makeTemplate({ entryId: 'e2', sourceTemplateId: 'tpl-other', contentHash: 'h-other' })]) },
      requestedCount: 1,
    }, FIXED_NOW);
  } catch (error) { conflict = error; }
  assert.ok(conflict instanceof Error && (conflict as { code?: string }).code === 'conflict', '同 key 改模板计划返回冲突');
  const keyA = createScriptStudioTaskRequestKey({
    projectId: 'p1', mode: 'reuse', libraryRevisionId: library.id, targetDurationSec: 20, requestedCount: 1,
    providerId: 'fake-text', providerModel: 'fake-text-1', productionMode: 'template_rewrite',
    templatePlanFingerprint: templatePlanOf(templates).fingerprint,
  });
  const keyB = createScriptStudioTaskRequestKey({
    projectId: 'p1', mode: 'reuse', libraryRevisionId: library.id, targetDurationSec: 20, requestedCount: 1,
    providerId: 'fake-text', providerModel: 'fake-text-1', productionMode: 'template_rewrite',
    templatePlanFingerprint: templatePlanOf([makeTemplate({ entryId: 'e2', sourceTemplateId: 'tpl-other', contentHash: 'h-other' })]).fingerprint,
  });
  assert.notEqual(keyA, keyB, '模板计划不同派生 key 不同');
  const keyC = createScriptStudioTaskRequestKey({
    projectId: 'p1', mode: 'reuse', libraryRevisionId: library.id, targetDurationSec: 20, requestedCount: 1,
    providerId: 'fake-text', providerModel: 'fake-text-1',
  });
  assert.notEqual(keyA, keyC, '新模式与旧模式不共用 key');
  db.close();
}

// ---------------------------------------------------------------------------
// S8：部分完成与恢复（A11）：失败模板不丢成功项；恢复不重复已保存模板
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s8');
  const library = await seedLibrary(db);
  const templates = [
    makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-ok', contentHash: 'h-ok', name: '成功模板' }),
    makeTemplate({ entryId: 'e2', sourceTemplateId: 'tpl-fail', contentHash: 'h-fail', name: '失败模板', refText: '标题：会失败的参考\n正文：会失败的参考文案内容，这段文字专门用来让生成失败。朋友聚餐一拉就开，坐六七个人都不挤。' }),
  ];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s8');
  const llm = makeFakeLlm({ failDraftFor: '会失败的参考' });
  const first = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  assert.equal(first.status, 'partial', '一条失败不拖垮成功项');
  assert.equal(first.succeededCount, 1);
  const partialContents = savedRewriteContents(db);
  assert.equal(partialContents.length, 1, '成功结果立即可读');
  assert.equal(partialContents[0]!.templateRewrite!.sourceTemplateId, 'tpl-ok');
  // 恢复：失败模板变为可成功；成功模板零新请求。
  // 注意预算语义：第一次运行的失败请求也计入方案余额（筛选1+风格1+首稿2失败=4），
  // 恢复时正文用不同文本池且标题不冲突，避免必需的标题修复占用剩余余额。
  const llm2 = makeFakeLlm({ initialDraftIndex: 1, draftTitle: () => '岩板餐桌也好香',
    draftCover: { primary: '朋友来家吃顿饭', secondary: '热锅放上岩板桌' } });
  const second = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm2, 2));
  if (second.status !== 'succeeded') {
    const stages = getTask(db, 'p1', taskId)!.stages.map((s) => `${s.stage}:${s.status}:${s.payloadJson.slice(0, 400)}`);
    console.error('S8 stages:\n' + stages.join('\n'));
  }
  assert.equal(second.status, 'succeeded');
  const draftCalls2 = llm2.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家'));
  assert.ok(draftCalls2.length > 0 && draftCalls2.every((call) => call.userPrompt.includes('会失败的参考')), '恢复只跑未完成模板');
  assert.equal(savedRewriteContents(db).length, 2, '恢复不重复保存已完成模板');
  assert.ok(second.scriptIds.includes(first.scriptIds[0]!), '部分成功的原脚本身份保留');
  assert.deepEqual(savedRewriteContents(db)[0], partialContents[0], '恢复不改写已经保存的正文和白名单');
  assert.equal(llm2.calls.filter(c => /卖点甄别|天天刷带货视频/.test(c.systemPrompt)).length, 0, '部分失败后的检查点仍保留，筛选与风格不重复收费');
  const resumedBudget = createScriptRequestBudget({ db, taskId, requestedCount: 2 });
  assert.ok(resumedBudget.usedFor(2) > llm2.calls.length, '失败调用和恢复调用共同占用原方案预算');
  db.close();
}

// ---------------------------------------------------------------------------
// S9：标题修复占用预算且只修标题字段（A09）
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s9');
  const library = await seedLibrary(db);
  const priorTaskId = createRewriteTask(db, library.id, [makeTemplate({ entryId: 'e0', sourceTemplateId: 'tpl-prior', contentHash: 'h-prior' })], 'tpl-task-prior');
  const llmPrior = makeFakeLlm({ draftTitle: () => '窗边餐桌真香款' });
  await executeScriptStudioTask(makeTaskDeps(db, priorTaskId, llmPrior, 1));
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s9', contentHash: 'h-s9' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s9');
  const llm = makeFakeLlm({ draftTitle: () => '窗边餐桌真香款' });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `标题修复后应成功：${result.errorMessage ?? ''}`);
  assert.equal(llm.titleRepairCount, 1, '标题冲突触发一次标题修复');
  const saved = savedRewriteContents(db).find((c) => c.templateRewrite?.sourceTemplateId === 'tpl-s9')!;
  assert.equal(saved.title, '修复后餐桌新标题', '只替换标题字段');
  assert.equal(saved.coverTitleParts.primary, '小户型聚餐有招', '封面组合重复只修副标题，保留合格主标题');
  assert.equal(saved.coverTitleParts.secondary, '热锅放上岩板桌', '封面组合重复也触发修复');
  assert.ok(saved.fullScript.includes(SEG_OK_1.slice(0, 10)), '标题修复不改正文');
  assert.equal(saved.templateRewrite!.note.includes('沙发'), true, '标题修复不丢修改说明');
  db.close();
}

// S10：模型漏返封面或仅返回商品名时，真实 runner 必须修复，且保持方案名和正文。
for (const draftCover of [null, { primary: '林氏伸缩岩板餐桌', secondary: '' }]) {
  const { db } = await freshEnv('cover-repair');
  const library = await seedLibrary(db);
  const taskId = createRewriteTask(db, library.id, [makeTemplate()], 'cover-repair');
  const llm = makeFakeLlm({ draftCover });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', result.errorMessage ?? '封面缺失应修复');
  assert.equal(llm.titleRepairCount, 1);
  const saved = savedRewriteContents(db)[0]!;
  assert.equal(saved.title, '窗边餐桌真香款', '封面修复不得改动合格方案名');
  assert.equal(saved.coverTitleParts.primary, '朋友来家吃顿饭');
  assert.equal(saved.coverTitleParts.secondary, '热锅放上岩板桌');
  assert.equal(saved.fullScript, `${SEG_OK_1}\n${SEG_OK_2}`, '封面修复不得改正文');
  assert.ok(saved.segments.every((seg) => seg.sellingPointIdRefs.length > 0));
  const missing = validateScriptContent({ ...saved, coverTitleParts: { ...saved.coverTitleParts, secondary: '' } }, { libraryRevision: library });
  assert.ok(missing.titleIssues.some((issue) => issue.code === 'cover_title_required'), '模板模式正常校验也不能跳过封面');
  const unsupported = validateScriptContent({ ...saved, coverTitleParts: { ...saved.coverTitleParts, secondary: '承重五百公斤' } }, { libraryRevision: library });
  assert.ok(unsupported.titleIssues.some((issue) => issue.code === 'title_unsupported_fact'), '封面事实必须受已引用事实约束');
  db.close();
}

// S11：修复仍缺封面时有界失败，不得把商品名/空副标题作为合格结果保存。
{
  const { db } = await freshEnv('cover-failed');
  const library = await seedLibrary(db);
  const taskId = createRewriteTask(db, library.id, [makeTemplate()], 'cover-failed');
  const llm = makeFakeLlm({ draftCover: null, titleRepairResult: { title: '无关标题修改' } });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'failed');
  assert.equal(llm.titleRepairCount, 2, '封面最多修复两次');
  assert.equal(savedRewriteContents(db).length, 0);
  db.close();
}

// ---------------------------------------------------------------------------
// S12：结尾缺失定向修复（2026-09-18 质量修复）：缺结尾段 → 带参考末句修复一次后保存
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s12');
  const library = await seedLibrary(db);
  const templates = [makeTemplate({ entryId: 'e1', sourceTemplateId: 'tpl-s12', contentHash: 'h-s12' })];
  const taskId = createRewriteTask(db, library.id, templates, 'tpl-task-s12');
  let draftN = 0;
  const llm = makeFakeLlm({
    draftSegments: () => {
      draftN += 1;
      return draftN === 1
        ? [
            { label: '钩子', text: SEG_OK_1, refs: ['1'] },
            { label: '卖点', text: SEG_OK_2, refs: ['2'] },
          ]
        : [
            { label: '钩子', text: SEG_OK_1, refs: ['1'] },
            { label: '逼单', text: SEG_OK_2, refs: ['2'] },
          ];
    },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `结尾修复后应成功：${result.errorMessage ?? ''}`);
  const endingRepairs = llm.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家') && call.userPrompt.includes('缺少结尾段'));
  assert.equal(endingRepairs.length, 1, '缺结尾触发一次定向修复');
  assert.ok(endingRepairs[0]!.userPrompt.includes('真心推荐'), '结尾修复带参考文案末句锚点');
  assert.ok(endingRepairs[0]!.userPrompt.includes('【当前稿件'), '结尾修复带当前稿');
  const saved = savedRewriteContents(db)[0]!;
  assert.ok(saved.segments.at(-1)!.narration.includes(SEG_OK_2.slice(0, 8)), '修复后的结尾段落库');
  db.close();
}

// ---------------------------------------------------------------------------
// S13：同模板多条变体差异化（2026-09-18 质量修复）：
// 同 entryId 变体串行生成，第二稿 prompt 必须带第一稿正文做差异化。
// ---------------------------------------------------------------------------
{
  const { db } = await freshEnv('s13');
  const library = await seedLibrary(db);
  const shared = makeTemplate({ entryId: 'entry-shared', sourceTemplateId: 'tpl-shared', contentHash: 'h-shared' });
  const taskId = createRewriteTask(db, library.id, [shared, { ...shared }], 'tpl-task-s13');
  // 标题/封面避开数字（无据数字会触发 title_unsupported_fact），保证两变体互不冲突。
  const titlePool = ['窗边餐桌真香款', '岩板餐桌也好香'];
  const coverPool = [
    { primary: '朋友聚餐有妙招', secondary: '拉开桌面坐六人' },
    { primary: '小户型也有办法', secondary: '岩板台面好打理' },
  ];
  let draftN = 0;
  const llm = makeFakeLlm({
    draftTitle: () => titlePool[draftN % titlePool.length]!,
    draftCover: () => coverPool[draftN % coverPool.length]!,
    draftSegments: () => {
      const [hook, cta] = DRAFT_TEXT_POOL[draftN % DRAFT_TEXT_POOL.length]!;
      draftN += 1;
      return [
        { label: '钩子', text: hook, refs: ['1'] },
        { label: '逼单', text: cta, refs: ['2'] },
      ];
    },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  if (result.status !== 'succeeded') {
    const stages = getTask(db, 'p1', taskId)!.stages.map((s) => `${s.stage}:${s.status}:${s.errorCode ?? ''}:${s.payloadJson.slice(0, 400)}`);
    console.error('S13 stages:\n' + stages.join('\n'));
  }
  assert.equal(result.status, 'succeeded', `同模板两条应成功：${result.errorMessage ?? ''}`);
  assert.equal(result.succeededCount, 2);
  const draftCalls = llm.calls.filter((call) => call.systemPrompt?.includes('带货文案改写专家'));
  assert.equal(draftCalls.length, 2, '两个变体各一次首稿（无修复干扰）');
  assert.ok(!draftCalls[0]!.userPrompt.includes('同模板已生成变体'), '第一稿不带差异化段');
  assert.ok(draftCalls[1]!.userPrompt.includes('同模板已生成变体'), '第二稿带差异化段');
  assert.ok(draftCalls[1]!.userPrompt.includes('窗边餐桌真香款'), '第二稿收到第一稿标题');
  assert.ok(draftCalls[1]!.userPrompt.includes(DRAFT_TEXT_POOL[0]![0].slice(0, 10)), '第二稿收到第一稿正文摘录');
  db.close();
}

// 重复首稿必须触发有界改写，修后仍重复不得保存第二条。
for (const stubborn of [false, true]) {
  const { db } = await freshEnv(`s14-${stubborn}`);
  const library = await seedLibrary(db);
  const shared = makeTemplate();
  const taskId = createRewriteTask(db, library.id, [shared, { ...shared }], `s14-${stubborn}`);
  let draftN = 0;
  const llm = makeFakeLlm({
    draftTitle: () => draftN === 0 ? '窗边餐桌真香款' : '岩板餐桌也好香',
    draftCover: () => draftN === 0
      ? { primary: '朋友聚餐有妙招', secondary: '拉开桌面坐六人' }
      : { primary: '小户型也有办法', secondary: '岩板台面好打理' },
    draftSegments: () => {
      const textIndex = stubborn || draftN < 2 ? 0 : 1;
      draftN++;
      return [{ label: '钩子', text: DRAFT_TEXT_POOL[textIndex]![0], refs: ['1'] },
        { label: '逼单', text: DRAFT_TEXT_POOL[textIndex]![1], refs: ['2'] }];
    },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  assert.equal(result.succeededCount, stubborn ? 1 : 2, '重复稿只在修正后保存');
  assert.equal(draftN, 3, '第二条只允许一次差异化修复');
  assert.ok(llm.calls.some(c => c.userPrompt.includes('当前正文与同模板已有变体过于相似')));
  assert.ok(llm.calls.filter(c => c.systemPrompt.includes('带货文案改写专家'))[1]!.userPrompt.includes('优先围绕卖点 2'));
  db.close();
}

// 口播审校可修副标题，只允许它承接主标题，其他标题字段不能被响应覆盖。
{
  const { db } = await freshEnv('s15');
  const library = await seedLibrary(db);
  const taskId = createRewriteTask(db, library.id, [makeTemplate()], 's15');
  const llm = makeFakeLlm({
    draftSegments: () => [{ label: '钩子', text: SEG_OK_1, refs: ['1'] }, { label: '逼单', text: SEG_OK_2, refs: ['2'] }],
    smoothResult: { text: `【钩子】${SEG_OK_1}\n【逼单】${SEG_OK_2}`, coverSecondary: '伸缩桌面好聚餐', title: '不要改标题', coverTitleParts: { primary: '不要改主标题' } },
  });
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.succeededCount, 1);
  const [content] = savedRewriteContents(db);
  assert.equal(content!.title, '窗边餐桌真香款');
  assert.equal(content!.coverTitleParts.primary, '小户型聚餐有招');
  assert.equal(content!.coverTitleParts.secondary, '伸缩桌面好聚餐');
  db.close();
}

// 段名括号不得经首稿/去 AI 味/朗读检查流入口播、字幕或持久化正文。
for (const stage of ['draft', 'humanize', 'smooth']) {
  const { db } = await freshEnv(`brackets-${stage}`);
  try {
    const library = await seedLibrary(db);
    const taskId = createRewriteTask(db, library.id, [makeTemplate()], `brackets-${stage}`);
    const nestedText = `【【钩子】】${SEG_OK_1}\n【【逼单】】${SEG_OK_2}`;
    const llm = makeFakeLlm({
      draftSegments: () => [
        { label: stage === 'draft' ? '【钩子】' : '钩子', text: SEG_OK_1, refs: ['1'] },
        { label: stage === 'draft' ? '【逼单】' : '逼单', text: SEG_OK_2, refs: ['2'] },
      ],
      ...(stage === 'humanize' ? { humanizeResult: { text: nestedText } } : {}),
      ...(stage === 'smooth' ? { smoothResult: { text: nestedText } } : {}),
    });
    const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
    assert.equal(result.succeededCount, 1);
    const [content] = savedRewriteContents(db);
    assert.equal(content!.fullScript, `${SEG_OK_1}\n${SEG_OK_2}`, `${stage} 的嵌套标签不能污染保存正文`);
    assert.deepEqual(content!.segments.map(s => s.narration), [SEG_OK_1, SEG_OK_2]);
    assert.ok(content!.segments.every(s => !/[【】]/.test(s.subtitle)));
    assert.equal(content!.templateRewrite!.humanizeDegraded, '');
    assert.equal(content!.templateRewrite!.smoothDegraded, '');
  } finally {
    db.close();
  }
}

// 在真实 generator 发出检查点后中断，保持其原有持久化和预算路径。
async function interruptRewrite(
  db: Database.Database, taskId: string, llm: FakeLlm, after: 'filter' | 'style',
): Promise<void> {
  const controller = new AbortController();
  const deps = makeTaskDeps(db, taskId, llm, 1, controller.signal);
  const run = deps.generator.runTemplateRewrite!.bind(deps.generator);
  deps.generator.runTemplateRewrite = (input) => run({ ...input, onStateChange(next) {
    input.onStateChange?.(next);
    if (after === 'filter' || next.styleAnalysis !== undefined) {
      controller.abort();
      throw new DOMException('模拟检查点后停机', 'AbortError');
    }
  } });
  await executeScriptStudioTask(deps);
  assert.equal(getTask(db, 'p1', taskId)!.status, 'queued');
  assert.equal(savedRewriteContents(db).length, 0);
}

function rewriteCheckpoint(db: Database.Database, taskId: string): Record<string, unknown> {
  return JSON.parse(getTask(db, 'p1', taskId)!.stages.find(s => s.stage === 'generate')!.payloadJson) as Record<string, unknown>;
}

// undefined 会继续分析，null 保持已完成的降级；成功缓存不能覆盖已完成的 null。
for (const styleState of ['unstarted', 'success', 'degraded', 'legacy'] as const) {
  const { db } = await freshEnv(`resume-${styleState}`);
  const library = await seedLibrary(db);
  const template = makeTemplate();
  const taskId = createRewriteTask(db, library.id, [template], `resume-${styleState}`);
  const firstLlm = makeFakeLlm({ ...(styleState === 'degraded' ? { styleResult: {} } : {}) });
  await interruptRewrite(db, taskId, firstLlm, styleState === 'unstarted' ? 'filter' : 'style');
  if (styleState === 'legacy') {
    mergeStagePayload(db, 'p1', taskId, 'generate', { templateExecutionIdentity: undefined }, FIXED_NOW);
  }
  if (styleState === 'degraded') {
    const { writeViralTemplateStyleCache } = await import('../lib/script-studio/viral-templates.ts');
    const { TEMPLATE_REWRITE_VERSION } = await import('../lib/script-studio/template-rewrite.ts');
    writeViralTemplateStyleCache(db, { contentHash: template.contentHash, model: 'fake-text-1',
      promptVersion: TEMPLATE_REWRITE_VERSION, analysisJson: JSON.stringify({ 说话感觉: '不应覆盖已降级的检查点' }) });
  }
  const llm = makeFakeLlm();
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `${styleState}: ${result.errorMessage}`);
  assert.equal(llm.calls.filter(c => c.systemPrompt.includes('卖点甄别')).length, 0, '已完成筛选不重复收费');
  assert.equal(llm.calls.filter(c => c.systemPrompt.includes('天天刷带货视频')).length, styleState === 'unstarted' ? 1 : 0);
  const budget = createScriptRequestBudget({ db, taskId, requestedCount: 1 });
  assert.equal(budget.taskTextUsed(), firstLlm.calls.length + llm.calls.length, '检查点恢复沿用原请求预算');
  if (styleState === 'degraded') assert.equal(savedRewriteContents(db)[0]!.templateRewrite!.styleAnalysis, null);
  db.close();
}

// 跨快照的旧检查点不能当作当前筛选结果；共享风格缓存仅由内容哈希+实际模型+提示词版本复用。
for (const change of ['providerModel', 'contentHash', 'structure'] as const) {
  const { db } = await freshEnv(`identity-${change}`);
  const library = await seedLibrary(db);
  const template = makeTemplate();
  const oldTask = createRewriteTask(db, library.id, [template], `old-${change}`);
  await interruptRewrite(db, oldTask, makeFakeLlm(), 'style');
  const changedTemplate = change === 'contentHash'
    ? { ...template, contentHash: 'different-content-hash', refText: template.refText + '换一种讲法。' }
    : change === 'structure' ? { ...template, structure: '场景 → 卖点 → 行动' } : template;
  const model = change === 'providerModel' ? 'fake-text-2' : 'fake-text-1';
  const taskId = createRewriteTask(db, library.id, [changedTemplate], `new-${change}`, 20, model);
  // 使用领域持久化函数注入旧检查点，模拟恢复读到不匹配快照，无复制 schema/SQL。
  mergeStagePayload(db, 'p1', taskId, 'generate', rewriteCheckpoint(db, oldTask), FIXED_NOW);
  const llm = makeFakeLlm();
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 1));
  assert.equal(result.status, 'succeeded', `${change}: ${result.errorMessage}`);
  assert.equal(llm.calls.filter(c => c.systemPrompt.includes('卖点甄别')).length, 1, `${change} 变化使旧筛选检查点失效`);
  assert.equal(llm.calls.filter(c => c.systemPrompt.includes('天天刷带货视频')).length, change === 'structure' ? 0 : 1,
    `${change} 必须按实际模型与内容哈希匹配风格缓存`);
  const { readViralTemplateStyleCache } = await import('../lib/script-studio/viral-templates.ts');
  const { TEMPLATE_REWRITE_VERSION } = await import('../lib/script-studio/template-rewrite.ts');
  assert.ok(readViralTemplateStyleCache(db, template.contentHash, 'fake-text-1', TEMPLATE_REWRITE_VERSION), '旧缓存不被覆盖');
  assert.ok(readViralTemplateStyleCache(db, changedTemplate.contentHash, model, TEMPLATE_REWRITE_VERSION), '新身份缓存独立保存');
  db.close();
}

// 恢复后的筛选白名单同时约束标题修复上下文与最终落库；包外引用不能靠扩大元数据通过。
for (const outsideRef of [false, true]) {
  const { db } = await freshEnv(`whitelist-${outsideRef}`);
  const library = await seedLibrary(db);
  const taskId = createRewriteTask(db, library.id, [makeTemplate()], `whitelist-${outsideRef}`);
  await interruptRewrite(db, taskId, makeFakeLlm({ filterKeep: { keep: ['1'] } }), 'style');
  const llm = makeFakeLlm({
    draftCover: null,
    draftSegments: () => [
      { label: '钩子', text: SEG_OK_1, refs: ['1'] },
      { label: '逼单', text: '桌面收起来，家里走动也自在。朋友过来聚餐时再把桌面拉开，四人位变六人位，围坐聊天不用为座位发愁。想给家里添一张伸缩餐桌，就去看看吧。', refs: ['1'] },
    ],
    titleRepairResult: { coverTitleParts: { primary: '朋友来家吃顿饭', secondary: '桌面拉开坐六人' } },
  });
  const deps = makeTaskDeps(db, taskId, llm, 1);
  const run = deps.generator.runTemplateRewrite!.bind(deps.generator);
  deps.generator.runTemplateRewrite = async (input) => {
    const result = await run(input);
    if (outsideRef) {
      result.content.templateRewrite = { ...result.content.templateRewrite!,
        whitelistPointIds: [...result.content.templateRewrite!.whitelistPointIds, library.sellingPoints[1]!.id] };
      result.content.segments[0]!.sellingPointIdRefs = [library.sellingPoints[1]!.id];
    }
    return result;
  };
  const repair = deps.generator.repairTitles!.bind(deps.generator);
  let repairs = 0;
  deps.generator.repairTitles = (input) => {
    repairs++;
    assert.deepEqual(input.brief.requiredPointIds, [library.sellingPoints[0]!.id]);
    assert.deepEqual(input.brief.optionalPointIds, []);
    return repair(input);
  };
  const result = await executeScriptStudioTask(deps);
  assert.equal(result.status, outsideRef ? 'failed' : 'succeeded', result.errorMessage);
  const saved = savedRewriteContents(db);
  assert.equal(saved.length, outsideRef ? 0 : 1, '包外引用不得保存');
  if (!outsideRef) {
    assert.equal(repairs, 1);
    assert.deepEqual(saved[0]!.templateRewrite!.whitelistPointIds, [library.sellingPoints[0]!.id]);
    assert.ok(saved[0]!.segments.every(s => s.sellingPointIdRefs.every(id => id === library.sellingPoints[0]!.id)));
  }
  db.close();
}

// 同模板第一条失败后，后续变体仍执行；失败 promise 不得阻断模板串行链。
{
  const { db } = await freshEnv('same-template-failure');
  const library = await seedLibrary(db);
  const template = makeTemplate();
  const taskId = createRewriteTask(db, library.id, [template, { ...template }], 'same-template-failure');
  const llm = makeFakeLlm();
  const complete = llm.completeJson;
  let failedDrafts = 0;
  llm.completeJson = async (request) => {
    if (request.systemPrompt.includes('带货文案改写专家') && failedDrafts++ < 2) {
      llm.calls.push(request);
      throw new Error('第一变体的首稿失败');
    }
    return complete(request);
  };
  const result = await executeScriptStudioTask(makeTaskDeps(db, taskId, llm, 2));
  assert.equal(result.status, 'partial');
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(savedRewriteContents(db).length, 1);
  db.close();
}

// 调用时排队、真正执行时取标题：等待期间保存的标题必须进入下一变体的 prompt。
{
  const { createTemplateRewriteExecution } = await import('../lib/script-studio/template-rewrite-execution.ts');
  const { db } = await freshEnv('queued-title-context');
  const library = await seedLibrary(db);
  const template = makeTemplate();
  const taskId = createRewriteTask(db, library.id, [template, { ...template }], 'queued-title-context');
  const deps = makeTaskDeps(db, taskId, makeFakeLlm(), 2);
  const savedScripts: ScriptStudioScriptContent[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
  const original = deps.generator.runTemplateRewrite!.bind(deps.generator);
  deps.generator.runTemplateRewrite = async (input) => {
    if (input.plan.index === 1) {
      announceFirst();
      await firstGate;
    } else {
      assert.deepEqual(input.previousTitles.map(t => t.title), ['排队期间保存的标题', '项目历史标题']);
      assert.equal(input.siblingVariantTexts?.length, 1, '同模板的前一变体正文也在执行时读取');
    }
    const result = await original(input);
    if (input.plan.index === 1) {
      // 模拟 runner/其他并发方案在等待期间追加已保存结果；复用真实生成的内容形状。
      savedScripts.push({ ...result.content, title: '排队期间保存的标题' });
    }
    return result;
  };
  const execution = createTemplateRewriteExecution({
    db, projectId: 'p1', taskId, inputSnapshot: deps.inputSnapshot, libraryRevision: library,
    eligiblePoints: library.sellingPoints.slice(0, 2), generator: deps.generator,
    savedScripts, recentTitles: [{ title: '项目历史标题', coverTitleParts: { primary: '', secondary: '' } }],
    now: FIXED_NOW,
  });
  const plan = { index: 1, templateId: 'viral:test', templateName: '模板', templateVersion: 1,
    rationale: '', direction: 'template_rewrite', angle: '', templateRewrite: template };
  const brief = { planIndex: 1, templateId: plan.templateId, themeKey: '', themeTitle: '',
    requiredPointIds: library.sellingPoints.slice(0, 2).map(p => p.id), optionalPointIds: [],
    candidateCount: 2, degraded: false, rationale: '' };
  const first = execution.run(plan, brief);
  await firstStarted;
  const second = execution.run({ ...plan, index: 2 }, { ...brief, planIndex: 2 });
  assert.equal(savedScripts.length, 0, '第二变体排队时还没有已保存标题');
  releaseFirst();
  await Promise.all([first, second]);
  db.close();
}

fs.rmSync(testRoot, { recursive: true, force: true });
console.log('script-studio-template-rewrite tests passed');
