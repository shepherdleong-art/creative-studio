import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import { readLiveMixcutProject } from './projects.ts';
import {
  createBatchProduction,
  getBatchProduction,
  listProjectBatchProductions,
  type BatchProductionRow,
} from './versions.ts';
import { getFormulaCollection } from './formula/collection-store.ts';

export interface LiveMixcutBatch extends BatchProductionRow {
  /** 兼容字段；新规矩下一个任务只有一个「成片」文件夹，恒为空。 */
  batchExportDirName: string;
}

/**
 * 一个任务只有一个导出目录和「成片」文件夹，不再按批次分子目录。
 * 版本号按同一套冻结导出身份（原脚本号、份次、包装）在文件夹内接着排。
 */
export function resolveLiveMixcutBatchExport(db: Database.Database, projectId: string, batchId: string): {
  exportDirName: string; batchExportDirName: string;
} {
  const row = db.prepare(`SELECT p.exportDirName FROM live_mixcut_projects p
    JOIN live_mixcut_productions b ON b.projectId=p.id
    WHERE p.id=? AND b.id=? AND p.deletedAt IS NULL AND b.deletedAt IS NULL`)
    .get(projectId, batchId) as { exportDirName: string } | undefined;
  if (!row) throw new BatchDomainError('not_found', '批次不存在');
  return { exportDirName: row.exportDirName, batchExportDirName: '' };
}

export function getLiveMixcutBatchExportDirName(db: Database.Database, projectId: string, batchId: string): string {
  return resolveLiveMixcutBatchExport(db, projectId, batchId).exportDirName;
}

export function listLiveMixcutBatches(db: Database.Database, projectId: string, options: { includeArchived?: boolean } = {}): LiveMixcutBatch[] {
  readLiveMixcutProject(db, projectId);
  return listProjectBatchProductions(db, projectId, options).map(batch => ({
    ...batch, batchExportDirName: resolveLiveMixcutBatchExport(db, projectId, batch.id).batchExportDirName,
  }));
}

export function readLiveMixcutBatch(db: Database.Database, projectId: string, batchId: string): LiveMixcutBatch {
  const batch = getBatchProduction(db, projectId, batchId);
  if (!batch) throw new BatchDomainError('not_found', '批次不存在');
  return { ...batch, batchExportDirName: resolveLiveMixcutBatchExport(db, projectId, batchId).batchExportDirName };
}

function currentMaterialDefinitions(source: { materialsSessionId: string | null },
  sessions: Array<Record<string, unknown> & { id: string }>, sessionIds: Map<string, string>): Map<string, Record<string, unknown>> {
  const definitions = new Map<string, Record<string, unknown>>();
  if (!source.materialsSessionId) return definitions;
  const session = sessions.find(item => item.id === source.materialsSessionId);
  const sessionId = sessionIds.get(source.materialsSessionId);
  if (!session || !sessionId) return definitions;
  const preview = JSON.parse(String(session.previewJson)) as { rows?: Array<Record<string, unknown>>; issues?: Array<Record<string, unknown>> };
  const excluded = new Set(JSON.parse(String(session.excludedKeysJson)) as string[]);
  for (const row of preview.rows ?? []) {
    if (excluded.has(String(row.key))) continue;
    const original = row.source && typeof row.source === 'object' && !Array.isArray(row.source)
      ? row.source as { cells?: Record<string, unknown>; fields?: Record<string, unknown> } : {};
    const fields = Object.fromEntries(Object.entries(original.fields ?? {}).filter(([key]) => (
      /描述|台词|动作|卖点|花字|类别|场景|分类|用途|口播|景别|运镜|平台/.test(key) && !/路径|链接|文件/.test(key)
    )));
    const cells = Object.fromEntries(Object.keys(fields).map(key => [key, original.cells?.[key]]));
    definitions.set(String(row.logicalCode), { sessionId, cells, fields });
  }
  return definitions;
}

