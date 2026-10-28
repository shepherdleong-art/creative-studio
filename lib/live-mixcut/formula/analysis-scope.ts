/**
 * 「分析画面」做哪些素材：只做这次要生成的那几条脚本用到的编号。
 *
 * 画面分析按素材段收费，没选中的脚本不该跟着花钱。分析入口、生成前检查和界面上的
 * 「待分析」计数都走这里同一份范围，避免三处各写一遍筛选后口径对不上。
 */
import type Database from 'better-sqlite3';
import { getFormulaCollection } from './collection-store.ts';
import { readFormulaInputs } from './import-store.ts';
import type { FormulaScriptRow } from './workbook.ts';

export interface FormulaAnalysisScope {
  /** 这次「分析画面」要处理的编号；null 表示不按编号收窄，整批非口播素材都算（还没导入脚本）。 */
  codes: string[] | null;
  /** 范围是怎么来的：选中脚本 / 全部脚本 / 整批素材。界面据此说明为什么是这个数。 */
  basis: 'selected-scripts' | 'all-scripts' | 'all-materials';
}

/** 已保存的生成设置里选中的脚本键；还没保存过设置时为 null（界面上还没选脚本）。 */
function selectedScriptKeys(db: Database.Database, collectionId: string): string[] | null {
  const row = db.prepare('SELECT contentJson FROM live_mixcut_formula_settings WHERE collectionId=? ORDER BY revision DESC LIMIT 1')
    .get(collectionId) as { contentJson: string } | undefined;
  if (!row) return null;
  try {
    const content = JSON.parse(row.contentJson) as { selections?: unknown };
    if (!Array.isArray(content.selections)) return null;
    return content.selections.flatMap(item => {
      const key = (item as { key?: unknown } | null)?.key;
      return typeof key === 'string' ? [key] : [];
    });
  } catch { return null; }
}

/**
 * 范围：选中的脚本用到的编号。还没保存过选择、或选择对不上任何脚本时退回全部脚本；
 * 连脚本都没导入才退回整批素材。
 *
 * `scripts` 可传入调用方已经读过的行，省掉重复解析整张脚本表。
 */
export function readFormulaAnalysisScope(db: Database.Database, projectId: string, batchId: string,
  scripts?: readonly FormulaScriptRow[]): FormulaAnalysisScope {
  const collection = getFormulaCollection(db, projectId, batchId);
  const rows = scripts ?? (readFormulaInputs(db, projectId, batchId).scripts?.rows ?? [])
    .filter((row): row is FormulaScriptRow => 'scriptNumber' in row);
  const selected = new Set(collection ? selectedScriptKeys(db, collection.id) ?? [] : []);
  const codes = new Set(rows.filter(row => selected.has(row.key)).flatMap(row => row.codes));
  if (codes.size) return { codes: [...codes], basis: 'selected-scripts' };
  const all = new Set(rows.flatMap(row => row.codes));
  return all.size ? { codes: [...all], basis: 'all-scripts' } : { codes: null, basis: 'all-materials' };
}

/** 这段素材是否在本次分析范围内。范围按编号收窄时，没填编号的素材不算在内。 */
export function inFormulaAnalysisScope(scope: FormulaAnalysisScope, logicalCode: string | null): boolean {
  if (!scope.codes) return true;
  return Boolean(logicalCode) && scope.codes.includes(logicalCode!);
}
