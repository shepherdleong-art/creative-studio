import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import { assertXlsxBuffer } from './catalog-import/index.ts';
import { loadWorkbook, sheetToWorkbookSheet } from './catalog-import/workbook.ts';
import {
  parseViralTemplateWorkbook,
  type ViralTemplateEntryParsed,
  type ViralTemplateImportReport,
  type ViralTemplateStatus,
} from './catalog-import/viral-templates.ts';
import { normalizeText } from './catalog-import/normalize.ts';

/**
 * 爆文模板库（迁移方案 §3.1/§3.2）：独立于 catalogs 的版本化设施。
 * - 导入 = 解析 → 整文件指纹幂等 → 单事务发布库修订（条目整体快照）；
 * - 同文件重复导入不新增修订；内容变化产生新库修订，历史任务经 inputSnapshot
 *   冻结的模板全文继续引用旧版内容；
 * - 条目内容字段不可变；可用状态（usable/unusable/review）可人工调整并记录来源。
 */

export interface ViralTemplateLibraryRecord {
  id: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ViralTemplateRevisionRecord {
  id: string;
  libraryId: string;
  revisionNumber: number;
  sourceFilename: string;
  sourceSha256: string;
  importReportJson: string;
  createdAt: string;
}

export interface ViralTemplateEntryRecord {
  id: string;
  revisionId: string;
  sourceTemplateId: string;
  category: string;
  subCategory: string;
  name: string;
  title: string;
  refText: string;
  structureRaw: string;
  structureSummary: string;
  structure: string;
  structureOrigin: 'source' | 'fallback';
  rawColumnsJson: string;
  sourceSheet: string;
  sourceRow: number;
  sourceFileSha256: string;
  contentHash: string;
  status: ViralTemplateStatus;
  statusReason: string;
  statusUpdatedBy: string;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

export function getOrCreateViralTemplateLibrary(db: Database.Database, now?: () => Date): ViralTemplateLibraryRecord {
  const existing = db.prepare(`SELECT * FROM script_studio_viral_tpl_libraries ORDER BY createdAt LIMIT 1`)
    .get() as ViralTemplateLibraryRecord | undefined;
  if (existing) return existing;
  const id = randomUUID();
  const ts = nowIso(now);
  db.prepare(`
    INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, createdAt, updatedAt)
    VALUES (?, NULL, ?, ?)
  `).run(id, ts, ts);
  return db.prepare(`SELECT * FROM script_studio_viral_tpl_libraries WHERE id = ?`).get(id) as ViralTemplateLibraryRecord;
}

export interface ViralTemplateImportOutcome {
  libraryId: string;
  revisionId: string;
  created: boolean;
  report: ViralTemplateImportReport;
}

/** 预览：完整解析与标记，不落库。 */
export async function previewViralTemplateImport(buffer: Buffer): Promise<ViralTemplateImportOutcome['report'] & { entries: ViralTemplateEntryParsed[] }> {
  assertXlsxBuffer(buffer);
  const workbook = await loadWorkbook(buffer);
  const sheets = workbook.worksheets.map((worksheet) => sheetToWorkbookSheet(worksheet));
  const parsed = parseViralTemplateWorkbook(sheets);
  return { ...parsed.report, entries: parsed.entries };
}

/** 确认导入：指纹幂等 + 单事务发布库修订。 */
export async function importViralTemplateLibrary(
  db: Database.Database,
  buffer: Buffer,
  sourceFilename: string,
  now?: () => Date,
): Promise<ViralTemplateImportOutcome> {
  assertXlsxBuffer(buffer);
  const workbook = await loadWorkbook(buffer);
  const sheets = workbook.worksheets.map((worksheet) => sheetToWorkbookSheet(worksheet));
  const parsed = parseViralTemplateWorkbook(sheets);
  const library = getOrCreateViralTemplateLibrary(db, now);
  const sourceSha256 = createHash('sha256').update(buffer).digest('hex');

  const existing = db.prepare(`
    SELECT id FROM script_studio_viral_tpl_revisions WHERE libraryId = ? AND sourceSha256 = ?
  `).get(library.id, sourceSha256) as { id: string } | undefined;
  if (existing) {
    return { libraryId: library.id, revisionId: existing.id, created: false, report: parsed.report };
  }

  const revisionId = randomUUID();
  const ts = nowIso(now);
  const publish = db.transaction(() => {
    const numberRow = db.prepare(`
      SELECT COALESCE(MAX(revisionNumber), 0) + 1 AS next FROM script_studio_viral_tpl_revisions WHERE libraryId = ?
    `).get(library.id) as { next: number };
    db.prepare(`
      INSERT INTO script_studio_viral_tpl_revisions
        (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, library.id, Number(numberRow.next), sourceFilename, sourceSha256, JSON.stringify(parsed.report), ts);
    const insertEntry = db.prepare(`
      INSERT INTO script_studio_viral_tpl_entries
        (id, revisionId, sourceTemplateId, category, subCategory, name, title, refText,
         structureRaw, structureSummary, structure, structureOrigin, rawColumnsJson,
         sourceSheet, sourceRow, sourceFileSha256, contentHash, status, statusReason, statusUpdatedBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)
    `);
    for (const entry of parsed.entries) {
      insertEntry.run(
        randomUUID(), revisionId, entry.sourceTemplateId, entry.category, entry.subCategory,
        entry.name, entry.title, entry.refText, entry.structureRaw, entry.structureSummary,
        entry.structure, entry.structureOrigin, JSON.stringify(entry.rawColumns),
        entry.sourceSheet, entry.sourceRow, sourceSha256, entry.contentHash,
        entry.status, entry.statusReason, ts,
      );
    }
    db.prepare(`
      UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
    `).run(revisionId, ts, library.id);
  });
  publish.immediate();
  return { libraryId: library.id, revisionId, created: true, report: parsed.report };
}

export interface ViralTemplateLibraryView {
  library: ViralTemplateLibraryRecord;
  current: (ViralTemplateRevisionRecord & { report: ViralTemplateImportReport; entryCounts: { total: number; usable: number; unusable: number; review: number } }) | null;
  revisions: Array<ViralTemplateRevisionRecord & { current: boolean; entryCount: number }>;
}

export function getViralTemplateLibraryView(db: Database.Database): ViralTemplateLibraryView {
  const library = getOrCreateViralTemplateLibrary(db);
  const revisions = (db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id) AS entryCount
    FROM script_studio_viral_tpl_revisions r WHERE r.libraryId = ? ORDER BY r.revisionNumber DESC
  `).all(library.id) as Array<ViralTemplateRevisionRecord & { entryCount: number }>)
    .map((row) => ({ ...row, current: row.id === library.currentRevisionId }));
  const currentRow = revisions.find((row) => row.current);
  let current: ViralTemplateLibraryView['current'] = null;
  if (currentRow) {
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM script_studio_viral_tpl_entries WHERE revisionId = ? GROUP BY status
    `).all(currentRow.id) as Array<{ status: ViralTemplateStatus; count: number }>;
    const entryCounts = { total: 0, usable: 0, unusable: 0, review: 0 };
    for (const row of counts) {
      entryCounts[row.status] = Number(row.count);
      entryCounts.total += Number(row.count);
    }
    let report = {} as ViralTemplateImportReport;
    try { report = JSON.parse(currentRow.importReportJson) as ViralTemplateImportReport; } catch { /* 保留空报告 */ }
    current = { ...currentRow, report, entryCounts };
  }
  return { library, current, revisions };
}

/** 激活历史修订（只切当前指针，不改条目；与 catalogs 同语义）。 */
export function setViralTemplateCurrentRevision(
  db: Database.Database,
  revisionId: string,
  now?: () => Date,
): { libraryId: string; currentRevisionId: string } {
  const library = getOrCreateViralTemplateLibrary(db, now);
  const revision = db.prepare(`
    SELECT id FROM script_studio_viral_tpl_revisions WHERE id = ? AND libraryId = ?
  `).get(revisionId, library.id) as { id: string } | undefined;
  if (!revision) throw new ScriptStudioError('not_found', '模板库修订不存在');
  db.prepare(`
    UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
  `).run(revisionId, nowIso(now), library.id);
  return { libraryId: library.id, currentRevisionId: revisionId };
}

export function listViralTemplateEntries(
  db: Database.Database,
  options: { revisionId?: string; status?: ViralTemplateStatus | 'all'; category?: string; q?: string; limit?: number } = {},
): ViralTemplateEntryRecord[] {
  const library = getOrCreateViralTemplateLibrary(db);
  const revisionId = options.revisionId || library.currentRevisionId;
  if (!revisionId) return [];
  const conditions = ['revisionId = ?'];
  const params: unknown[] = [revisionId];
  if (options.status && options.status !== 'all') {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options.category?.trim()) {
    conditions.push('(category = ? OR subCategory = ?)');
    params.push(options.category.trim(), options.category.trim());
  }
  if (options.q?.trim()) {
    conditions.push('(name LIKE ? OR title LIKE ? OR refText LIKE ? OR category LIKE ? OR subCategory LIKE ?)');
    const like = `%${options.q.trim()}%`;
    params.push(like, like, like, like, like);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 200) || 200));
  return db.prepare(`
    SELECT * FROM script_studio_viral_tpl_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY category, subCategory, sourceRow LIMIT ?
  `).all(...params, limit) as ViralTemplateEntryRecord[];
}

export function getViralTemplateEntriesByIds(db: Database.Database, entryIds: string[]): ViralTemplateEntryRecord[] {
  if (!entryIds.length) return [];
  const placeholders = entryIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM script_studio_viral_tpl_entries WHERE id IN (${placeholders})
  `).all(...entryIds) as ViralTemplateEntryRecord[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  // 按调用方给定的选择顺序返回（选择顺序是任务身份的一部分）。
  return entryIds.map((id) => byId.get(id)).filter((row): row is ViralTemplateEntryRecord => Boolean(row));
}

/** 人工调整条目可用状态（内容字段不可变；状态调整标记 manual，不改写历史修订内容）。 */
export function updateViralTemplateEntryStatus(
  db: Database.Database,
  entryId: string,
  status: ViralTemplateStatus,
  reason: string,
): ViralTemplateEntryRecord {
  const entry = db.prepare(`SELECT * FROM script_studio_viral_tpl_entries WHERE id = ?`).get(entryId) as ViralTemplateEntryRecord | undefined;
  if (!entry) throw new ScriptStudioError('not_found', '模板条目不存在');
  if (!['usable', 'unusable', 'review'].includes(status)) {
    throw new ScriptStudioError('invalid_input', '无效的模板状态');
  }
  db.prepare(`
    UPDATE script_studio_viral_tpl_entries SET status = ?, statusReason = ?, statusUpdatedBy = 'manual' WHERE id = ?
  `).run(status, reason.trim().slice(0, 200), entryId);
  return db.prepare(`SELECT * FROM script_studio_viral_tpl_entries WHERE id = ?`).get(entryId) as ViralTemplateEntryRecord;
}

// ---------------------------------------------------------------------------
// 本地可解释推荐（迁移方案 §3.1）：同类目优先，其次子类目与卖点/模板文本关键词匹配；
// 相同输入排序稳定，展示真实命中原因，不杜撰人群标签、转化率或爆款概率。
// ---------------------------------------------------------------------------

export interface ViralTemplateRecommendInput {
  /** 卖点文本（标题 + 详解），来自合格且用户保留的卖点。 */
  sellingPointTexts: string[];
  /** 产品类目（卖点库修订的 category，视觉提取自由文本，可空）。 */
  productCategory?: string;
  /** 类目候选不足时传 true 放开类目加分（仍按关键词排序）。 */
  expandBeyondCategory?: boolean;
  limit?: number;
}

export interface ViralTemplateRecommendation {
  entry: ViralTemplateEntryRecord;
  score: number;
  reasons: string[];
}

const CN_RUN = /[\u4e00-\u9fff]{2,}/g;
const NUM_UNIT = /\d+(?:\.\d+)?\s?(?:cm|mm|m|米|厘米|度|升|斤|瓦|w|W|%)/g;

/** 可解释分词：连续中文 run 收整体（≤6 字）+ 2–4 字滑窗（>2 字时），另收数字单位 token。 */
export function tokenizeForViralTemplateMatch(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = normalizeText(text);
  for (const match of normalized.matchAll(CN_RUN)) {
    const run = match[0];
    if (run.length <= 6) tokens.add(run);
    if (run.length > 2) {
      for (let size = 2; size <= Math.min(4, run.length - 1); size += 1) {
        for (let i = 0; i + size <= run.length; i += 1) tokens.add(run.slice(i, i + size));
      }
    }
  }
  for (const match of normalized.matchAll(NUM_UNIT)) tokens.add(match[0].replace(/\s+/g, ''));
  return tokens;
}

function templateMatchText(entry: ViralTemplateEntryRecord): string {
  // 模板文本窗口：名称/标题全文 + 参考文案前 200 字（与筛选用前 600 字是两个独立口径）。
  return [entry.name, entry.title, entry.refText.slice(0, 200), entry.structureSummary].join('\n');
}

export function recommendViralTemplates(
  db: Database.Database,
  input: ViralTemplateRecommendInput,
): { recommendations: ViralTemplateRecommendation[]; usableCount: number } {
  const usable = listViralTemplateEntries(db, { status: 'usable', limit: 500 });
  const sellingTokens = new Set<string>();
  for (const text of input.sellingPointTexts) {
    for (const token of tokenizeForViralTemplateMatch(text)) sellingTokens.add(token);
  }
  const productCategory = normalizeText(input.productCategory ?? '');
  const scored: ViralTemplateRecommendation[] = [];
  for (const entry of usable) {
    let score = 0;
    const reasons: string[] = [];
    if (productCategory && entry.category) {
      const entryCategory = normalizeText(entry.category);
      if (entryCategory && (productCategory.includes(entryCategory) || entryCategory.includes(productCategory))) {
        score += input.expandBeyondCategory ? 2 : 10;
        reasons.push(`同类目：${entry.category}`);
      }
    }
    if (entry.subCategory) {
      const sub = normalizeText(entry.subCategory);
      const hitInSelling = input.sellingPointTexts.some((text) => normalizeText(text).includes(sub));
      if (sub && (hitInSelling || (productCategory && productCategory.includes(sub)))) {
        score += 4;
        reasons.push(`子类目相关：${entry.subCategory}`);
      }
    }
    const templateTokens = tokenizeForViralTemplateMatch(templateMatchText(entry));
    const keywordHits = [...sellingTokens].filter((token) => templateTokens.has(token)).sort();
    if (keywordHits.length > 0) {
      score += Math.min(10, keywordHits.length * 2);
      reasons.push(`命中卖点关键词：${keywordHits.slice(0, 6).join('、')}`);
    }
    if (score > 0) scored.push({ entry, score, reasons });
  }
  // 稳定排序：分数降序，同分按条目内部 ID 升序（相同输入排序稳定）。
  scored.sort((a, b) => (b.score - a.score) || (a.entry.id < b.entry.id ? -1 : 1));
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 12) || 12));
  return { recommendations: scored.slice(0, limit), usableCount: usable.length };
}

// ---------------------------------------------------------------------------
// 文风分析缓存：键 = 模板内容哈希 + 实际模型 + 提示词版本；只写完整成功结果。
// ---------------------------------------------------------------------------

export interface ViralTemplateStyleCacheEntry {
  contentHash: string;
  model: string;
  promptVersion: string;
  analysisJson: string;
  createdAt: string;
}

export function readViralTemplateStyleCache(
  db: Database.Database,
  contentHash: string,
  model: string,
  promptVersion: string,
): ViralTemplateStyleCacheEntry | undefined {
  return db.prepare(`
    SELECT * FROM script_studio_viral_tpl_style_cache
    WHERE contentHash = ? AND model = ? AND promptVersion = ?
  `).get(contentHash, model, promptVersion) as ViralTemplateStyleCacheEntry | undefined;
}

export function writeViralTemplateStyleCache(
  db: Database.Database,
  entry: { contentHash: string; model: string; promptVersion: string; analysisJson: string },
  now?: () => Date,
): void {
  db.prepare(`
    INSERT INTO script_studio_viral_tpl_style_cache (contentHash, model, promptVersion, analysisJson, createdAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(contentHash, model, promptVersion) DO NOTHING
  `).run(entry.contentHash, entry.model, entry.promptVersion, entry.analysisJson, nowIso(now));
}
