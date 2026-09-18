import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { parseViralTemplateWorkbook } from '../lib/script-studio/catalog-import/viral-templates.ts';
import { loadWorkbook, sheetToWorkbookSheet } from '../lib/script-studio/catalog-import/workbook.ts';
import {
  getViralTemplateEntriesByIds,
  getViralTemplateLibraryView,
  importViralTemplateLibrary,
  listViralTemplateEntries,
  previewViralTemplateImport,
  recommendViralTemplates,
  updateViralTemplateEntryStatus,
} from '../lib/script-studio/viral-templates.ts';

/**
 * 爆文模板库导入与推荐（迁移方案 A01/A02/A03 片段）：
 * - 主表优先，分类表是相同记录的副本，不能双倍导入；
 * - 原始文本/ID/来源行保留；缺结构标 fallback；
 * - 占位内容默认不可推荐，疑似歌词进待检查，有效短文案不按长度删除；
 * - 同文件重导幂等，内容变更产生新库修订；文本重复只提示不合并；
 * - 推荐排序稳定、原因真实、同类目优先。
 */

const HEADER = ['类目', '子类目', '模板名称', '标题', '参考文案', '结构拆解', '结构摘要', '素材类型', '使用次数', '逛逛ID', '商品链接', '模板ID', '是否私有'];

function tplRow(overrides: Record<string, string>): string[] {
  const row: Record<string, string> = {
    类目: '床', 子类目: '实木床', 模板名称: '模板', 标题: '标题', 参考文案: '标题：x\n正文：y',
    结构拆解: '', 结构摘要: '', 素材类型: '', 使用次数: '0', 逛逛ID: '1', 商品链接: '', 模板ID: 'tpl1', 是否私有: '否',
    ...overrides,
  };
  return HEADER.map((h) => row[h] ?? '');
}

async function buildBuffer(mainRows: string[][], categorySheet?: { name: string; rows: string[][] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const main = wb.addWorksheet('全部模板');
  main.addRow(HEADER);
  for (const row of mainRows) main.addRow(row);
  if (categorySheet) {
    const sheet = wb.addWorksheet(categorySheet.name);
    sheet.addRow(HEADER);
    for (const row of categorySheet.rows) sheet.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function createDb(root: string): Database.Database {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','项目');`);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-viral-tpl-'));
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
const db = createDb(root);
const migration = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-09-17T00:00:00.000Z') });
assert.equal(migration.state, 'ready');
assert.equal(migration.targetVersion, 11);
for (const table of ['script_studio_viral_tpl_libraries', 'script_studio_viral_tpl_revisions', 'script_studio_viral_tpl_entries', 'script_studio_viral_tpl_style_cache']) {
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), `缺少 ${table}`);
}

// ---- 1. 主表 + 分类表副本：只按主表导入，绝不双倍（A01） ----
const mainRows = [
  tplRow({ 模板ID: 'tpl-a', 模板名称: '实木床爆款', 标题: '实木床真香', 参考文案: '标题：实木床真香\n正文：这张床用料真的很扎实，整块实木框架，睡十年都不塌。', 结构摘要: '钩子>痛点>卖点>逼单' }),
  tplRow({ 模板ID: 'tpl-b', 模板名称: '占位模板', 参考文案: '测试文本' }),
  tplRow({ 模板ID: 'tpl-c', 模板名称: '空正文模板', 参考文案: '标题：简单一拉一放\n正文：无' }),
  tplRow({ 模板ID: 'tpl-d', 模板名称: '语气词模板', 参考文案: '标题：展示\n正文：哎耶耶耶' }),
  tplRow({ 模板ID: 'tpl-e', 模板名称: '歌词模板', 参考文案: '标题：花1k入手\n正文：当我家太陌生，呜呜呜，这首歌先放一下', 类目: '沙发' }),
  tplRow({ 模板ID: 'tpl-f', 模板名称: '短字幕模板', 标题: '可旋转升降', 参考文案: '标题：可旋转升降\n正文：适配不同场景' }),
];
const categoryCopy = { name: '床', rows: [mainRows[0]!, mainRows[1]!] };
const buffer = await buildBuffer(mainRows, categoryCopy);

