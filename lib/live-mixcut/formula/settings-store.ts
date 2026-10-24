import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { listBatchBgmTracks, type BatchBgmTrackView } from '../bgm.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { readFormulaInputs } from './import-store.ts';
import type { FormulaScriptRow } from './workbook.ts';
import { parseFormulaSettings, type FormulaSettings } from './settings.ts';
import { checkFormulaMusicSelection, selectFormulaMusicPool } from './settings-music.ts';
import { parseFormulaProductionSettings, type FormulaProductionOptions } from './production-settings.ts';
import { readFormulaProductionOptions, resolveFormulaProductionResources } from './production-options.ts';
import { parseFormulaTimingSettings } from './timing-settings.ts';
import { readFormulaInputEditing } from './input-editing.ts';

export interface FormulaSavedSettings {
  id: string; revision: number; scriptsSessionId: string; settings: FormulaSettings; totalCopies: number; createdAt: string;
}
export interface FormulaSettingsView {
  inputRevision: number; scriptsSessionId: string | null; scripts: FormulaScriptRow[];
  hasPendingScripts: boolean; editable: boolean; stale: boolean;
  saved: FormulaSavedSettings | null; tracks: BatchBgmTrackView[];
  productionOptions: FormulaProductionOptions;
}

export function readFormulaSettings(db: Database.Database, projectId: string, batchId: string): FormulaSettingsView {
  const inputs = readFormulaInputs(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const record = collection && db.prepare(`SELECT id,revision,scriptsSessionId,contentJson,createdAt FROM live_mixcut_formula_settings
    WHERE collectionId=? ORDER BY revision DESC LIMIT 1`).get(collection.id) as {
      id: string; revision: number; scriptsSessionId: string; contentJson: string; createdAt: string;
    } | undefined;
  const stored = record ? JSON.parse(record.contentJson) as FormulaSettings : null;
  const settings = stored ? { ...stored, production: parseFormulaProductionSettings(stored.production), timing: parseFormulaTimingSettings(stored.timing) } : null;
  const saved = record && settings ? { id: record.id, revision: record.revision, scriptsSessionId: record.scriptsSessionId,
    settings, totalCopies: settings.selections.reduce((total, item) => total + item.copies, 0), createdAt: record.createdAt } : null;
  const editable = readFormulaInputEditing(db, projectId, batchId).editable;
  return { inputRevision: inputs.revision, scriptsSessionId: inputs.scripts?.sessionId ?? null,
    scripts: (inputs.scripts?.rows ?? []).filter((row): row is FormulaScriptRow => 'scriptNumber' in row), editable,
    hasPendingScripts: inputs.drafts.some(draft => draft.kind === 'scripts' && draft.baseRevision === inputs.revision),
    stale: !!saved && saved.scriptsSessionId !== inputs.scripts?.sessionId,
    saved, tracks: listBatchBgmTracks(db), productionOptions: readFormulaProductionOptions(db) };
}

export async function saveFormulaSettings(db: Database.Database, projectId: string, batchId: string, input: {
  expectedInputRevision: number; expectedSettingsRevision: number; scriptsSessionId: string; settings: unknown; signal?: AbortSignal;
}): Promise<FormulaSettingsView> {
  if (!Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0
    || !Number.isSafeInteger(input.expectedSettingsRevision) || input.expectedSettingsRevision < 0
    || typeof input.scriptsSessionId !== 'string' || !input.scriptsSessionId) throw new BatchDomainError('invalid_input', '缺少有效的资料或设置版本');
  const readExpected = () => {
    assertFormulaBatch(db, projectId, batchId, true);
    const current = readFormulaSettings(db, projectId, batchId);
    if (current.inputRevision !== input.expectedInputRevision || current.scriptsSessionId !== input.scriptsSessionId) throw new BatchDomainError('conflict', '脚本或素材已更新，请刷新并重新核对选择');
    if (current.hasPendingScripts) throw new BatchDomainError('conflict', '有待确认的脚本预览，请先确认整表再保存生成设置');
    return current;
  };
  const before = readExpected();
  let settings: FormulaSettings;
  try {
    // 旧客户端只修改脚本/音乐时，保留已经保存的声音、包装与时长设置。
    const incoming = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
      ? { ...input.settings, production: 'production' in input.settings ? input.settings.production : before.saved?.settings.production,
        timing: 'timing' in input.settings ? input.settings.timing : before.saved?.settings.timing } : input.settings;
    settings = parseFormulaSettings(incoming, before.scripts.map(script => script.key));
  }
  catch (error) { throw new BatchDomainError('invalid_input', error instanceof Error ? error.message : '生成设置无效'); }
  const contentJson = JSON.stringify(settings);
  const checkedProduction = resolveFormulaProductionResources(db, settings.production);
  const checkedMusic = await checkFormulaMusicSelection(db, settings.bgm, input.signal);
  input.signal?.throwIfAborted();
  return db.transaction(() => {
    const current = readExpected();
    if (JSON.stringify(resolveFormulaProductionResources(db, settings.production)) !== JSON.stringify(checkedProduction)) {
      throw new BatchDomainError('conflict', '核验期间声音或封面预设已变化，请重新核对并保存');
    }
    if (JSON.stringify(selectFormulaMusicPool(db, settings.bgm)) !== JSON.stringify(checkedMusic)) throw new BatchDomainError('conflict', '核验期间曲库已变化，请重新保存设置');
    const revision = current.saved?.revision ?? 0;
    if (current.saved?.scriptsSessionId === input.scriptsSessionId && JSON.stringify(current.saved.settings) === contentJson
      && (revision === input.expectedSettingsRevision || revision === input.expectedSettingsRevision + 1)) return current;
    if (revision !== input.expectedSettingsRevision) throw new BatchDomainError('conflict', '设置已在其他页面更新，请重新读取后保存');
    const collection = getFormulaCollection(db, projectId, batchId)!;
    db.prepare(`INSERT INTO live_mixcut_formula_settings (id,collectionId,revision,scriptsSessionId,contentJson,createdAt) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), collection.id, revision + 1, input.scriptsSessionId, contentJson, new Date().toISOString());
    return readFormulaSettings(db, projectId, batchId);
  }).immediate();
}
