import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getOrCreateCatalog, createCatalogRevision, getCatalog } from './catalogs.ts';
import {
  parseStrategyImport,
  parseTemplateImport,
  persistTemplateAssets,
} from './catalog-import/index.ts';
import { removePersistedTemplateAssets } from './catalog-import/storage.ts';
import type { ImportReport } from './catalog-import/types.ts';
import { normalizeModelKey } from './catalog-import/normalize.ts';

/**
 * 目录导入编排（方案 §6.1/§6.4）：校验内容 → 解析 → 计算指纹 → 原子发布到版本目录。
 * 导入数据库事务失败不切换当前版本，也不留下可见的半版本；同指纹幂等。
 */

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export interface StrategyImportOutcome {
  catalogId: string;
  revisionId: string;
  created: boolean;
  report: ImportReport;
  entryCount: number;
}

export interface TemplateImportOutcome {
  catalogId: string;
  revisionId: string;
  created: boolean;
  report: ImportReport;
}

export async function importStrategyCatalog(
  db: Database.Database,
  buffer: Buffer,
  sourceFilename: string,
  now?: Date,
): Promise<StrategyImportOutcome> {
  const parsed = await parseStrategyImport(buffer);
  const catalog = getOrCreateCatalog(db, 'strategy', now);
  const fingerprint = sha256(buffer);
  const revision = createCatalogRevision(db, {
    catalogId: catalog.id,
    sourceFilename,
    sourceSha256: fingerprint,
    importReport: { ...parsed.report, kind: 'strategy' },
    strategyEntries: parsed.entries.map((entry) => ({
      modelKey: entry.modelKey,
      normalizedModelKey: normalizeModelKey(entry.normalizedModelKey),
      canonicalName: entry.canonicalName,
      categoryMindsetsJson: JSON.stringify(entry.categoryMindsets),
      primarySellingPointsJson: JSON.stringify(entry.primarySellingPoints),
      differentiatorsJson: JSON.stringify(entry.differentiators),
      searchTermsJson: JSON.stringify(entry.searchTerms),
      auxiliaryJson: JSON.stringify(entry.auxiliary),
      sourceRowsJson: JSON.stringify(entry.sourceRows),
      status: entry.status,
    })),
    now,
  });
  return { catalogId: catalog.id, revisionId: revision.revisionId, created: revision.created, report: parsed.report, entryCount: parsed.entries.length };
}

export async function importTemplateCatalog(
  db: Database.Database,
  buffer: Buffer,
  sourceFilename: string,
  now?: Date,
): Promise<TemplateImportOutcome> {
  const parsed = await parseTemplateImport(buffer);
  const catalog = getOrCreateCatalog(db, 'template', now);
  const fingerprint = sha256(buffer);

  // 指纹幂等：已导入过同内容直接返回既有修订，不重复落资产
  const existing = db.prepare(`SELECT id FROM script_studio_catalog_revisions WHERE catalogId = ? AND sourceSha256 = ?`)
    .get(catalog.id, fingerprint) as { id: string } | undefined;
  if (existing) {
    return { catalogId: catalog.id, revisionId: existing.id, created: false, report: parsed.templates.report };
  }

  // 模板资产需要先落盘到受管目录，再在同一事务里发布修订
  const revisionId = crypto.randomUUID();
  const persistedAssets = await persistTemplateAssets(revisionId, parsed.assets);

  let revision;
  try {
    revision = createCatalogRevision(db, {
      catalogId: catalog.id,
      sourceFilename,
      sourceSha256: fingerprint,
      importReport: { ...parsed.templates.report, kind: 'template' },
      frameworkTemplates: parsed.templates.frameworks.map((item) => ({
        stableKey: item.stableKey,
        name: item.name,
        subtype: item.subtype,
        structureJson: JSON.stringify(item.structure),
        sellingPointDensityJson: JSON.stringify(item.sellingPointDensity),
        applicableProductsJson: JSON.stringify(item.applicableProducts),
        preferredHookTypesJson: JSON.stringify(item.preferredHookTypes),
        secondaryHookTypesJson: JSON.stringify(item.secondaryHookTypes),
        sourceRow: item.sourceRow,
        status: item.status,
      })),
      copyHookTemplates: parsed.templates.copyHooks.map((item) => ({
        stableKey: item.stableKey,
        hookType: item.hookType,
        mechanism: item.mechanism,
        subtype: item.subtype,
        formula: item.formula,
        example: item.example,
        recommendedFrameworksJson: JSON.stringify(item.recommendedFrameworks),
        recommendedSellingPointTagsJson: JSON.stringify(item.recommendedSellingPointTags),
        sourceRow: item.sourceRow,
        status: item.status,
      })),
      visualHookTemplates: parsed.templates.visualHooks.map((item) => ({
        stableKey: item.stableKey,
        playGroup: item.playGroup,
        playName: item.playName,
        visualFormula: item.visualFormula,
        implementationAdvice: item.implementationAdvice,
        applicableProductsJson: JSON.stringify(item.applicableProducts),
        hookTagsJson: JSON.stringify(item.hookTags),
        referenceLinksJson: JSON.stringify(item.referenceLinks),
        notes: item.notes,
        sourceRow: item.sourceRow,
        status: item.status,
      })),
      templateAssets: persistedAssets,
      revisionId,
      now,
    });
  } catch (error) {
    // 发布事务失败：清理已落盘但未入册的参考图副本，不留孤儿资产。
    removePersistedTemplateAssets(revisionId);
    throw error;
  }
  return { catalogId: catalog.id, revisionId: revision.revisionId, created: revision.created, report: parsed.templates.report };
}

export { getCatalog };
