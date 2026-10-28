import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchProductionVersion, updateBatchProductionStatus } from '../versions.ts';
import { createBatchExternalScript, snapshotScriptIntoBatch } from '../scripts.ts';
import { createOutputPlan } from '../plans.ts';
import { listAssetSources } from '../media-catalog.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { readFormulaInputs, type FormulaImportedRow } from './import-store.ts';
import { readFormulaSettings } from './settings-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { readFormulaMaterialNotes } from './material-notes.ts';
import { formulaMaterialAnalysisGap } from './material-analysis.ts';
import { resolveFormulaProductionResources } from './production-options.ts';
import { checkFormulaMusicSelection, selectFormulaMusicPool } from './settings-music.ts';
import type { FormulaWorkbookPreview } from './workbook.ts';
import { queueFormulaSelection } from './selection-store.ts';
import { readFormulaSelectionRules } from './selection-rules.ts';
import { captureFormulaSpeechService } from './speech-provider.ts';
import { assertFormulaNarrationAudio, captureFormulaTtsService } from './narration.ts';
import { readFormulaExternalNarrations } from './external-narration.ts';
import { captureFormulaPresentationProject } from './output-presentation.ts';
import { reactivateBatchForStart } from '../scheduler.ts';
import { readFormulaManualSpeech } from './manual-speech.ts';
import { readFormulaReplacementHints } from './replacement-hints-store.ts';
import { LEGACY_FORMULA_RULES_VERSION, FORMULA_RULES_VERSION, isFormulaRulesV2,
  type FormulaGenerationRulesVersion } from './rules-version.ts';

export interface FormulaGenerationInput {
  requestKey: string;
  expectedInputRevision: number;
  settingsId: string;
  /** 不传时按旧规矩建立请求；工作台的生成入口显式传新规矩。 */
  rulesVersion?: FormulaGenerationRulesVersion;
  signal?: AbortSignal;
}
export interface FormulaGenerationOutput {
  planId: string; scriptKey: string; scriptNumber: string; copyIndex: number;
  slots: Array<{ slotId: string; clipId: number; logicalCode: string }>;
}
interface RequestRow {
  id: string; batchVersionId: string; settingsId: string; inputRevision: number;
  requestKey: string; seed: string; inputJson: string; createdAt: string; rulesVersion: string;
}