/** 复制已确认输入和人工核对，不复制成片、任务、生成历史或未确认的导入草稿。 */
function cloneFormulaInputs(db: Database.Database, projectId: string, sourceBatchId: string, targetBatchId: string): void {
  const source = getFormulaCollection(db, projectId, sourceBatchId);
  if (!source) return;
  const now = new Date().toISOString();
  const collectionId = randomUUID();
  db.prepare(`INSERT INTO live_mixcut_formula_collections
    (id,projectId,batchId,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`)
    .run(collectionId, projectId, targetBatchId, source.revision, now, now);
  const sessions = db.prepare(`SELECT * FROM live_mixcut_formula_import_sessions
    WHERE collectionId=? AND state='confirmed' ORDER BY createdAt,id`).all(source.id) as Array<Record<string, unknown> & { id: string }>;
  const sessionIds = new Map<string, string>();
  const insertSession = db.prepare(`INSERT INTO live_mixcut_formula_import_sessions
    (id,collectionId,kind,fingerprint,filename,baseRevision,previewJson,state,excludedKeysJson,confirmedRevision,
      createdAt,workbookBytes,draftRevision,extractionJson) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const session of sessions) {
    const id = randomUUID();
    sessionIds.set(session.id, id);
    insertSession.run(id, collectionId, session.kind, session.fingerprint, session.filename, session.baseRevision,
      session.previewJson, session.state, session.excludedKeysJson, session.confirmedRevision,
      session.createdAt, session.workbookBytes, session.draftRevision, session.extractionJson);
  }
  db.prepare('UPDATE live_mixcut_formula_collections SET materialsSessionId=?,scriptsSessionId=? WHERE id=?')
    .run(source.materialsSessionId ? sessionIds.get(source.materialsSessionId)! : null,
      source.scriptsSessionId ? sessionIds.get(source.scriptsSessionId)! : null, collectionId);

  const bindings = db.prepare('SELECT * FROM live_mixcut_formula_asset_bindings WHERE collectionId=? ORDER BY createdAt,id')
    .all(source.id) as Array<Record<string, unknown> & { id: string }>;
  const bindingIds = new Map<string, string>();
  const insertBinding = db.prepare(`INSERT INTO live_mixcut_formula_asset_bindings
    (id,collectionId,assetId,contentFingerprint,sourceName,sourcePath,detectedCode,logicalCode,excludedReason,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const binding of bindings) {
    const id = randomUUID();
    bindingIds.set(binding.id, id);
    insertBinding.run(id, collectionId, binding.assetId, binding.contentFingerprint, binding.sourceName, binding.sourcePath,
      binding.detectedCode, binding.logicalCode, binding.excludedReason, binding.createdAt, binding.updatedAt);
  }
  const currentProfiles = new Map<string, Record<string, unknown> & { bindingId: string }>();
  const profiles = db.prepare('SELECT * FROM live_mixcut_formula_material_profiles WHERE collectionId=? ORDER BY revision DESC,id')
    .all(source.id) as Array<Record<string, unknown> & { bindingId: string }>;
  for (const profile of profiles) if (!currentProfiles.has(profile.bindingId)) currentProfiles.set(profile.bindingId, profile);
  const currentDefinitions = currentMaterialDefinitions(source, sessions, sessionIds);
  for (const [sourceBindingId, bindingId] of bindingIds) {
    const binding = bindings.find(item => item.id === sourceBindingId)!;
    const previous = currentProfiles.get(sourceBindingId);
    if (!previous) continue;
    const previousSource = JSON.parse(String(previous.sourceJson)) as Record<string, unknown>;
    const previousTable = previousSource.table && typeof previousSource.table === 'object' && !Array.isArray(previousSource.table)
      ? previousSource.table as Record<string, unknown> : null;
    const table = previousTable ? Object.fromEntries(Object.entries(previousTable).map(([key, value]) => [
      key, key === 'sessionId' ? currentDefinitions.get(String(binding.logicalCode))?.sessionId ?? value : value,
    ])) : null;
    // 保留原始证据形状与键序，只替换新批次身份，避免手工重组改变来源指纹。
    const sourceRecord = Object.fromEntries(Object.entries(previousSource).map(([key, value]) => [
      key, key === 'bindingId' ? bindingId : key === 'table' ? table : value,
    ]));
    const inputFingerprint = createHash('sha256').update(JSON.stringify(sourceRecord)).digest('hex');
    const sourceJson = JSON.stringify(sourceRecord);
    const contentJson = JSON.stringify(JSON.parse(String(previous.contentJson)));
    const provenanceJson = JSON.stringify({ ...JSON.parse(String(previous.provenanceJson)), copiedFromProfileId: previous.id });
    db.prepare(`INSERT INTO live_mixcut_formula_material_profiles
      (id,collectionId,bindingId,revision,inputFingerprint,sourceJson,contentJson,origin,provenanceJson,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), collectionId, bindingId, Number(previous.revision) + 1, inputFingerprint,
        sourceJson, contentJson, previous.origin, provenanceJson, now);
  }

  // 只带当前生效的人工核对；音频记录继续引用不可变的受管文件，不复制媒体。
  const insertSpeech = db.prepare(`INSERT INTO live_mixcut_formula_manual_speech
    (id,collectionId,assetId,contentFingerprint,revision,baseInputRevision,contentJson,createdAt) VALUES (?,?,?,?,?,?,?,?)`);
  for (const assetId of new Set(bindings.map(binding => String(binding.assetId)))) {
    const speech = db.prepare(`SELECT m.* FROM live_mixcut_formula_manual_speech m
      WHERE m.collectionId=? AND m.assetId=? AND m.revision <= ? ORDER BY m.revision DESC LIMIT 1`)
      .get(source.id, assetId, source.revision) as Record<string, unknown> | undefined;
    if (!speech) continue;
    insertSpeech.run(randomUUID(), collectionId, assetId, speech.contentFingerprint, 1,
      source.revision, speech.contentJson, speech.createdAt);
  }
  for (const assetId of new Set(bindings.map(binding => String(binding.assetId)))) {
    const range = db.prepare(`SELECT r.* FROM live_mixcut_formula_asset_ranges r WHERE r.collectionId=? AND r.assetId=?
      AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_asset_ranges newer
        WHERE newer.collectionId=r.collectionId AND newer.assetId=r.assetId AND newer.revision>r.revision)`)
      .get(source.id, assetId) as { contentJson: string } | undefined;
    if (!range) continue;
    const content = JSON.parse(range.contentJson) as { ranges: Array<Record<string, unknown>> };
    const clonedContent = { ...content, ranges: content.ranges.map(item => ({ ...item, id: randomUUID() })) };
    db.prepare(`INSERT INTO live_mixcut_formula_asset_ranges
      (id,collectionId,assetId,contentFingerprint,revision,contentJson,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), collectionId, assetId, bindings.find(item => item.assetId === assetId)!.contentFingerprint,
        1, JSON.stringify(clonedContent), now);
  }
  const hint = db.prepare('SELECT * FROM live_mixcut_formula_replacement_hints WHERE collectionId=? ORDER BY baseInputRevision DESC LIMIT 1')
    .get(source.id) as Record<string, unknown> | undefined;
  if (hint) {
    db.prepare(`INSERT INTO live_mixcut_formula_replacement_hints
      (id,collectionId,baseInputRevision,filename,fingerprint,hintsJson,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), collectionId, source.revision, hint.filename, hint.fingerprint, hint.hintsJson, hint.createdAt);
  }
  const narrations = db.prepare(`SELECT n.* FROM live_mixcut_formula_external_narrations n WHERE n.collectionId=?
    AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_external_narrations newer
      WHERE newer.collectionId=n.collectionId AND newer.scriptsSessionId=n.scriptsSessionId
        AND newer.scriptKey=n.scriptKey AND newer.revision>n.revision)`).all(source.id) as Array<Record<string, unknown> & { scriptsSessionId: string }>;
  const insertNarration = db.prepare(`INSERT INTO live_mixcut_formula_external_narrations
    (id,collectionId,scriptsSessionId,scriptKey,revision,baseInputRevision,inputHash,contentJson,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const narration of narrations) {
    const scriptsSessionId = sessionIds.get(narration.scriptsSessionId);
    if (!scriptsSessionId) continue;
    const id = randomUUID();
    const content = JSON.parse(String(narration.contentJson)) as { audio?: { externalNarrationId?: string } | null };
    const contentJson = JSON.stringify({ ...content, ...(content.audio ? { audio: { ...content.audio, externalNarrationId: id } } : {}) });
    insertNarration.run(id, collectionId, scriptsSessionId, narration.scriptKey, narration.revision,
      narration.baseInputRevision, narration.inputHash, contentJson, narration.createdAt);
  }
  const settings = db.prepare('SELECT * FROM live_mixcut_formula_settings WHERE collectionId=? ORDER BY revision DESC LIMIT 1')
    .get(source.id) as (Record<string, unknown> & { scriptsSessionId: string; revision: number }) | undefined;
  if (settings) {
    const scriptsSessionId = sessionIds.get(settings.scriptsSessionId);
    if (!scriptsSessionId) throw new BatchDomainError('conflict', '原批次的脚本设置引用不完整，无法复制');
    db.prepare(`INSERT INTO live_mixcut_formula_settings
      (id,collectionId,revision,scriptsSessionId,contentJson,createdAt) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), collectionId, settings.revision, scriptsSessionId, settings.contentJson, settings.createdAt);
  }
}

export function createLiveMixcutBatch(db: Database.Database, projectId: string, input: {
  name?: unknown;
  sourceBatchId?: unknown;
  /** 默认复制 sourceBatchId 的输入；false 创建空白批次。 */
  copyInputs?: unknown;
}): LiveMixcutBatch {
  readLiveMixcutProject(db, projectId);
  const copyInputs = input.copyInputs !== false;
  const sourceBatchId = typeof input.sourceBatchId === 'string' && input.sourceBatchId ? input.sourceBatchId : null;
  if (copyInputs && !sourceBatchId) throw new BatchDomainError('invalid_input', '请选择要复制的当前批次，或改为创建空白批次');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim().length > 80)) {
    throw new BatchDomainError('invalid_input', '批次名最多 80 个字');
  }
  return db.transaction(() => {
    if (sourceBatchId) readLiveMixcutBatch(db, projectId, sourceBatchId);
    const count = db.prepare('SELECT count(*) AS count FROM live_mixcut_productions WHERE projectId=?').get(projectId) as { count: number };
    const fallback = `批次 ${count.count + 1}`;
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallback;
    const id = createBatchProduction(db, projectId, name, undefined, { planningMode: 'formula' });
    if (copyInputs && sourceBatchId) cloneFormulaInputs(db, projectId, sourceBatchId, id);
    return readLiveMixcutBatch(db, projectId, id);
  }).immediate();
}
