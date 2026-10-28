import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { readFormulaInputs } from './import-store.ts';
import { assertVideoContentAnalysis, type VideoContentModel } from '../../media-core/adapters/video-analysis.ts';
import { dataRoot } from '../../data-root.ts';
import { listAssetSources, resolveSourceFilePath } from '../media-catalog.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaVerifiedCandidate } from './candidate-media.ts';

export interface FormulaMaterialContent {
  description: string; category: string; sellingPoints: string[]; actions: string[];
  speech: 'yes' | 'no' | 'unknown';
  evidence: Array<{ field: 'description' | 'category' | 'sellingPoints' | 'actions' | 'speech'; source: 'filename' | 'material_table' | 'video_frame'; quote: string }>;
  conflicts?: Array<{ filenameQuote: string; tableQuote: string; message: string }>;
}
interface MaterialSource {
  bindingId: string; assetId: string; contentFingerprint: string; filename: string; logicalCode: string | null;
  table: { sessionId: string; sheet: string; row: number; cells: Record<string, string>; fields: Record<string, string> } | null;
}
export interface FormulaMaterialProfile {
  id: string; revision: number; inputFingerprint: string; origin: 'ai' | 'manual';
  content: FormulaMaterialContent; provenance: Record<string, unknown>;
}
export interface FormulaMaterialNoteItem {
  bindingId: string; sourceName: string; logicalCode: string | null; excluded: boolean; available: boolean;
  inputFingerprint: string; source: MaterialSource; profile: FormulaMaterialProfile | null; stale: boolean;
}
export interface FormulaMaterialOrganizeRun {
  id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; providerName: string; model: string;
  total: number; succeeded: number; skipped: number; errors: Array<{ bindingId: string; message: string }>; message: string | null;
}
export interface FormulaMaterialNotesView { revision: number; items: FormulaMaterialNoteItem[]; run: FormulaMaterialOrganizeRun | null }
const RUN_LEASE_MS = 90_000;
interface ProfileRow {
  id: string; bindingId: string; revision: number; inputFingerprint: string; origin: 'ai' | 'manual'; contentJson: string; provenanceJson: string;
}