function captureInput(db: Database.Database, projectId: string, batchId: string, input: FormulaGenerationInput,
  rulesVersion: FormulaGenerationRulesVersion) {
  assertFormulaBatch(db, projectId, batchId, true);
  const collection = getFormulaCollection(db, projectId, batchId);
  const view = readFormulaSettings(db, projectId, batchId);
  if (!collection || !view.saved || view.saved.id !== input.settingsId || view.inputRevision !== input.expectedInputRevision
    || view.stale) throw new BatchDomainError('conflict', '脚本、素材或设置已变化，请刷新核对后再生成');
  // 新规矩没有「只用原声」：声音只认原声＋配音、统一配音两种（任务 14 去掉旧入口）。
  if (isFormulaRulesV2(rulesVersion) && view.saved.settings.production.audio.mode === 'original') {
    throw new BatchDomainError('invalid_input', '新规矩不再支持「只用原声」，请把声音方式改成「原声＋配音」或「统一配音」后重新生成');
  }
  const imports = readFormulaInputs(db, projectId, batchId);
  if (imports.drafts.some(draft => draft.baseRevision === collection.revision)) {
    throw new BatchDomainError('conflict', '有待确认的导入预览，请先确认资料再生成');
  }
  const notes = readFormulaMaterialNotes(db, projectId, batchId);
  if (notes.run?.state === 'running') throw new BatchDomainError('conflict', '素材画面仍在分析，请完成后再生成');
  // 生成前检查：这次要生成的脚本用到的素材必须都分析过画面，不能退回固定掐头去尾。
  const selectedScripts = new Set(view.saved.settings.selections.map(item => item.key));
  const gap = formulaMaterialAnalysisGap(db, projectId, batchId, [...new Set(view.scripts
    .filter(script => selectedScripts.has(script.key)).flatMap(script => script.codes))]);
  if (gap.missingSources) {
    const codes = gap.missingCodes.slice(0, 6).join('、') + (gap.missingCodes.length > 6 ? ' 等' : '');
    throw new BatchDomainError('conflict',
      `还有 ${gap.missingSources} 段素材没分析画面（${codes}），请先在第一步点「分析画面」`);
  }
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const choices = readFormulaSelectionRules(db, projectId, batchId);
  if (choices.stale) throw new BatchDomainError('conflict', '脚本已修订，请重新核对单镜头指定或清除旧指定后再生成');
  if (choices.rotationStale) throw new BatchDomainError('conflict', '候选可用区间已修改，请重新批准轮换候选后再生成');
  const selected = new Set(view.saved.settings.selections.map(item => item.key));
  const external = readFormulaExternalNarrations(db, projectId, batchId).items.filter(item => selected.has(item.scriptKey) && item.saved?.audio);
  if (external.some(item => item.stale)) throw new BatchDomainError('conflict', '脚本文案已变化，请重新导入并确认外部配音，或移除旧配音');
  if (external.length && view.saved.settings.production.audio.mode !== 'narration') throw new BatchDomainError('conflict', '外部整篇配音须使用统一配音模式；其他模式请先移除外部配音');
  const externalNarrations = external.map(item => item.saved!);
  for (const item of externalNarrations) assertFormulaNarrationAudio(projectId, item.text, item.audio!);
  // 保存整份已确认的解释及人工修改记录，不能只保存当前行文案。
  const sessions = db.prepare(`SELECT id,kind,filename,fingerprint,previewJson,excludedKeysJson,extractionJson,confirmedRevision
    FROM live_mixcut_formula_import_sessions WHERE collectionId=? AND state='confirmed' AND id IN (?,?) ORDER BY kind`)
    .all(collection.id, collection.materialsSessionId, collection.scriptsSessionId) as Array<{
      id: string; kind: string; filename: string; fingerprint: string; previewJson: string;
      excludedKeysJson: string; extractionJson: string | null; confirmedRevision: number;
    }>;
  const batch = db.prepare('SELECT currentVersionId FROM live_mixcut_productions WHERE id=?').get(batchId) as { currentVersionId: string | null };
  return {
    formatVersion: 1 as const, algorithmVersion: 'formula-input/1' as const,
    collectionId: collection.id, inputRevision: collection.revision, previousBatchVersionId: batch.currentVersionId,
    settings: view.saved, scripts: view.scripts.filter(script => selected.has(script.key)),
    sessions: sessions.map(row => ({ id: row.id, kind: row.kind, filename: row.filename, fingerprint: row.fingerprint,
      confirmedRevision: row.confirmedRevision, preview: JSON.parse(row.previewJson) as FormulaWorkbookPreview<FormulaImportedRow>,
      excludedKeys: JSON.parse(row.excludedKeysJson) as string[], extraction: row.extractionJson ? JSON.parse(row.extractionJson) as unknown : null })),
    materialIndex: index, materialNotes: notes.items, selectionRules: choices.saved, assetRanges: choices.ranges,
    manualSpeech: readFormulaManualSpeech(db, projectId, batchId).items.flatMap(item => item.saved && item.saved.mode !== 'automatic' ? [item.saved] : []),
    replacementHints: readFormulaReplacementHints(db, projectId, batchId).saved,
    externalNarrations,
    // 这里只冻结可供核验的来源身份，不将 healthy 或 AI 文件名说明当成画面、台词及可用区间证明。
    mediaSources: [...new Set(index.bindings.map(binding => binding.assetId))].sort().map(assetId => ({ assetId,
      sources: listAssetSources(db, assetId).filter(source => source.sourceKind === 'managed' && source.locationJson.kind === 'managed')
        .map(source => ({ id: source.id, location: source.locationJson, health: source.health })) })),
    productionResources: resolveFormulaProductionResources(db, view.saved.settings.production),
    presentationProject: captureFormulaPresentationProject(db, projectId),
    speechService: captureFormulaSpeechService(),
    ttsService: captureFormulaTtsService(db, view.saved.settings.production.audio.tts),
    musicPool: selectFormulaMusicPool(db, view.saved.settings.bgm),
  };
}

