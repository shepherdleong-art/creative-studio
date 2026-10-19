import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { normalizeModelKey } from './catalog-import/normalize.ts';

/**
 * 全局产品策略知识库 + 脚本模板库领域（方案 `docs/superpowers/plans/2026-09-03-项目生产身份与脚本知识模板-执行方案.md`
 * §2.6-§2.8 / §5.2 / §6）。两类目录各自维护不可变修订：
 * - 导入相同内容指纹幂等，不重复创建修订；
 * - 设置页可激活历史修订；运行中任务以创建时的快照为准，不受当前版本切换影响；
 * - 失败导入不改变当前版本，不留下可见的半版本。
 *
 * 表格语义：
 * - `script_studio_strategy_entries`：产品策略条目（同型号多行在导入阶段合并后落一条）。
 * - `script_studio_framework_templates` / `script_studio_copy_hook_templates` /
 *   `script_studio_visual_hook_templates`：脚本模板库三类模板。
 * - `script_studio_template_assets`：模板库嵌入参考图片副本与元数据。
 */

export type CatalogKind = 'strategy' | 'template';

export interface CatalogRecord {
  id: string;
  kind: CatalogKind;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogRevisionRecord {
  id: string;
  catalogId: string;
  revisionNumber: number;
  sourceFilename: string;
  sourceSha256: string;
  importReportJson: string;
  createdAt: string;
}

export interface StrategyEntryRecord {
  id: string;
  revisionId: string;
  modelKey: string;
  normalizedModelKey: string;
  canonicalName: string;
  categoryMindsetsJson: string;
  primarySellingPointsJson: string;
  differentiatorsJson: string;
  searchTermsJson: string;
  auxiliaryJson: string;
  sourceRowsJson: string;
  status: string;
}

export interface FrameworkTemplateRecord {
  id: string;
  revisionId: string;
  stableKey: string;
  name: string;
  subtype: string;
  structureJson: string;
  sellingPointDensityJson: string;
  applicableProductsJson: string;
  preferredHookTypesJson: string;
  secondaryHookTypesJson: string;
  sourceRow: number;
  status: string;
}

export interface CopyHookTemplateRecord {
  id: string;
  revisionId: string;
  stableKey: string;
  hookType: string;
  mechanism: string;
  subtype: string;
  formula: string;
  example: string;
  recommendedFrameworksJson: string;
  recommendedSellingPointTagsJson: string;
  sourceRow: number;
  status: string;
}

export interface VisualHookTemplateRecord {
  id: string;
  revisionId: string;
  stableKey: string;
  playGroup: string;
  playName: string;
  visualFormula: string;
  implementationAdvice: string;
  applicableProductsJson: string;
  hookTagsJson: string;
  referenceLinksJson: string;
  notes: string;
  sourceRow: number;
  status: string;
}

export interface TemplateAssetRecord {
  id: string;
  revisionId: string;
  visualHookId: string;
  relativePath: string;
  contentSha256: string;
  sourceAnchor: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface CatalogRevisionView {
  id: string;
  catalogId: string;
  kind: CatalogKind;
  revisionNumber: number;
  sourceFilename: string;
  sourceSha256: string;
  importReport: Record<string, unknown>;
  createdAt: string;
  current: boolean;
  strategyEntries: StrategyEntryView[];
  frameworkTemplates: FrameworkTemplateView[];
  copyHookTemplates: CopyHookTemplateView[];
  visualHookTemplates: VisualHookTemplateView[];
}

export interface StrategyEntryView {
  id: string;
  modelKey: string;
  normalizedModelKey: string;
  canonicalName: string;
  categoryMindsets: string[];
  primarySellingPoints: string[];
  differentiators: string[];
  searchTerms: string[];
  auxiliary: Record<string, unknown>;
  sourceRows: Array<number | string>;
  status: string;
}

export interface FrameworkTemplateView {
  id: string;
  stableKey: string;
  name: string;
  subtype: string;
  structure: string[];
  sellingPointDensity: Record<string, unknown>;
  applicableProducts: string[];
  preferredHookTypes: string[];
  secondaryHookTypes: string[];
  sourceRow: number;
  status: string;
}

export interface CopyHookTemplateView {
  id: string;
  stableKey: string;
  hookType: string;
  mechanism: string;
  subtype: string;
  formula: string;
  example: string;
  recommendedFrameworks: string[];
  recommendedSellingPointTags: string[];
  sourceRow: number;
  status: string;
}

export interface VisualHookTemplateView {
  id: string;
  stableKey: string;
  playGroup: string;
  playName: string;
  visualFormula: string;
  implementationAdvice: string;
  applicableProducts: string[];
  hookTags: string[];
  referenceLinks: string[];
  notes: string;
  sourceRow: number;
  status: string;
  assetIds: string[];
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toStrategyEntryView(record: StrategyEntryRecord): StrategyEntryView {
  return {
    id: record.id,
    modelKey: record.modelKey,
    normalizedModelKey: record.normalizedModelKey,
    canonicalName: record.canonicalName,
    categoryMindsets: parseJsonArray(record.categoryMindsetsJson),
    primarySellingPoints: parseJsonArray(record.primarySellingPointsJson),
    differentiators: parseJsonArray(record.differentiatorsJson),
    searchTerms: parseJsonArray(record.searchTermsJson),
    auxiliary: parseJsonObject(record.auxiliaryJson),
    sourceRows: JSON.parse(record.sourceRowsJson || '[]'),
    status: record.status,
  };
}

function toFrameworkTemplateView(record: FrameworkTemplateRecord): FrameworkTemplateView {
  return {
    id: record.id,
    stableKey: record.stableKey,
    name: record.name,
    subtype: record.subtype,
    structure: parseJsonArray(record.structureJson),
    sellingPointDensity: parseJsonObject(record.sellingPointDensityJson),
    applicableProducts: parseJsonArray(record.applicableProductsJson),
    preferredHookTypes: parseJsonArray(record.preferredHookTypesJson),
    secondaryHookTypes: parseJsonArray(record.secondaryHookTypesJson),
    sourceRow: record.sourceRow,
    status: record.status,
  };
}

function toCopyHookTemplateView(record: CopyHookTemplateRecord): CopyHookTemplateView {
  return {
    id: record.id,
    stableKey: record.stableKey,
    hookType: record.hookType,
    mechanism: record.mechanism,
    subtype: record.subtype,
    formula: record.formula,
    example: record.example,
    recommendedFrameworks: parseJsonArray(record.recommendedFrameworksJson),
    recommendedSellingPointTags: parseJsonArray(record.recommendedSellingPointTagsJson),
    sourceRow: record.sourceRow,
    status: record.status,
  };
}

function toVisualHookTemplateView(record: VisualHookTemplateRecord, assetIds: string[]): VisualHookTemplateView {
  return {
    id: record.id,
    stableKey: record.stableKey,
    playGroup: record.playGroup,
    playName: record.playName,
    visualFormula: record.visualFormula,
    implementationAdvice: record.implementationAdvice,
    applicableProducts: parseJsonArray(record.applicableProductsJson),
    hookTags: parseJsonArray(record.hookTagsJson),
    referenceLinks: parseJsonArray(record.referenceLinksJson),
    notes: record.notes,
    sourceRow: record.sourceRow,
    status: record.status,
    assetIds,
  };
}

export function getOrCreateCatalog(db: Database.Database, kind: CatalogKind, now?: Date): CatalogRecord {
  const existing = db.prepare(`SELECT * FROM script_studio_catalogs WHERE kind = ?`).get(kind) as CatalogRecord | undefined;
  if (existing) return existing;
  const record: CatalogRecord = {
    id: crypto.randomUUID(),
    kind,
    currentRevisionId: null,
    createdAt: (now ?? new Date()).toISOString(),
    updatedAt: (now ?? new Date()).toISOString(),
  };
  db.prepare(`INSERT INTO script_studio_catalogs (id, kind, currentRevisionId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`)
    .run(record.id, record.kind, record.currentRevisionId, record.createdAt, record.updatedAt);
  return record;
}

export function getCatalog(db: Database.Database, kind: CatalogKind): CatalogRecord {
  const record = db.prepare(`SELECT * FROM script_studio_catalogs WHERE kind = ?`).get(kind) as CatalogRecord | undefined;
  if (!record) throw new Error(`catalog 不存在: ${kind}`);
  return record;
}

/** 容错查找：目录尚未导入时不抛错（设置页空状态/列表用），未找到返回 null。 */
export function findCatalog(db: Database.Database, kind: CatalogKind): CatalogRecord | null {
  const record = db.prepare(`SELECT * FROM script_studio_catalogs WHERE kind = ?`).get(kind) as CatalogRecord | undefined;
  return record ?? null;
}

export interface CreateCatalogRevisionInput {
  catalogId: string;
  sourceFilename: string;
  sourceSha256: string;
  importReport: Record<string, unknown>;
  strategyEntries?: Array<Omit<StrategyEntryRecord, 'id' | 'revisionId'>>;
  frameworkTemplates?: Array<Omit<FrameworkTemplateRecord, 'id' | 'revisionId'>>;
  copyHookTemplates?: Array<Omit<CopyHookTemplateRecord, 'id' | 'revisionId'>>;
  visualHookTemplates?: Array<Omit<VisualHookTemplateRecord, 'id' | 'revisionId'>>;
  templateAssets?: Array<Omit<TemplateAssetRecord, 'id' | 'revisionId' | 'createdAt'>>;
  /** 模板资产需要先落盘，由调用方预先生成并传入，缺省自动生成。 */
  revisionId?: string;
  now?: Date;
}

/**
 * 原子发布新修订：内容指纹幂等（同目录同 SHA-256 直接返回既有修订，不重复创建）；
 * 成功后才切换当前版本；失败回滚不留半版本。
 */
export function createCatalogRevision(
  db: Database.Database,
  input: CreateCatalogRevisionInput,
): { revisionId: string; created: boolean } {
  const existing = db.prepare(`SELECT id FROM script_studio_catalog_revisions WHERE catalogId = ? AND sourceSha256 = ?`)
    .get(input.catalogId, input.sourceSha256) as { id: string } | undefined;
  if (existing) {
    return { revisionId: existing.id, created: false };
  }

  const now = (input.now ?? new Date()).toISOString();
  const revisionNumber = ((db.prepare(`SELECT MAX(revisionNumber) AS maxRev FROM script_studio_catalog_revisions WHERE catalogId = ?`)
    .get(input.catalogId) as { maxRev: number | null }).maxRev ?? 0) + 1;
  const revisionId = input.revisionId ?? crypto.randomUUID();

  const publish = db.transaction(() => {
    db.prepare(`
      INSERT INTO script_studio_catalog_revisions (id, catalogId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(revisionId, input.catalogId, revisionNumber, input.sourceFilename, input.sourceSha256, JSON.stringify(input.importReport), now);

    const insertStrategy = db.prepare(`
      INSERT INTO script_studio_strategy_entries (id, revisionId, modelKey, normalizedModelKey, canonicalName, categoryMindsetsJson, primarySellingPointsJson, differentiatorsJson, searchTermsJson, auxiliaryJson, sourceRowsJson, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of input.strategyEntries ?? []) {
      insertStrategy.run(crypto.randomUUID(), revisionId, entry.modelKey, entry.normalizedModelKey, entry.canonicalName,
        entry.categoryMindsetsJson, entry.primarySellingPointsJson, entry.differentiatorsJson, entry.searchTermsJson,
        entry.auxiliaryJson, entry.sourceRowsJson, entry.status);
    }

    const insertFramework = db.prepare(`
      INSERT INTO script_studio_framework_templates (id, revisionId, stableKey, name, subtype, structureJson, sellingPointDensityJson, applicableProductsJson, preferredHookTypesJson, secondaryHookTypesJson, sourceRow, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of input.frameworkTemplates ?? []) {
      insertFramework.run(crypto.randomUUID(), revisionId, item.stableKey, item.name, item.subtype, item.structureJson,
        item.sellingPointDensityJson, item.applicableProductsJson, item.preferredHookTypesJson, item.secondaryHookTypesJson, item.sourceRow, item.status);
    }

    const insertCopy = db.prepare(`
      INSERT INTO script_studio_copy_hook_templates (id, revisionId, stableKey, hookType, mechanism, subtype, formula, example, recommendedFrameworksJson, recommendedSellingPointTagsJson, sourceRow, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of input.copyHookTemplates ?? []) {
      insertCopy.run(crypto.randomUUID(), revisionId, item.stableKey, item.hookType, item.mechanism, item.subtype,
        item.formula, item.example, item.recommendedFrameworksJson, item.recommendedSellingPointTagsJson, item.sourceRow, item.status);
    }

    const insertVisual = db.prepare(`
      INSERT INTO script_studio_visual_hook_templates (id, revisionId, stableKey, playGroup, playName, visualFormula, implementationAdvice, applicableProductsJson, hookTagsJson, referenceLinksJson, notes, sourceRow, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const visualIdByRow = new Map<number, string>();
    for (const item of input.visualHookTemplates ?? []) {
      const id = crypto.randomUUID();
      visualIdByRow.set(item.sourceRow, id);
      insertVisual.run(id, revisionId, item.stableKey, item.playGroup, item.playName, item.visualFormula,
        item.implementationAdvice, item.applicableProductsJson, item.hookTagsJson, item.referenceLinksJson, item.notes, item.sourceRow, item.status);
    }

    const insertAsset = db.prepare(`
      INSERT INTO script_studio_template_assets (id, revisionId, visualHookId, relativePath, contentSha256, sourceAnchor, width, height, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const asset of input.templateAssets ?? []) {
      const visualHookId = asset.visualHookId.startsWith('row:')
        ? visualIdByRow.get(Number(asset.visualHookId.slice(4))) ?? asset.visualHookId
        : asset.visualHookId;
      insertAsset.run(crypto.randomUUID(), revisionId, visualHookId, asset.relativePath, asset.contentSha256,
        asset.sourceAnchor, asset.width, asset.height, now);
    }

    db.prepare(`UPDATE script_studio_catalogs SET currentRevisionId = ?, updatedAt = ? WHERE id = ?`)
      .run(revisionId, now, input.catalogId);
  });

  publish.immediate();
  return { revisionId, created: true };
}

/** 设置页激活历史修订：只改当前指针，不修改任何条目内容。 */
export function setCatalogCurrentRevision(db: Database.Database, catalogId: string, revisionId: string, now?: Date): void {
  const revision = db.prepare(`SELECT id FROM script_studio_catalog_revisions WHERE id = ? AND catalogId = ?`).get(revisionId, catalogId);
  if (!revision) throw new Error('目录修订不存在');
  db.prepare(`UPDATE script_studio_catalogs SET currentRevisionId = ?, updatedAt = ? WHERE id = ?`)
    .run(revisionId, (now ?? new Date()).toISOString(), catalogId);
}

export function getCatalogCurrentRevisionId(db: Database.Database, kind: CatalogKind): string | null {
  const row = db.prepare(`SELECT currentRevisionId FROM script_studio_catalogs WHERE kind = ?`).get(kind) as { currentRevisionId: string | null } | undefined;
  return row?.currentRevisionId ?? null;
}

export function getCatalogRevision(db: Database.Database, revisionId: string): CatalogRevisionRecord | null {
  const record = db.prepare(`SELECT * FROM script_studio_catalog_revisions WHERE id = ?`).get(revisionId) as CatalogRevisionRecord | undefined;
  return record ?? null;
}

export function listCatalogRevisions(db: Database.Database, catalogId: string): Array<CatalogRevisionRecord & { current: boolean }> {
  const currentId = (db.prepare(`SELECT currentRevisionId FROM script_studio_catalogs WHERE id = ?`).get(catalogId) as { currentRevisionId: string | null }).currentRevisionId;
  const records = db.prepare(`
    SELECT * FROM script_studio_catalog_revisions WHERE catalogId = ? ORDER BY revisionNumber DESC
  `).all(catalogId) as Array<CatalogRevisionRecord & { current: boolean }>;
  return records.map((record) => ({ ...record, current: record.id === currentId }));
}

export function getCatalogRevisionView(db: Database.Database, revisionId: string): CatalogRevisionView | null {
  const revision = getCatalogRevision(db, revisionId);
  if (!revision) return null;
  const catalog = db.prepare(`SELECT * FROM script_studio_catalogs WHERE id = ?`).get(revision.catalogId) as CatalogRecord;
  const strategyEntries = (db.prepare(`SELECT * FROM script_studio_strategy_entries WHERE revisionId = ? ORDER BY normalizedModelKey`).all(revisionId) as StrategyEntryRecord[]).map(toStrategyEntryView);
  const frameworkTemplates = (db.prepare(`SELECT * FROM script_studio_framework_templates WHERE revisionId = ? ORDER BY sourceRow`).all(revisionId) as FrameworkTemplateRecord[]).map(toFrameworkTemplateView);
  const copyHookTemplates = (db.prepare(`SELECT * FROM script_studio_copy_hook_templates WHERE revisionId = ? ORDER BY sourceRow`).all(revisionId) as CopyHookTemplateRecord[]).map(toCopyHookTemplateView);
  const visualHookTemplates = (db.prepare(`SELECT * FROM script_studio_visual_hook_templates WHERE revisionId = ? ORDER BY sourceRow`).all(revisionId) as VisualHookTemplateRecord[]).map((record) => {
    const assetRows = db.prepare(`SELECT id FROM script_studio_template_assets WHERE visualHookId = ? ORDER BY createdAt`).all(record.id) as Array<{ id: string }>;
    return toVisualHookTemplateView(record, assetRows.map((row) => row.id));
  });
  return {
    id: revision.id,
    catalogId: revision.catalogId,
    kind: catalog.kind,
    revisionNumber: revision.revisionNumber,
    sourceFilename: revision.sourceFilename,
    sourceSha256: revision.sourceSha256,
    importReport: parseJsonObject(revision.importReportJson),
    createdAt: revision.createdAt,
    current: catalog.currentRevisionId === revision.id,
    strategyEntries,
    frameworkTemplates,
    copyHookTemplates,
    visualHookTemplates,
  };
}

export interface StrategyEntryLookup {
  view: StrategyEntryView;
  entryId: string;
  revisionId: string;
}

/**
 * 型号匹配（方案 §2.6）：当前启用策略修订内，先试「型号-子型号」组合，未命中再查完整型号。
 * 子型号为空时只查完整型号。不做模糊匹配、不按连字符拆型号。
 */
export function matchStrategyEntry(
  db: Database.Database,
  kind: CatalogKind,
  modelKey: string,
  submodel?: string,
): StrategyEntryLookup | null {
  const revisionId = getCatalogCurrentRevisionId(db, kind);
  if (!revisionId) return null;
  // 查询键与导入写入键（catalog-import/normalize.ts 的 normalizeModelKey）必须是同一个函数，
  // 否则读写两端归一化口径漂移会导致导入的条目永远匹配不上。
  const candidates = submodel ? [normalizeModelKey(`${modelKey}-${submodel}`), normalizeModelKey(modelKey)] : [normalizeModelKey(modelKey)];
  for (const key of candidates) {
    const record = db.prepare(`
      SELECT * FROM script_studio_strategy_entries WHERE revisionId = ? AND normalizedModelKey = ? AND status = 'active'
    `).get(revisionId, key) as StrategyEntryRecord | undefined;
    if (record) {
      return { view: toStrategyEntryView(record), entryId: record.id, revisionId };
    }
  }
  return null;
}