const parsedForAssert = await previewViralTemplateImport(buffer);
assert.equal(parsedForAssert.totalRows, 6, '主表 6 条，不含分类表副本（绝不 12 条）');
assert.equal(parsedForAssert.mergedCategorySheets, false);
assert.equal(parsedForAssert.statusCounts.usable, 2, 'tpl-a 与短但有效的 tpl-f 可用');
assert.equal(parsedForAssert.statusCounts.unusable, 3, '测试文本/正文无/语气词均为占位不可用');
assert.equal(parsedForAssert.statusCounts.review, 1, '歌词进待检查而不是删除');
assert.equal(parsedForAssert.canActivate, true);

const outcome = await importViralTemplateLibrary(db, buffer, '种草爆文库_模板文案_按类目_20260917.xlsx', () => new Date('2026-09-17T00:01:00.000Z'));
assert.equal(outcome.created, true);

const view = getViralTemplateLibraryView(db);
assert.equal(view.current!.entryCounts.total, 6);
assert.equal(view.current!.entryCounts.usable, 2);
assert.equal(view.current!.revisionNumber, 1);

const entries = listViralTemplateEntries(db, { status: 'all' });
const byId = new Map(entries.map((entry) => [entry.sourceTemplateId, entry]));
const usable = byId.get('tpl-a')!;
assert.equal(usable.status, 'usable');
assert.equal(usable.refText.includes('整块实木框架'), true, '原始参考全文不丢');
assert.equal(usable.structure, '钩子>痛点>卖点>逼单');
assert.equal(usable.structureOrigin, 'source', '表里有结构摘要时标 source');
assert.equal(usable.sourceSheet, '全部模板');
assert.equal(usable.sourceRow, 2, '来源行号保留');
const fallbackEntry = byId.get('tpl-b')!;
assert.equal(fallbackEntry.structureOrigin, 'fallback', '缺失结构标 fallback');
assert.equal(fallbackEntry.structure, '钩子>痛点>卖点>逼单', 'fallback 结构为源码默认');
assert.equal(fallbackEntry.status, 'unusable');
const shortButValid = byId.get('tpl-f')!;
assert.equal(shortButValid.status, 'usable', '有效短文案不按长度删除');
const lyric = byId.get('tpl-e')!;
assert.equal(lyric.status, 'review');
// 「使用次数」只作原始列保留，不作为热度排名
assert.equal(JSON.parse(usable.rawColumnsJson).useCount, '0');
assert.equal(JSON.parse(usable.rawColumnsJson).visibility, '否');

// ---- 2. 同文件重导幂等；内容变更产生新库修订（A01/A10 片段） ----
const reimport = await importViralTemplateLibrary(db, buffer, '种草爆文库_模板文案_按类目_20260917.xlsx', () => new Date('2026-09-17T00:02:00.000Z'));
assert.equal(reimport.created, false, '同指纹重导不新增修订');
assert.equal(reimport.revisionId, outcome.revisionId);
assert.equal(getViralTemplateLibraryView(db).revisions.length, 1);

const changedRows = mainRows.map((row) => [...row]);
changedRows[0] = tplRow({ 模板ID: 'tpl-a', 模板名称: '实木床爆款', 标题: '实木床真香', 参考文案: '标题：实木床真香\n正文：这张床用料升级，整块实木框架加静音床板。', 结构摘要: '钩子>痛点>卖点>逼单' });
const changedBuffer = await buildBuffer(changedRows, categoryCopy);
const changed = await importViralTemplateLibrary(db, changedBuffer, '种草爆文库v2.xlsx', () => new Date('2026-09-17T00:03:00.000Z'));
assert.equal(changed.created, true, '内容变更产生新库修订');
const view2 = getViralTemplateLibraryView(db);
assert.equal(view2.revisions.length, 2);
assert.equal(view2.current!.revisionNumber, 2, '新修订自动切换为当前版本');
const oldEntries = listViralTemplateEntries(db, { revisionId: outcome.revisionId, status: 'all' });
const newEntries = listViralTemplateEntries(db, { status: 'all' });
const oldA = oldEntries.find((entry) => entry.sourceTemplateId === 'tpl-a')!;
const newA = newEntries.find((entry) => entry.sourceTemplateId === 'tpl-a')!;
assert.notEqual(oldA.contentHash, newA.contentHash, '同来源 ID 内容变化产生新内容哈希，历史修订仍保留旧版全文');
assert.ok(oldA.refText.includes('整块实木框架，睡十年都不塌'));
const unchangedBOld = oldEntries.find((entry) => entry.sourceTemplateId === 'tpl-b')!;
const unchangedBNew = newEntries.find((entry) => entry.sourceTemplateId === 'tpl-b')!;
assert.equal(unchangedBOld.contentHash, unchangedBNew.contentHash, '内容未变的同 ID 条目内容哈希一致');