export interface FormulaGenerationRequest {
  id: string; batchVersionId: string; requestKey: string; seed: string; createdAt: string;
  /** 这批成片按哪一套规矩读和跑；旧请求为 formula-generation/1。 */
  rulesVersion: FormulaGenerationRulesVersion;
  input: Omit<ReturnType<typeof captureInput>, 'selectionRules' | 'assetRanges' | 'speechService' | 'ttsService' | 'presentationProject' | 'manualSpeech' | 'replacementHints' | 'externalNarrations'> & {
    externalNarrations?: ReturnType<typeof captureInput>['externalNarrations'];
    replacementHints?: ReturnType<typeof captureInput>['replacementHints'];
    manualSpeech?: ReturnType<typeof captureInput>['manualSpeech'];
    selectionRules?: ReturnType<typeof captureInput>['selectionRules']; assetRanges?: ReturnType<typeof captureInput>['assetRanges'];
    speechService?: ReturnType<typeof captureInput>['speechService'];
    ttsService?: ReturnType<typeof captureInput>['ttsService'];
    presentationProject?: ReturnType<typeof captureInput>['presentationProject'];
  };
  outputs: FormulaGenerationOutput[];
}

export function readFormulaGenerationRequest(db: Database.Database, projectId: string, batchId: string, requestId: string): FormulaGenerationRequest {
  assertFormulaBatch(db, projectId, batchId);
  const row = db.prepare('SELECT * FROM live_mixcut_formula_generation_requests WHERE id=? AND projectId=? AND batchId=?')
    .get(requestId, projectId, batchId) as RequestRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '这次公式生成请求不存在');
  const outputs = db.prepare(`SELECT o.* FROM live_mixcut_formula_generation_outputs o
    JOIN live_mixcut_output_plans p ON p.id=o.planId WHERE o.requestId=? ORDER BY p.seq`).all(row.id) as Array<{
      planId: string; scriptKey: string; scriptNumber: string; copyIndex: number; slotsJson: string;
    }>;
  return { id: row.id, batchVersionId: row.batchVersionId, requestKey: row.requestKey, seed: row.seed, createdAt: row.createdAt,
    rulesVersion: row.rulesVersion as FormulaGenerationRulesVersion,
    input: JSON.parse(row.inputJson), outputs: outputs.map(output => ({ planId: output.planId, scriptKey: output.scriptKey,
      scriptNumber: output.scriptNumber, copyIndex: output.copyIndex, slots: JSON.parse(output.slotsJson) })) };
}