export function readFormulaMaterialNotes(db: Database.Database, projectId: string, batchId: string): FormulaMaterialNotesView {
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const inputs = readFormulaInputs(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const runRow = collection ? db.prepare('SELECT * FROM live_mixcut_formula_material_organize_runs WHERE collectionId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1')
    .get(collection.id) as (Omit<FormulaMaterialOrganizeRun, 'errors'> & { errorsJson: string; updatedAt: string }) | undefined : undefined;
  const run: FormulaMaterialOrganizeRun | null = runRow ? { id: runRow.id, state: runRow.state, providerName: runRow.providerName, model: runRow.model,
    total: runRow.total, succeeded: runRow.succeeded, skipped: runRow.skipped, errors: JSON.parse(runRow.errorsJson), message: runRow.message } : null;
  if (run?.state === 'running' && Date.now() - Date.parse(runRow!.updatedAt) > RUN_LEASE_MS) {
    run.state = 'failed'; run.message = '上次整理已超时或中断，可继续整理未完成项';
  }
  const profiles = collection ? db.prepare('SELECT * FROM live_mixcut_formula_material_profiles WHERE collectionId=? ORDER BY revision DESC').all(collection.id) as ProfileRow[] : [];
  const current = new Map<string, FormulaMaterialProfile>();
  for (const row of profiles) {
    if (!current.has(row.bindingId)) current.set(row.bindingId, { id: row.id, revision: row.revision,
      inputFingerprint: row.inputFingerprint, origin: row.origin, content: JSON.parse(row.contentJson), provenance: JSON.parse(row.provenanceJson) });
  }
  const definitions = new Map((inputs.materials?.rows ?? []).flatMap(row => 'logicalCode' in row ? [[row.logicalCode, row] as const] : []));
  return { revision: index.revision, run, items: index.bindings.map(binding => {
    const definition = binding.logicalCode ? definitions.get(binding.logicalCode) : undefined;
    // 只提供内容判断需要的字段；原表中的盘符路径、下载链接等不发给模型。
    const fields = definition ? Object.fromEntries(Object.entries(definition.fields).filter(([key]) =>
      /描述|台词|动作|卖点|花字|类别|场景|分类|用途|口播|景别|运镜|平台/.test(key) && !/路径|链接|文件/.test(key))) : {};
    const source: MaterialSource = { bindingId: binding.id, assetId: binding.assetId, contentFingerprint: binding.contentFingerprint,
      filename: binding.sourceName, logicalCode: binding.logicalCode,
      table: definition ? { sessionId: inputs.materials!.sessionId, sheet: definition.source.sheet, row: definition.source.row,
        cells: Object.fromEntries(Object.keys(fields).map(key => [key, definition.source.cells[key]])), fields } : null };
    const inputFingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const profile = current.get(binding.id) ?? null;
    return { bindingId: binding.id, sourceName: binding.sourceName, logicalCode: binding.logicalCode,
      excluded: Boolean(binding.excludedReason), available: binding.available, source, inputFingerprint, profile,
      stale: Boolean(profile && profile.inputFingerprint !== inputFingerprint) };
  }) };
}

/** 只看视频画面；人工说明保留，画面观察不冒充原声或人工区间确认。 */
export async function organizeFormulaMaterialNotes(db: Database.Database, projectId: string, batchId: string,
  input: { expectedRevision: number; signal?: AbortSignal }, model: VideoContentModel,
): Promise<FormulaMaterialNotesView> {
  input.signal?.throwIfAborted();
  const promptVersion = 'formula-material-video/1';
  const started = db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const view = readFormulaMaterialNotes(db, projectId, batchId);
    if (view.revision !== input.expectedRevision) throw new BatchDomainError('conflict', '素材资料已更新，请刷新后重试');
    if (view.run?.state === 'running') throw new BatchDomainError('conflict', '此批次已经在整理素材，请等待完成');
    const collection = getFormulaCollection(db, projectId, batchId);
    const candidates = view.items.filter(item => !item.excluded && item.available);
    if (!collection || !candidates.length) throw new BatchDomainError('invalid_input', '请先导入可用的正式视频');
    const active = db.prepare("SELECT count(*) AS count FROM live_mixcut_formula_material_organize_runs WHERE state='running' AND providerId=? AND updatedAt>?")
      .get(model.id, new Date(Date.now() - RUN_LEASE_MS).toISOString()) as { count: number };
    if (active.count >= 2) throw new BatchDomainError('conflict', '此模型已有两批素材正在整理，请稍后重试');
    const pending = candidates.filter(item => !item.profile || (item.profile.origin === 'ai'
      && (item.stale || item.profile.provenance.visualObservation !== true)));
    if (pending.length > 2000) throw new BatchDomainError('invalid_input', '单批最多整理 2,000 个文件来源，请拆分批次');
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO live_mixcut_formula_material_organize_runs
      (id,collectionId,providerId,providerName,model,promptVersion,inputJson,state,total,skipped,startedAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,'running',?,?,?,?)`).run(id, collection.id, model.id, model.name, model.model, promptVersion,
      JSON.stringify(pending.map(item => ({ source: item.source, inputFingerprint: item.inputFingerprint, expectedProfileId: item.profile?.id ?? null }))),
      pending.length, candidates.length - pending.length, now, now);
    return { id, collectionId: collection.id, pending, skipped: candidates.length - pending.length };
  }).immediate();
  const timeout = AbortSignal.timeout(15 * 60_000);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  let succeeded = 0;
  let skipped = started.skipped;
  const errors: FormulaMaterialOrganizeRun['errors'] = [];
  function assertRunActive() {
    assertFormulaBatch(db, projectId, batchId, true);
    const row = db.prepare('SELECT state,updatedAt FROM live_mixcut_formula_material_organize_runs WHERE id=?').get(started.id) as { state: string; updatedAt: string };
    if (row.state !== 'running' || Date.now() - Date.parse(row.updatedAt) > RUN_LEASE_MS) throw new BatchDomainError('conflict', '这次整理已失效，请刷新后继续未完成项');
  }
  function update(state: FormulaMaterialOrganizeRun['state'], message: string | null = null,
    counts = { succeeded, skipped, errors }) {
    db.prepare('UPDATE live_mixcut_formula_material_organize_runs SET state=?,succeeded=?,skipped=?,errorsJson=?,message=?,updatedAt=? WHERE id=?')
      .run(state, counts.succeeded, counts.skipped, JSON.stringify(counts.errors), message, new Date().toISOString(), started.id);
  }
  // 抽帧/视觉调用可能超过一次租约周期；停止仍由请求信号及提交前检查共同约束。
  const heartbeat = setInterval(() => {
    db.prepare("UPDATE live_mixcut_formula_material_organize_runs SET updatedAt=? WHERE id=? AND state='running'")
      .run(new Date().toISOString(), started.id);
  }, 20_000);
  try {
    const chunkSize = 1;
    for (let offset = 0; offset < started.pending.length; offset += chunkSize) {
      signal.throwIfAborted();
      assertRunActive();
      const chunk = started.pending.slice(offset, offset + chunkSize);
      let entries: Array<{ bindingId: string; content: unknown }>;
      let candidate: FormulaVerifiedCandidate | null = null;
      try {
        if (!('analyze' in model)) throw new BatchDomainError('invalid_input', '请选择支持画面理解的模型');
        const item = chunk[0];
        candidate = await verifyFormulaCandidate(db, projectId, item.source.assetId, item.source.contentFingerprint,
          listAssetSources(db, item.source.assetId).map(source => ({ id: source.id, location: source.locationJson })), signal);
        if (!candidate) throw new BatchDomainError('invalid_input', '原片无法核验，请检查素材后重试');
        const cacheDir = path.join(dataRoot(), 'storage', 'live-mixcut', 'analysis', started.id, item.bindingId);
        try {
          const analysis = await model.analyze({ filePath: resolveSourceFilePath(candidate.location), assetId: item.source.assetId, cacheDir, signal });
          assertVideoContentAnalysis(analysis);
          const description = (analysis.summary || analysis.scenes.map(scene => scene.description).join('；')).slice(0, 400);
          const sellingPoints = analysis.sellingPoints.slice(0, 10).map(value => value.slice(0, 120));
          const actions = analysis.scenes.map(scene => scene.description).filter(Boolean).slice(0, 10).map(value => value.slice(0, 120));
          entries = [{ bindingId: item.bindingId, content: { description, category: '', sellingPoints, actions, speech: 'unknown',
            evidence: [{ field: 'description', source: 'video_frame', quote: description.slice(0, 300) },
              ...sellingPoints.map(quote => ({ field: 'sellingPoints', source: 'video_frame', quote })),
              ...actions.map(quote => ({ field: 'actions', source: 'video_frame', quote }))], conflicts: item.profile?.content.conflicts ?? [] } }];
        } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
      } catch (error) {
        signal.throwIfAborted();
        assertRunActive();
        const message = error instanceof BatchDomainError ? error.message : '模型整理失败，请检查模型配置后重试';
        errors.push(...chunk.map(item => ({ bindingId: item.bindingId, message })));
        update('running');
        continue;
      }
      const committed = db.transaction(() => {
        signal.throwIfAborted();
        assertRunActive();
        const latest = readFormulaMaterialNotes(db, projectId, batchId);
        let saved = 0;
        let superseded = 0;
        const failed: FormulaMaterialOrganizeRun['errors'] = [];
        for (const original of chunk) {
          const item = latest.items.find(item => item.bindingId === original.bindingId);
          if (!item || item.excluded || !item.available || item.inputFingerprint !== original.inputFingerprint) {
            failed.push({ bindingId: original.bindingId, message: '来源或素材表已变化，请重新整理' }); continue;
          }
          if ((item.profile?.id ?? null) !== (original.profile?.id ?? null)) {
            superseded++; continue; // 人工或其他请求已更新，旧模型响应不覆盖。
          }
          try {
            if (candidate) recheckFormulaCandidate(db, projectId, candidate);
            const content = validateContent(entries.find(entry => entry.bindingId === item.bindingId)!.content, item.source, true, true);
            appendProfile(db, started.collectionId, item, content, 'ai', { runId: started.id, providerId: model.id,
              providerName: model.name, model: model.model, promptVersion, basis: 'video_frames',
              visualObservation: true, timingAssessed: false, previousProfileId: item.profile?.id ?? null });
            saved++;
          } catch (error) {
            if (!(error instanceof BatchDomainError)) throw error;
            failed.push({ bindingId: item.bindingId, message: error.message });
          }
        }
        // 说明有自己的追加修订；不使正在预览的原表失效。生成输入须冻结确切 profileId。
        update('running', null, { succeeded: succeeded + saved, skipped: skipped + superseded, errors: [...errors, ...failed] });
        return { saved, superseded, failed };
      }).immediate();
      succeeded += committed.saved;
      skipped += committed.superseded;
      errors.push(...committed.failed);
    }
    update(errors.length ? 'failed' : 'completed', errors.length ? '部分素材尚未整理完成，可继续未完成项' : null);
  } catch (error) {
    update(signal.aborted ? 'cancelled' : 'failed', signal.aborted ? '本次整理已停止，已保存结果保留，可继续未完成项'
      : error instanceof BatchDomainError ? error.message : '本次整理中断，已保存结果保留');
  } finally { clearInterval(heartbeat); }
  return readFormulaMaterialNotes(db, projectId, batchId);
}

function validateContent(value: unknown, source: MaterialSource, requireEvidence: boolean, visual = false): FormulaMaterialContent {
  const invalid = () => new BatchDomainError('invalid_input', '素材内容格式或引用依据无效，请修改后重试');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['description', 'category', 'sellingPoints', 'actions', 'speech', 'evidence', 'conflicts'].includes(key))) throw invalid();
  const text = (key: string, max: number) => {
    const result = row[key];
    if (typeof result !== 'string' || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw invalid();
    return result.trim();
  };
  const list = (key: string) => {
    const result = row[key];
    if (!Array.isArray(result) || result.length > 12 || result.some(item => typeof item !== 'string' || !item.trim() || item.length > 120)) throw invalid();
    return [...new Set((result as string[]).map(item => item.trim()))];
  };
  const description = text('description', 400);
  const category = text('category', 100);
  if (!description || typeof row.speech !== 'string' || !['yes', 'no', 'unknown'].includes(row.speech) || !Array.isArray(row.evidence) || row.evidence.length > 24) throw invalid();
  const evidence: FormulaMaterialContent['evidence'] = row.evidence.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const entry = value as Record<string, unknown>;
    if (typeof entry.field !== 'string' || !['description','category','sellingPoints','actions','speech'].includes(entry.field)
      || typeof entry.source !== 'string' || !(visual ? ['video_frame'] : ['filename','material_table']).includes(entry.source) || typeof entry.quote !== 'string' || !entry.quote.trim() || entry.quote.length > 300) throw invalid();
    const sources = entry.source === 'filename' ? [source.filename] : Object.values(source.table?.fields ?? {});
    if (!visual && !sources.some(text => text.includes(entry.quote as string))) throw invalid();
    return { field: entry.field as FormulaMaterialContent['evidence'][number]['field'], source: entry.source as FormulaMaterialContent['evidence'][number]['source'], quote: entry.quote };
  });
  const rawConflicts = row.conflicts ?? [];
  if (!Array.isArray(rawConflicts) || rawConflicts.length > 6) throw invalid();
  const conflicts: NonNullable<FormulaMaterialContent['conflicts']> = rawConflicts.map(value => {
    if (!value || typeof value !== 'object') throw invalid();
    const item = value as Record<string, unknown>;
    if (typeof item.filenameQuote !== 'string' || !item.filenameQuote || item.filenameQuote.length > 300 || !source.filename.includes(item.filenameQuote)
      || typeof item.tableQuote !== 'string' || !item.tableQuote || item.tableQuote.length > 300 || !Object.values(source.table?.fields ?? {}).some(text => text.includes(item.tableQuote as string))
      || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 240) throw invalid();
    return { filenameQuote: item.filenameQuote, tableQuote: item.tableQuote, message: item.message.trim() };
  });
  const content = { description, category, sellingPoints: list('sellingPoints'), actions: list('actions'), speech: row.speech as FormulaMaterialContent['speech'], evidence, conflicts };
  if (requireEvidence) {
    for (const field of ['description','category','sellingPoints','actions','speech'] as const) {
      const hasValue = field === 'speech' ? content.speech !== 'unknown' : Boolean(content[field].length);
      if (hasValue && !evidence.some(item => item.field === field)) throw invalid();
    }
  }
  return content;
}

function appendProfile(db: Database.Database, collectionId: string, item: FormulaMaterialNoteItem, content: FormulaMaterialContent,
  origin: 'ai' | 'manual', provenance: Record<string, unknown>): FormulaMaterialProfile {
  const id = randomUUID();
  const revision = (item.profile?.revision ?? 0) + 1;
  db.prepare(`INSERT INTO live_mixcut_formula_material_profiles (id,collectionId,bindingId,revision,inputFingerprint,sourceJson,contentJson,origin,provenanceJson,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, collectionId, item.bindingId, revision, item.inputFingerprint, JSON.stringify(item.source), JSON.stringify(content), origin, JSON.stringify(provenance), new Date().toISOString());
  return { id, revision, inputFingerprint: item.inputFingerprint, origin, content, provenance };
}

export function saveFormulaMaterialNote(db: Database.Database, projectId: string, batchId: string, bindingId: string, input: {
  expectedRevision: number; expectedProfileId: string | null; content: FormulaMaterialContent;
}): FormulaMaterialProfile {
  return db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const view = readFormulaMaterialNotes(db, projectId, batchId);
    const item = view.items.find(item => item.bindingId === bindingId);
    if (!item) throw new BatchDomainError('not_found', '素材来源不存在');
    if (view.revision !== input.expectedRevision || (item.profile?.id ?? null) !== input.expectedProfileId) throw new BatchDomainError('conflict', '素材资料已更新，请刷新后重试');
    const collection = getFormulaCollection(db, projectId, batchId)!;
    const result = appendProfile(db, collection.id, item, validateContent(input.content, item.source, false), 'manual', { previousProfileId: item.profile?.id ?? null, basis: 'manual' });
    // 原表/编号来源修订不变；本条说明的 profileId 已推进，旧页保存会在上面被拒绝。
    return result;
  }).immediate();
}
