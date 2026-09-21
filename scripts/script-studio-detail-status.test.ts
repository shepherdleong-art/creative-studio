import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { computeDetailStatus } from '../lib/script-studio/selling-point-normalize.ts';
import { createLibraryRevision, getLibraryRevision, manualEditLibraryRevision } from '../lib/script-studio/libraries.ts';
import { dedupeSellingPoints } from '../lib/script-studio/dedupe.ts';
import { createVisionExtractor } from '../lib/script-studio/adapters/vision-extract.ts';

/**
 * 卖点详解（爆文模板改写迁移方案 §4.1 / A04 / A05）：
 * - 标题与多句详解同次提取成组保存，没有额外卖点归纳或人群画像请求；
 * - detailStatus 本地确定性判定：missing / verified / unverified；
 * - 编辑详解产生新修订且新增事实同样受约束（含未获支持数字→unverified）；
 * - 旧输入缺详解时标 missing，不把原子事实重复一遍冒充详解迁移。
 */

function createDb(root: string): Database.Database {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','项目');`);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-detail-'));
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
const db = createDb(root);
const migration = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migration.state, 'ready');

// ---- 1. computeDetailStatus 判定矩阵 ----
assert.equal(computeDetailStatus({ detailText: '', factText: 'x', evidenceQuote: 'x' }), 'missing');
assert.equal(
  computeDetailStatus({
    detailText: '层板可调 → 可根据物品高度调整收纳；层板拿下后还能放大件。', // 多句、含分号
    factText: '层板可调节，层板可拆卸',
    evidenceQuote: '层板可调节 层板可拆卸',
  }),
  'verified',
  '保留前提与范围的价值解释通过，且无数字/高风险词越界',
);
assert.equal(
  computeDetailStatus({
    detailText: '层板承重 200kg，可根据物品高度调整',
    factText: '层板可调节',
    evidenceQuote: '层板可调节',
  }),
  'unverified',
  '详解含未获支持的数字 → 整组暂不可用',
);
assert.equal(
  computeDetailStatus({
    detailText: '坐深 60cm，久坐不闷',
    factText: '坐深 60cm',
    evidenceQuote: '坐深 60cm',
  }),
  'verified',
  '详解数字在事实中有依据',
);
assert.equal(
  computeDetailStatus({
    detailText: '采用真皮面料，亲肤透气',
    factText: '科技布面料',
    evidenceQuote: '科技布面料',
  }),
  'unverified',
  '详解含未获支持的材质 → 整组暂不可用',
);
assert.equal(
  computeDetailStatus({
    detailText: '实木框架，结实耐用',
    factText: '框架为实木',
    evidenceQuote: '实木框架',
  }),
  'verified',
  '材质词在证据中有依据',
);