/** 输入冻结，不生成假音频或可审成片；后续阶段必须核验快照中的实际文件、声音和区间。 */
export async function createFormulaGenerationRequest(db: Database.Database, projectId: string, batchId: string,
  input: FormulaGenerationInput): Promise<FormulaGenerationRequest> {
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.requestKey) || typeof input.settingsId !== 'string' || !input.settingsId
    || !Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0) {
    throw new BatchDomainError('invalid_input', '缺少有效的生成请求标识或输入版本');
  }
  input.signal?.throwIfAborted();
  assertFormulaBatch(db, projectId, batchId);
  const rulesVersion = input.rulesVersion ?? LEGACY_FORMULA_RULES_VERSION;
  if (rulesVersion !== LEGACY_FORMULA_RULES_VERSION && rulesVersion !== FORMULA_RULES_VERSION) {
    throw new BatchDomainError('invalid_input', '不支持这次生成的规矩版本');
  }
  const existing = () => {
    const row = db.prepare('SELECT * FROM live_mixcut_formula_generation_requests WHERE projectId=? AND batchId=? AND requestKey=?')
      .get(projectId, batchId, input.requestKey) as RequestRow | undefined;
    if (!row) return null;
    if (row.settingsId !== input.settingsId || row.inputRevision !== input.expectedInputRevision
      || row.rulesVersion !== rulesVersion) {
      throw new BatchDomainError('conflict', '同一生成请求标识不能用于不同的输入，请重新发起生成');
    }
    return readFormulaGenerationRequest(db, projectId, batchId, row.id);
  };
  const prior = existing();
  if (prior) return prior;
  const snapshot = captureInput(db, projectId, batchId, input, rulesVersion);
  await checkFormulaMusicSelection(db, snapshot.settings.settings.bgm, input.signal);
  input.signal?.throwIfAborted();
  return db.transaction(() => {
    // 并发点击可能已在文件核验期间提交；先恢复它，再检查草稿是否可写。
    const completed = existing();
    if (completed) return completed;
    if (JSON.stringify(captureInput(db, projectId, batchId, input, rulesVersion)) !== JSON.stringify(snapshot)) {
      throw new BatchDomainError('conflict', '核验期间输入资料或预设已变化，请刷新核对后再生成');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const batchVersionId = createBatchProductionVersion(db, batchId, { copyCount: snapshot.settings.totalCopies,
      defaultsJson: { planningMode: 'formula', generationRequestId: id } });
    db.prepare(`INSERT INTO live_mixcut_formula_generation_requests
      (id,projectId,batchId,collectionId,batchVersionId,settingsId,inputRevision,requestKey,seed,inputJson,createdAt,rulesVersion)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, batchId, snapshot.collectionId, batchVersionId, input.settingsId,
      snapshot.inputRevision, input.requestKey, randomBytes(32).toString('hex'), JSON.stringify(snapshot), now, rulesVersion);
    let seq = 0;
    for (const script of snapshot.scripts) {
      const copies = snapshot.settings.settings.selections.find(item => item.key === script.key)!.copies;
      const scriptId = createBatchExternalScript(db, batchVersionId, { sourceId: `formula:${snapshot.settings.scriptsSessionId}:${script.key}`,
        title: `脚本 ${script.scriptNumber}`, bodyText: script.bodyText, sourceVersion: snapshot.settings.scriptsSessionId,
        targetDurationSec: script.targetDurationSec });
      const scriptSnapshotId = snapshotScriptIntoBatch(db, batchVersionId, { scriptId, copyCount: copies });
      for (let copyIndex = 1; copyIndex <= copies; copyIndex++) {
        const slots = script.codes.map((logicalCode, clipId) => ({ slotId: randomUUID(), clipId, logicalCode }));
        const identity = { generationRequestId: id, scriptKey: script.key, scriptNumber: script.scriptNumber, copyIndex, slots };
        const planId = createOutputPlan(db, batchVersionId, { scriptSnapshotId, seq: ++seq, planJson: { planningMode: 'formula', ...identity } });
        db.prepare(`INSERT INTO live_mixcut_formula_generation_outputs (planId,requestId,scriptKey,scriptNumber,copyIndex,slotsJson)
          VALUES (?,?,?,?,?,?)`).run(planId, id, script.key, script.scriptNumber, copyIndex, JSON.stringify(slots));
      }
    }
    db.prepare("UPDATE live_mixcut_production_versions SET inputState='frozen',frozenAt=? WHERE id=?").run(now, batchVersionId);
    reactivateBatchForStart(db, projectId, batchId);
    queueFormulaSelection(db, projectId, batchId, id);
    updateBatchProductionStatus(db, projectId, batchId, 'running');
    return readFormulaGenerationRequest(db, projectId, batchId, id);
  }).immediate();
}
