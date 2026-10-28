import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { readFormulaInputs } from './import-store.ts';
import { assertVideoContentAnalysis, type VideoContentAnalysis, type VideoContentModel } from '../../media-core/adapters/video-analysis.ts';
import type { FormulaScriptRow } from './workbook.ts';
import { dataRoot } from '../../data-root.ts';
import { sanitizeMessage } from '../../log-sanitize.ts';
import { listAssetSources, resolveSourceFilePath } from '../media-catalog.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaVerifiedCandidate } from './candidate-media.ts';
import { inFormulaAnalysisScope, readFormulaAnalysisScope, type FormulaAnalysisScope } from './analysis-scope.ts';
import {
  formulaAnalysisDescription, listFormulaMaterialAnalyses, saveFormulaMaterialAnalysis,
  type FormulaMaterialAnalysis,
} from './material-analysis.ts';
import { isVoiceOver } from '../scheduling/text.ts';

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
  /** 口播镜头：不看画面，有效片段按原声说话起止算。 */
  voiceOver: boolean;
  /** 在本次「分析画面」的范围内：只有选中的脚本用到的编号才算，没选中的脚本不花钱。 */
  inScope: boolean;
  inputFingerprint: string; source: MaterialSource; profile: FormulaMaterialProfile | null; stale: boolean;
  /** 这段素材的画面分析（按内容指纹存在项目下，换批次也认得）；界面只需要有效片段和描述。 */
  analysis: FormulaMaterialAnalysisView | null;
}
export type FormulaMaterialAnalysisView = Pick<FormulaMaterialAnalysis, 'id' | 'durationUs' | 'usableInUs' | 'usableOutUs' | 'description'>;
export interface FormulaMaterialOrganizeRun {
  id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; providerName: string; model: string;
  total: number; succeeded: number; skipped: number; errors: Array<{ bindingId: string; message: string }>; message: string | null;
}
export interface FormulaMaterialNotesView {
  revision: number; items: FormulaMaterialNoteItem[]; run: FormulaMaterialOrganizeRun | null;
  /** 这次「分析画面」的范围：只做选中脚本用到的编号。 */
  analysisScope: FormulaAnalysisScope;
}
const RUN_LEASE_MS = 90_000;

/** 上游偶发抖动：一次失败不动结论，留一拍再试一次。被停机打断时不重试。 */
async function retryOnce<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) throw error;
    await new Promise(resolve => setTimeout(resolve, 1_500));
    signal.throwIfAborted();
    return work();
  }
}

/**
 * 失败原因要能分辨是限流、额度还是配置问题。保留脱敏后的上游原话；
 * 业务错误已经写着可读原因，原样返回。
 */