// ---- 2. 提取输入持久化：详解成组保存，detailStatus 入库时本地判定 ----
db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('source-1', 'p1', 'fp-1', '["img-1"]', '2026-09-17T00:00:10.000Z')
`).run();
const library = createLibraryRevision(db, {
  projectId: 'p1',
  sourceSetId: 'source-1',
  sourceFingerprint: 'fp-1',
  productName: '测试柜',
  category: '柜类',
  sellingPoints: [
    {
      title: '层板可调', factText: '层板可调节，层板可拆卸', pointType: 'structure',
      evidenceQuote: '层板可调节 层板可拆卸', sourcePageIndex: 0, tileRefs: ['1'],
      detailText: '可根据物品高度调整收纳；层板拿下后还能放大件。',
      usable: true,
    },
    {
      title: '加宽坐深', factText: '坐深 60cm', pointType: 'spec',
      evidenceQuote: '坐深 60cm', sourcePageIndex: 0, tileRefs: ['2'],
      detailText: '坐深 80cm 更宽敞', // 数字与事实冲突
      usable: true,
    },
    {
      title: '无详解卖点', factText: '普通事实', pointType: 'other',
      evidenceQuote: '普通事实', sourcePageIndex: 0, tileRefs: ['3'],
      usable: true,
    },
  ],
}, () => new Date('2026-09-17T00:01:00.000Z'));
const points = getLibraryRevision(db, 'p1', library.id)!.sellingPoints;
assert.equal(points[0]!.detailText, '可根据物品高度调整收纳；层板拿下后还能放大件。', '多句、含分号的详解完整保存');
assert.equal(points[0]!.detailStatus, 'verified');
assert.equal(points[1]!.detailStatus, 'unverified', '详解数字与事实冲突 → 整组暂不可用');
assert.equal(points[2]!.detailStatus, 'missing', '旧输入缺详解标 missing，不拿 factText 冒充详解');

// ---- 3. 编辑详解 → 新修订 + 重算（A05：解释编辑新增事实需重验） ----
const edited = manualEditLibraryRevision(db, 'p1', [
  { sellingPointId: points[1]!.id, detailText: '坐深 60cm，盘腿坐也够用' },
], { now: () => new Date('2026-09-17T00:02:00.000Z') });
assert.equal(edited.origin, 'manual_edit');
const editedPoint = getLibraryRevision(db, 'p1', edited.id)!.sellingPoints.find((p) => p.title === '加宽坐深')!;
assert.equal(editedPoint.detailStatus, 'verified', '修正后的详解重新校验通过');
const editedAgain = manualEditLibraryRevision(db, 'p1', [
  { sellingPointId: editedPoint.id, detailText: '真皮包裹，坐深 60cm' },
], { now: () => new Date('2026-09-17T00:03:00.000Z') });
const editedAgainPoint = getLibraryRevision(db, 'p1', editedAgain.id)!.sellingPoints.find((p) => p.title === '加宽坐深')!;
assert.equal(editedAgainPoint.detailStatus, 'unverified', '编辑新增无据材质同样被拦截');
// 未编辑的卖点详解原样保留
const untouched = getLibraryRevision(db, 'p1', editedAgain.id)!.sellingPoints.find((p) => p.title === '层板可调')!;
assert.equal(untouched.detailText.includes('放大件'), true, '人工编辑不丢其他卖点的详解');

// ---- 4. dedupe 合并：详解取首个非空 ----
const deduped = dedupeSellingPoints([
  { title: '层板可调', factText: '层板可调节', pointType: 'structure', evidenceQuote: '层板可调节', tileRefs: ['1'], detailText: '可根据物品高度调整收纳' },
  { title: '层板可调', factText: '层板可调节', pointType: 'structure', evidenceQuote: '层板可拆卸', tileRefs: ['2'], detailText: '另一份详解' },
]);
assert.equal(deduped.length, 1);
assert.equal(deduped[0]!.detailText, '可根据物品高度调整收纳');
const dedupedFill = dedupeSellingPoints([
  { title: '层板可调', factText: '层板可调节', pointType: 'structure', evidenceQuote: '层板可调节', tileRefs: ['1'], detailText: '' },
  { title: '层板可调', factText: '层板可调节', pointType: 'structure', evidenceQuote: '层板可拆卸', tileRefs: ['2'], detailText: '后来者补上详解' },
]);
assert.equal(dedupedFill[0]!.detailText, '后来者补上详解', '前者为空时取后者详解');

// ---- 5. 视觉契约 v5：同批输出 detail；解析进 detailText；老响应缺字段回退空串 ----
const visionCalls: Array<{ userPrompt: string }> = [];
const extractor = createVisionExtractor(async (request) => {
  visionCalls.push(request);
  return {
    productName: '测试柜', category: '柜类', brand: '',
    sellingPoints: [
      {
        title: '层板可调', factText: '层板可调节', pointType: 'structure',
        evidenceQuote: '层板可调节', tileRefs: ['tile_1'],
        detail: '可根据物品高度调整收纳',
      },
      { title: '老响应卖点', factText: '普通事实', pointType: 'other', evidenceQuote: '普通事实', tileRefs: ['tile_1'] },
    ],
  };
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 50, concurrency: 1 });
const extraction = await extractor.extract({
  pages: [{ pageIndex: 0, imageAssetId: 'img-1', filename: 'page1.jpg', sourceWidth: 800, sourceHeight: 1200, tiles: [{ mimeType: 'image/jpeg', imageBase64: 'AA==' }] }],
});
assert.equal(extraction.promptContractVersion, 5);
assert.equal(extraction.sellingPoints[0]!.detailText, '可根据物品高度调整收纳', '同批输出的详解解析进 detailText');
assert.equal(extraction.sellingPoints[1]!.detailText, '', '老响应缺 detail 回退空串（入库标 missing）');
const outputDecl = JSON.stringify(JSON.parse(visionCalls[0]!.userPrompt).output);
assert.ok(outputDecl.includes('detail'), 'output 声明含 detail 字段');
assert.ok(visionCalls[0]!.userPrompt.includes('详解'), '提示词包含详解要求');

console.log('script-studio-detail-status tests passed');