// ---- 3. 主表缺失：合并分类表并按模板 ID 去重（A01） ----
async function buildCategoryOnlyBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const bed = wb.addWorksheet('床');
  bed.addRow(HEADER);
  bed.addRow(tplRow({ 模板ID: 'tpl-x', 模板名称: '床模板' }));
  bed.addRow(tplRow({ 模板ID: 'tpl-y', 模板名称: '床模板二' }));
  const sofa = wb.addWorksheet('沙发');
  sofa.addRow(HEADER);
  sofa.addRow(tplRow({ 模板ID: 'tpl-x', 模板名称: '床模板（沙发表重复）', 类目: '沙发' }));
  sofa.addRow(tplRow({ 模板ID: 'tpl-z', 模板名称: '沙发模板', 类目: '沙发' }));
  sofa.addRow(tplRow({ 模板ID: '', 模板名称: '缺ID模板', 参考文案: '标题：无ID\n正文：没有模板编号的一行文案' }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const categoryOnly = await previewViralTemplateImport(await buildCategoryOnlyBuffer());
assert.equal(categoryOnly.mergedCategorySheets, true);
assert.equal(categoryOnly.totalRows, 4, 'tpl-x 跨表去重 + 缺ID行按内容标识保留');
assert.ok(categoryOnly.issues.some((issue) => issue.code === 'main_sheet_missing'));
assert.ok(categoryOnly.issues.some((issue) => issue.code === 'template_id_missing'), '缺 ID 显式记录来源');
const parsedSheets = await loadWorkbook(await buildCategoryOnlyBuffer());
const parsedResult = parseViralTemplateWorkbook(parsedSheets.worksheets.map((sheet) => sheetToWorkbookSheet(sheet)));
const contentIdEntry = parsedResult.entries.find((entry) => entry.sourceTemplateId.startsWith('content:'))!;
assert.ok(contentIdEntry, '缺 ID 生成可重复内容标识');
assert.equal(contentIdEntry.name, '缺ID模板');

// ---- 4. 文本重复只提示不合并（A01） ----
const dupTextRows = [
  tplRow({ 模板ID: 'tpl-dup-1', 模板名称: '甲' }),
  tplRow({ 模板ID: 'tpl-dup-2', 模板名称: '乙' }),
];
const dupParsed = await previewViralTemplateImport(await buildBuffer(dupTextRows));
assert.equal(dupParsed.totalRows, 2, '不同 ID 同文本不静默合并');
assert.ok(dupParsed.issues.some((issue) => issue.code === 'duplicate_text'), '文本重复进报告提示');

// ---- 5. 人工调整状态（A02 待检查可人工调整） ----
const adjusted = updateViralTemplateEntryStatus(db, lyric.id, 'usable', '人工确认有效');
assert.equal(adjusted.status, 'usable');
assert.equal(adjusted.statusUpdatedBy, 'manual');
const lyricAfter = getViralTemplateEntriesByIds(db, [lyric.id])[0]!;
assert.equal(lyricAfter.status, 'usable');

// ---- 6. 推荐：同类目优先、关键词命中、排序稳定、原因真实（A03 片段） ----
const rec1 = recommendViralTemplates(db, { sellingPointTexts: ['实木框架 用料扎实', '静音床板 睡觉不吵'], productCategory: '床' });
assert.ok(rec1.recommendations.length > 0);
const first = rec1.recommendations[0]!;
assert.equal(first.entry.sourceTemplateId, 'tpl-a', '同类目+关键词命中的模板排最前');
assert.ok(first.reasons.some((reason) => reason.includes('同类目')), '原因含真实类目命中');
assert.ok(first.reasons.some((reason) => reason.includes('实木')), '原因含真实关键词命中');
const rec2 = recommendViralTemplates(db, { sellingPointTexts: ['实木框架 用料扎实', '静音床板 睡觉不吵'], productCategory: '床' });
assert.deepEqual(rec2.recommendations.map((r) => r.entry.id), rec1.recommendations.map((r) => r.entry.id), '相同输入排序稳定');
const noHit = recommendViralTemplates(db, { sellingPointTexts: ['完全不相关的洗衣机脱水转速'], productCategory: '家电' });
assert.equal(noHit.recommendations.length, 0, '无命中不杜撰推荐理由');
assert.ok(noHit.usableCount > 0, '可用模板数如实上报（供扩大搜索入口）');

console.log('script-studio-viral-template-import tests passed');