function describeAnalysisFailure(error: unknown): string {
  if (error instanceof BatchDomainError) return error.message;
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const detail = sanitizeMessage(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
  return detail ? `模型分析失败：${detail}` : '模型分析失败，请检查模型配置后重试';
}
interface ProfileRow {
  id: string; bindingId: string; revision: number; inputFingerprint: string; origin: 'ai' | 'manual'; contentJson: string; provenanceJson: string;
}

export function readFormulaMaterialNotes(db: Database.Database, projectId: string, batchId: string): FormulaMaterialNotesView {
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const inputs = readFormulaInputs(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const scope = readFormulaAnalysisScope(db, projectId, batchId,
    (inputs.scripts?.rows ?? []).filter((row): row is FormulaScriptRow => 'scriptNumber' in row));
  const runRow = collection ? db.prepare('SELECT * FROM live_mixcut_formula_material_organize_runs WHERE collectionId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1')
    .get(collection.id) as (Omit<FormulaMaterialOrganizeRun, 'errors'> & { errorsJson: string; updatedAt: string }) | undefined : undefined;
  const run: FormulaMaterialOrganizeRun | null = runRow ? { id: runRow.id, state: runRow.state, providerName: runRow.providerName, model: runRow.model,
    total: runRow.total, succeeded: runRow.succeeded, skipped: runRow.skipped, errors: JSON.parse(runRow.errorsJson), message: runRow.message } : null;
  if (run?.state === 'running' && Date.now() - Date.parse(runRow!.updatedAt) > RUN_LEASE_MS) {
    run.state = 'failed'; run.message = '上次分析已超时或中断，可继续分析未完成项';
  }
  const profiles = collection ? db.prepare('SELECT * FROM live_mixcut_formula_material_profiles WHERE collectionId=? ORDER BY revision DESC').all(collection.id) as ProfileRow[] : [];
  const analyses = listFormulaMaterialAnalyses(db, projectId);
  const current = new Map<string, FormulaMaterialProfile>();
  for (const row of profiles) {
    if (!current.has(row.bindingId)) current.set(row.bindingId, { id: row.id, revision: row.revision,
      inputFingerprint: row.inputFingerprint, origin: row.origin, content: JSON.parse(row.contentJson), provenance: JSON.parse(row.provenanceJson) });
  }
  const definitions = new Map((inputs.materials?.rows ?? []).flatMap(row => 'logicalCode' in row ? [[row.logicalCode, row] as const] : []));
  return { revision: index.revision, run, analysisScope: scope, items: index.bindings.map(binding => {
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
    const analysis = analyses.get(binding.contentFingerprint) ?? null;
    return { bindingId: binding.id, sourceName: binding.sourceName, logicalCode: binding.logicalCode,
      excluded: Boolean(binding.excludedReason), available: binding.available,
      voiceOver: isVoiceOver(binding.logicalCode ?? ''),
      inScope: inFormulaAnalysisScope(scope, binding.logicalCode),
      inputFingerprint, source, profile,
      stale: Boolean(profile && profile.inputFingerprint !== inputFingerprint),
      analysis: analysis ? { id: analysis.id, durationUs: analysis.durationUs, usableInUs: analysis.usableInUs,
        usableOutUs: analysis.usableOutUs, description: analysis.description } : null };
  }) };
}

/** 只看视频画面；人工说明保留，画面观察不冒充原声或人工区间确认。 */
/** 画面分析结果转成素材说明；不冒充原声，也不覆盖已有的人工核对结果。 */
function contentFromAnalysis(analysis: VideoContentAnalysis, conflicts: FormulaMaterialContent['conflicts']): FormulaMaterialContent {
  const description = formulaAnalysisDescription(analysis);
  if (!description) throw new BatchDomainError('invalid_input', '模型没有给出画面描述，请重试或手动填写说明');
  const sellingPoints = [...new Set(analysis.sellingPoints.map(value => value.slice(0, 120).trim()).filter(Boolean))].slice(0, 10);
  const actions = [...new Set(analysis.scenes.map(scene => scene.description.slice(0, 120).trim()).filter(Boolean))].slice(0, 10);
  return {
    description, category: '', sellingPoints, actions, speech: 'unknown',
    evidence: [
      { field: 'description', source: 'video_frame', quote: description.slice(0, 300) },
      ...sellingPoints.map(quote => ({ field: 'sellingPoints' as const, source: 'video_frame' as const, quote })),
      ...actions.map(quote => ({ field: 'actions' as const, source: 'video_frame' as const, quote })),
    ],
    conflicts,
  };
}

interface CommitEntry {
  bindingId: string; inputFingerprint: string; expectedProfileId: string | null;
  content: unknown; provenance: Record<string, unknown>;
}

/**
 * 分析画面：用户点开始、选好视觉模型后才调用。
 * 口播镜头不看画面；同一段内容在项目里只分析一次，换批次只补写这条来源的说明。
 */
export async function organizeFormulaMaterialNotes(db: Database.Database, projectId: string, batchId: string,
  input: { expectedRevision: number; signal?: AbortSignal }, model: VideoContentModel,
): Promise<FormulaMaterialNotesView> {
  input.signal?.throwIfAborted();
  const promptVersion = 'formula-material-video/1';
  const started = db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const view = readFormulaMaterialNotes(db, projectId, batchId);
    if (view.revision !== input.expectedRevision) throw new BatchDomainError('conflict', '素材资料已更新，请刷新后重试');
    if (view.run?.state === 'running') throw new BatchDomainError('conflict', '此批次正在分析画面，请等待完成');
    const collection = getFormulaCollection(db, projectId, batchId);
    // 口播镜头的有效片段按原声说话起止算，不看画面；
    // 只做这次选中脚本用到的编号，没选中的脚本不跟着花钱。
    const candidates = view.items.filter(item => !item.excluded && item.available && !item.voiceOver && item.inScope);
    if (!collection || !candidates.length) throw new BatchDomainError('invalid_input', view.analysisScope.basis === 'selected-scripts'
      ? '选中的脚本没有可分析的画面素材，请检查素材编号，或先在第二步选中脚本'
      : '请先导入可用的正式视频；口播镜头不做画面分析');
    const active = db.prepare("SELECT count(*) AS count FROM live_mixcut_formula_material_organize_runs WHERE state='running' AND providerId=? AND updatedAt>?")
      .get(model.id, new Date(Date.now() - RUN_LEASE_MS).toISOString()) as { count: number };
    if (active.count >= 2) throw new BatchDomainError('conflict', '此模型已有两批素材在分析画面，请稍后重试');
    const pending = candidates.filter(item => !item.profile || (item.profile.origin === 'ai'
      && (item.stale || item.profile.provenance.visualObservation !== true)));
    if (pending.length > 2000) throw new BatchDomainError('invalid_input', '单批最多分析 2,000 个文件来源，请拆分批次');
    // 已经分析过同一段内容的素材不再调模型；只把这段来源的说明补上。
    const cached = listFormulaMaterialAnalyses(db, projectId);
    const modelWork = pending.filter(item => !cached.has(item.source.contentFingerprint));
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO live_mixcut_formula_material_organize_runs
      (id,collectionId,providerId,providerName,model,promptVersion,inputJson,state,total,skipped,startedAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,'running',?,?,?,?)`).run(id, collection.id, model.id, model.name, model.model, promptVersion,
      JSON.stringify(modelWork.map(item => ({ source: item.source, inputFingerprint: item.inputFingerprint, expectedProfileId: item.profile?.id ?? null }))),
      pending.length, candidates.length - pending.length, now, now);
    return { id, collectionId: collection.id, pending, cached, modelWork, skipped: candidates.length - pending.length };
  }).immediate();
  const timeout = AbortSignal.timeout(15 * 60_000);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  let succeeded = 0;
  let skipped = started.skipped;
  const errors: FormulaMaterialOrganizeRun['errors'] = [];
  function assertRunActive() {
    assertFormulaBatch(db, projectId, batchId, true);
    const row = db.prepare('SELECT state,updatedAt FROM live_mixcut_formula_material_organize_runs WHERE id=?').get(started.id) as { state: string; updatedAt: string };
    if (row.state !== 'running' || Date.now() - Date.parse(row.updatedAt) > RUN_LEASE_MS) throw new BatchDomainError('conflict', '这次分析已失效，请刷新后继续未完成项');
  }
  function update(state: FormulaMaterialOrganizeRun['state'], message: string | null = null,
    counts = { succeeded, skipped, errors }) {
    db.prepare('UPDATE live_mixcut_formula_material_organize_runs SET state=?,succeeded=?,skipped=?,errorsJson=?,message=?,updatedAt=? WHERE id=?')
      .run(state, counts.succeeded, counts.skipped, JSON.stringify(counts.errors), message, new Date().toISOString(), started.id);
  }
  function commit(entries: readonly CommitEntry[], candidate: FormulaVerifiedCandidate | null) {
    return db.transaction(() => {
      signal.throwIfAborted();
      assertRunActive();
      const latest = readFormulaMaterialNotes(db, projectId, batchId);
      let saved = 0;
      let superseded = 0;
      const failed: FormulaMaterialOrganizeRun['errors'] = [];
      for (const entry of entries) {
        const item = latest.items.find(item => item.bindingId === entry.bindingId);
        if (!item || item.excluded || !item.available || item.inputFingerprint !== entry.inputFingerprint) {
          failed.push({ bindingId: entry.bindingId, message: '来源或素材表已变化，请重新分析' }); continue;
        }
        if ((item.profile?.id ?? null) !== entry.expectedProfileId) {
          superseded++; continue; // 人工或其他请求已更新，旧结果不覆盖。
        }
        try {
          if (candidate) recheckFormulaCandidate(db, projectId, candidate);
          const content = validateContent(entry.content, item.source, true, true);
          appendProfile(db, started.collectionId, item, content, 'ai', { runId: started.id, promptVersion,
            ...entry.provenance, previousProfileId: item.profile?.id ?? null });
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
  }
  // 抽帧/视觉调用可能超过一次租约周期；停止仍由请求信号及提交前检查共同约束。
  const heartbeat = setInterval(() => {
    db.prepare("UPDATE live_mixcut_formula_material_organize_runs SET updatedAt=? WHERE id=? AND state='running'")
      .run(new Date().toISOString(), started.id);
  }, 20_000);
  try {
    // 这段素材之前已经分析过：直接按缓存补说明，不花模型费。
    const cachedWork = started.pending.filter(item => started.cached.has(item.source.contentFingerprint));
    if (cachedWork.length) {
      const entries: CommitEntry[] = [];
      for (const item of cachedWork) {
        const analysis = started.cached.get(item.source.contentFingerprint)!;
        try {
          entries.push({ bindingId: item.bindingId, inputFingerprint: item.inputFingerprint,
            expectedProfileId: item.profile?.id ?? null,
            content: contentFromAnalysis(analysis.analysis, item.profile?.content.conflicts ?? []),
            provenance: { providerId: analysis.providerId, providerName: analysis.providerName, model: analysis.model,
              basis: 'video_frames', visualObservation: true, timingAssessed: false, analysisId: analysis.id } });
        } catch (error) {
          if (!(error instanceof BatchDomainError)) throw error;
          errors.push({ bindingId: item.bindingId, message: error.message });
        }
      }
      if (entries.length) {
        const committed = commit(entries, null);
        succeeded += committed.saved;
        skipped += committed.superseded;
        errors.push(...committed.failed);
      }
    }
    for (const item of started.modelWork) {
      signal.throwIfAborted();
      assertRunActive();
      let entry: CommitEntry | null = null;
      let candidate: FormulaVerifiedCandidate | null = null;
      try {
        if (!('analyze' in model)) throw new BatchDomainError('invalid_input', '请选择支持画面理解的模型');
        candidate = await verifyFormulaCandidate(db, projectId, item.source.assetId, item.source.contentFingerprint,
          listAssetSources(db, item.source.assetId).map(source => ({ id: source.id, location: source.locationJson })), signal);
        if (!candidate) throw new BatchDomainError('invalid_input', '原片无法核验，请检查素材后重试');
        const cacheDir = path.join(dataRoot(), 'storage', 'live-mixcut', 'analysis', started.id, item.bindingId);
        try {
          // 上游会偶发抖动（同一段素材过一会儿再跑就成功）。一条素材最多试两次，
          // 仍然失败才记下来；每次重试前留一拍，避免连续撞同一个瞬时故障。
          const analysis = await retryOnce(() => model.analyze({ filePath: resolveSourceFilePath(candidate!.location),
            assetId: item.source.assetId, cacheDir, signal }), signal);
          assertVideoContentAnalysis(analysis);
          const content = contentFromAnalysis(analysis, item.profile?.content.conflicts ?? []);
          // 先按内容存下分析结果：说明写入失败也不用来回重花模型费。
          const saved = saveFormulaMaterialAnalysis(db, projectId, { contentFingerprint: item.source.contentFingerprint, analysis,
            provider: { id: model.id, name: model.name, model: model.model } });
          entry = { bindingId: item.bindingId, inputFingerprint: item.inputFingerprint,
            expectedProfileId: item.profile?.id ?? null, content,
            provenance: { providerId: model.id, providerName: model.name, model: model.model, basis: 'video_frames',
              visualObservation: true, timingAssessed: false, analysisId: saved.id } };
        } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
      } catch (error) {
        signal.throwIfAborted();
        assertRunActive();
        // 记住上游给的原话，才分得清是限流、额度还是模型配置。消息已脱敏，不含密钥和签名。
        errors.push({ bindingId: item.bindingId, message: describeAnalysisFailure(error) });
        update('running');
        continue;
      }
      const committed = commit([entry], candidate);
      succeeded += committed.saved;
      skipped += committed.superseded;
      errors.push(...committed.failed);
    }
    update(errors.length ? 'failed' : 'completed', errors.length ? '部分素材尚未分析完成，可继续未完成项' : null);
  } catch (error) {
    update(signal.aborted ? 'cancelled' : 'failed', signal.aborted ? '本次分析已停止，已保存结果保留，可继续未完成项'
      : error instanceof BatchDomainError ? error.message : '本次分析中断，已保存结果保留');
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
