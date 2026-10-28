/**
 * 新规矩（formula-generation/2）的生产链：选片 → 识别原声 → AI 判断 → 定声音 → 配音。
 *
 * 排时间由任务 09 接在这里后面；在那之前，新批次走到配音就停住，不碰旧时间轴。
 * 每一步只有两种结果：做好了，或者失败（带原因、能重试）。缺号、文案没写口播台词
 * 都不停下等人；只有识别、AI、配音接口真的报错才让这条成片失败。
 *
 * 阶段表都挂在本条成片的选片阶段下，和旧批次的旧表互不相干。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchTask } from '../tasks.ts';
import type { FormulaGenerationOutput, FormulaGenerationRequest } from './generation.ts';
import type { FormulaSelection } from './selection.ts';
import { isVoiceOver } from '../scheduling/text.ts';
import { voiceUsableRange } from '../scheduling/arrange-time.ts';
import type { SchedulingFile, SchedulingJudgment, SchedulingScript, SchedulingSlotMaterial,
  SchedulingSpeech, VoicePlan } from '../scheduling/types.ts';
import { withCleanedSourceSpeech, type FormulaSourceSpeech } from './source-speech.ts';
import type { FormulaJudgmentInput } from './judgment.ts';
import type { FormulaTtsService } from './narration.ts';
import { formulaNarrationReuseKey } from './narration.ts';
import { isFormulaRulesV2 } from './rules-version.ts';
import { speechContent } from '../../media-core/adapters/alignment.ts';
import { verifyFormulaCandidateCached, recheckFormulaCandidateCached } from './candidate-cache.ts';
import type { FormulaVerifiedCandidate } from './candidate-media.ts';

export interface FormulaJudgmentStageInput { formatVersion: 1; judgment: FormulaJudgmentInput }
export interface FormulaJudgmentStageResult {
  status: 'ready'; algorithmVersion: 'formula-judgment-stage/1'; executionReady: false;
  judgment: SchedulingJudgment;
  provider: { id: string; name: string; model: string };
  cached: boolean;
}
export interface FormulaVoiceStageInput {
  formatVersion: 1;
  script: SchedulingScript;
  voiceMode: 'mixed' | 'narration';
  materials: SchedulingSlotMaterial[];
  judgment: SchedulingJudgment;
}
export interface FormulaVoiceStageResult {
  status: 'ready'; algorithmVersion: 'formula-voice/1'; executionReady: false;
  mode: 'mixed' | 'narration';
  plan: VoicePlan;
  narrationLines: number[];
  missingCodes: string[];
}
export interface FormulaVoiceNarrationItem { id: string; lineIndex: number; text: string }
export interface FormulaVoiceNarrationStageInput {
  formatVersion: 1; service: FormulaTtsService | null; items: FormulaVoiceNarrationItem[]; reuseKeys: string[];
}
export interface FormulaVoiceNarrationStageResult {
  status: 'ready'; algorithmVersion: 'formula-narration-stage/2'; executionReady: false;
  items: Array<FormulaVoiceNarrationItem & { audio: import('./narration.ts').FormulaNarrationAudio }>;
}
export interface FormulaJudgmentStage {
  id: string; selectionStageId: string; revision: number; input: FormulaJudgmentStageInput;
}
export interface FormulaVoiceStage {
  id: string; selectionStageId: string; judgmentStageId: string; revision: number; input: FormulaVoiceStageInput;
}
export interface FormulaVoiceNarrationStage {
  id: string; voiceStageId: string; input: FormulaVoiceNarrationStageInput;
}

/** 文案按行；只去掉空行，不改变文字本身。 */
export function formulaScriptLines(bodyText: string): string[] {
  return bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function selectionResult(db: Database.Database, selectStageId: string): FormulaSelection | null {
  const row = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?')
    .get(selectStageId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaSelection : null;
}

interface SpeechEntry { stageId: string; result: FormulaSourceSpeech }
/** 本条成片各段原声的最新识别结果；没有对应选片阶段的旧记录不混进来。 */
export function readFormulaV2Speech(db: Database.Database, selectStageId: string): Map<string, SpeechEntry> {
  const rows = db.prepare(`SELECT s.id,s.assetId,x.resultJson FROM live_mixcut_formula_speech_stages s
    JOIN live_mixcut_formula_speech_results x ON x.stageId=s.id
    WHERE s.selectionStageId=? ORDER BY s.assetId,s.revision`).all(selectStageId) as
    Array<{ id: string; assetId: string; resultJson: string }>;
  const latest = new Map<string, SpeechEntry>();
  for (const row of rows) latest.set(row.assetId, { stageId: row.id, result: JSON.parse(row.resultJson) as FormulaSourceSpeech });
  return latest;
}

function plannedLineOf(request: FormulaGenerationRequest, assetId: string): string | null {
  return request.input.materialIndex.bindings.find(binding => binding.assetId === assetId)?.voLine ?? null;
}

/** 取清洗后的原声；旧结果在这里补洗，不再调用识别服务。 */
export function cleanedFormulaSpeech(request: FormulaGenerationRequest, assetId: string, result: FormulaSourceSpeech): FormulaSourceSpeech {
  return withCleanedSourceSpeech(result, plannedLineOf(request, assetId));
}

export function readFormulaJudgmentStage(db: Database.Database, stageId: string): FormulaJudgmentStage {
  const row = db.prepare('SELECT * FROM live_mixcut_formula_judgment_stages WHERE id=?').get(stageId) as
    { id: string; selectionStageId: string; revision: number; inputJson: string } | undefined;
  if (!row) throw new BatchDomainError('not_found', 'AI 判断阶段不存在');
  return { ...row, input: JSON.parse(row.inputJson) as FormulaJudgmentStageInput };
}

export function readFormulaVoiceStage(db: Database.Database, stageId: string): FormulaVoiceStage {
  const row = db.prepare('SELECT * FROM live_mixcut_formula_voice_stages WHERE id=?').get(stageId) as
    { id: string; selectionStageId: string; judgmentStageId: string; revision: number; inputJson: string } | undefined;
  if (!row) throw new BatchDomainError('not_found', '定声音阶段不存在');
  return { ...row, input: JSON.parse(row.inputJson) as FormulaVoiceStageInput };
}

export function readFormulaVoiceNarrationInput(db: Database.Database, stageId: string): FormulaVoiceNarrationStageInput {
  const row = db.prepare('SELECT inputJson FROM live_mixcut_formula_voice_narration_stages WHERE id=?').get(stageId) as
    { inputJson: string } | undefined;
  if (!row) throw new BatchDomainError('not_found', '配音阶段不存在');
  const input = JSON.parse(row.inputJson) as FormulaVoiceNarrationStageInput;
  if (input.formatVersion !== 1) throw new BatchDomainError('conflict', '不支持这次配音的输入版本');
  return input;
}

export function readFormulaJudgmentResult(db: Database.Database, selectStageId: string): FormulaJudgmentStageResult | null {
  const row = db.prepare(`SELECT x.resultJson FROM live_mixcut_formula_judgment_stages j
    JOIN live_mixcut_formula_judgment_results x ON x.stageId=j.id
    WHERE j.selectionStageId=? ORDER BY j.revision DESC LIMIT 1`).get(selectStageId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaJudgmentStageResult : null;
}

export function readFormulaVoiceResult(db: Database.Database, selectStageId: string): FormulaVoiceStageResult | null {
  const row = db.prepare(`SELECT x.resultJson FROM live_mixcut_formula_voice_stages v
    JOIN live_mixcut_formula_voice_results x ON x.stageId=v.id
    WHERE v.selectionStageId=? ORDER BY v.revision DESC LIMIT 1`).get(selectStageId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaVoiceStageResult : null;
}

export function readFormulaVoiceNarrationResult(db: Database.Database, selectStageId: string): FormulaVoiceNarrationStageResult | null {
  const row = db.prepare(`SELECT x.resultJson FROM live_mixcut_formula_voice_narration_stages n
    JOIN live_mixcut_formula_voice_narration_results x ON x.stageId=n.id
    JOIN live_mixcut_formula_voice_stages v ON v.id=n.voiceStageId
    WHERE v.selectionStageId=? ORDER BY v.revision DESC LIMIT 1`).get(selectStageId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaVoiceNarrationStageResult : null;
}

function judgmentStageId(db: Database.Database, selectStageId: string): string | null {
  const row = db.prepare('SELECT id FROM live_mixcut_formula_judgment_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectStageId) as { id: string } | undefined;
  return row?.id ?? null;
}

function voiceStageId(db: Database.Database, selectStageId: string): string | null {
  const row = db.prepare('SELECT id FROM live_mixcut_formula_voice_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectStageId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 配音复用的身份，和其它阶段一样由文字和声音共同决定。 */
function narrationReuseKeys(items: FormulaVoiceNarrationItem[], service: FormulaTtsService | null): string[] {
  return [...new Set(items.map(item => formulaNarrationReuseKey(item.text, service)))].sort();
}

function voiceMode(request: FormulaGenerationRequest): 'mixed' | 'narration' {
  const mode = request.input.settings.settings.production.audio.mode;
  if (mode === 'mixed' || mode === 'narration') return mode;
  throw new BatchDomainError('invalid_input', '新规矩不支持「只用原声」，请选择「原声＋配音」或「统一配音」');
}

/** AI 判断的素材：全部可用的非口播文件，描述来自「分析画面」。 */
function judgmentMaterials(request: FormulaGenerationRequest): FormulaJudgmentInput['materials'] {
  const notes = new Map(request.input.materialNotes.map(note => [note.bindingId, note]));
  const seen = new Set<string>();
  const result: FormulaJudgmentInput['materials'] = [];
  for (const binding of [...request.input.materialIndex.bindings].sort((left, right) => left.assetId.localeCompare(right.assetId))) {
    if (!binding.logicalCode || !binding.available || binding.excludedReason || isVoiceOver(binding.logicalCode)) continue;
    if (seen.has(binding.assetId)) continue;
    seen.add(binding.assetId);
    result.push({ logicalCode: binding.logicalCode, assetId: binding.assetId, fileName: binding.sourceName,
      description: notes.get(binding.id)?.analysis?.description ?? null });
  }
  return result;
}

/** 口播素材：本条公式里有文件、原声也识别出实际台词的。 */
function judgmentVoiceOvers(request: FormulaGenerationRequest, selection: FormulaSelection,
  speech: Map<string, SpeechEntry>): FormulaJudgmentInput['voiceOvers'] {
  const result: FormulaJudgmentInput['voiceOvers'] = [];
  const seen = new Set<string>();
  for (const slot of selection.slots) {
    if (!isVoiceOver(slot.logicalCode) || !slot.candidate || seen.has(slot.logicalCode)) continue;
    const entry = speech.get(slot.candidate.assetId);
    if (!entry) continue;
    const cleaned = cleanedFormulaSpeech(request, slot.candidate.assetId, entry.result);
    if (cleaned.status !== 'transcribed' || !cleaned.cleaned || !speechContent(cleaned.cleaned.text)) continue;
    seen.add(slot.logicalCode);
    result.push({ logicalCode: slot.logicalCode, plannedLine: plannedLineOf(request, slot.candidate.assetId),
      speechText: cleaned.cleaned.text });
  }
  return result;
}

function assetDurations(db: Database.Database, projectId: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of db.prepare('SELECT id,mediaJson FROM live_mixcut_assets WHERE projectId=?').all(projectId) as
    Array<{ id: string; mediaJson: string }>) {
    try {
      const media = JSON.parse(row.mediaJson) as { durationUs?: number; durationSec?: number };
      const durationUs = Number.isSafeInteger(media.durationUs) && (media.durationUs as number) > 0 ? media.durationUs as number
        : typeof media.durationSec === 'number' ? Math.round(media.durationSec * 1_000_000) : 0;
      if (durationUs > 0) result.set(row.id, durationUs);
    } catch { /* 损坏的媒体信息按没有处理 */ }
  }
  return result;
}

function speechOf(cleaned: FormulaSourceSpeech): SchedulingSpeech | null {
  if (cleaned.status !== 'transcribed' || !cleaned.cleaned || !cleaned.cleaned.words.length) return null;
  if (!speechContent(cleaned.cleaned.text)) return null;
  return { text: cleaned.cleaned.text, words: cleaned.cleaned.words, startUs: cleaned.cleaned.startUs,
    endUs: cleaned.cleaned.endUs, headCutEndUs: cleaned.cleaned.headCutEndUs, tailCutStartUs: cleaned.cleaned.tailCutStartUs };
}

const natural = (left: string, right: string): number => left.localeCompare(right, 'en', { numeric: true });

function schedulingFile(binding: { assetId: string; contentFingerprint: string; sourceName: string },
  logicalCode: string, durationUs: number, usableInUs: number, usableOutUs: number, speech: SchedulingSpeech | null): SchedulingFile | null {
  const inUs = Math.max(0, Math.min(usableInUs, durationUs));
  const outUs = Math.min(usableOutUs, durationUs);
  if (speech) {
    const range = voiceUsableRange({ assetId: binding.assetId, contentFingerprint: binding.contentFingerprint,
      fileName: binding.sourceName, durationUs, usableInUs: inUs, usableOutUs: outUs, speech });
    return { assetId: binding.assetId, contentFingerprint: binding.contentFingerprint, fileName: binding.sourceName,
      logicalCode, durationUs, usableInUs: range.inUs, usableOutUs: range.outUs, speech };
  }
  if (outUs <= inUs) return null;
  return { assetId: binding.assetId, contentFingerprint: binding.contentFingerprint, fileName: binding.sourceName,
    logicalCode, durationUs, usableInUs: inUs, usableOutUs: outUs, speech: null };
}

/**
 * 定声音的素材清单：公式里的编号只留选中的那份文件（选片的轮换已经生效），
 * 其余可用素材作为补镜和替代池；没有分析画面的非口播文件不参与。
 */
export function buildFormulaSchedulingMaterials(db: Database.Database, projectId: string, request: FormulaGenerationRequest,
  selection: FormulaSelection, speech: Map<string, SpeechEntry>): SchedulingSlotMaterial[] {
  const durations = assetDurations(db, projectId);
  const notes = new Map(request.input.materialNotes.map(note => [note.bindingId, note]));
  const formulaCodes = [...new Set(selection.slots.map(slot => slot.logicalCode))];
  const formulaSet = new Set(formulaCodes);
  const selected = new Map<string, string>();
  for (const slot of selection.slots) if (slot.candidate) selected.set(slot.logicalCode, slot.candidate.assetId);
  const bindings = request.input.materialIndex.bindings.filter(binding =>
    binding.logicalCode && binding.available && !binding.excludedReason);
  const byCode = new Map<string, typeof bindings>();
  for (const binding of bindings) byCode.set(binding.logicalCode!, [...(byCode.get(binding.logicalCode!) ?? []), binding]);
  const materials: SchedulingSlotMaterial[] = [];
  for (const logicalCode of formulaCodes) {
    const isVo = isVoiceOver(logicalCode);
    const first = bindings.find(binding => binding.logicalCode === logicalCode);
    const files: SchedulingFile[] = [];
    for (const binding of [...(byCode.get(logicalCode) ?? [])].sort((left, right) => left.assetId.localeCompare(right.assetId))) {
      if (selected.get(logicalCode) !== binding.assetId) continue;
      const analysis = notes.get(binding.id)?.analysis ?? null;
      const entry = speech.get(binding.assetId);
      const cleaned = entry ? cleanedFormulaSpeech(request, binding.assetId, entry.result) : null;
      const spoken = cleaned ? speechOf(cleaned) : null;
      const durationUs = spoken && cleaned?.status === 'transcribed' ? cleaned.mediaDurationUs
        : analysis?.durationUs ?? durations.get(binding.assetId) ?? 0;
      if (durationUs <= 0) continue;
      const file = spoken ? schedulingFile(binding, logicalCode, durationUs, 0, durationUs, spoken)
        : analysis ? schedulingFile(binding, logicalCode, durationUs, analysis.usableInUs, analysis.usableOutUs, null)
          : isVo ? schedulingFile(binding, logicalCode, durationUs, 0, durationUs, null) : null;
      if (file) files.push(file);
    }
    materials.push({ logicalCode, kind: first?.detectedCode?.replace(/\d+$/, '') ?? logicalCode.replace(/\d+$/, ''),
      files, isVo, voLine: first?.voLine ?? null, wide: first?.wide ?? false, wideExperience: first?.wideExperience ?? false });
  }
  // 补镜和替代从全量素材里挑：不重复公式编号，只留能用的文件。
  for (const [logicalCode, list] of [...byCode.entries()].sort(([left], [right]) => natural(left, right))) {
    if (formulaSet.has(logicalCode) || isVoiceOver(logicalCode)) continue;
    const files: SchedulingFile[] = [];
    for (const binding of [...list].sort((left, right) => left.assetId.localeCompare(right.assetId))) {
      const analysis = notes.get(binding.id)?.analysis ?? null;
      const durationUs = analysis?.durationUs ?? durations.get(binding.assetId) ?? 0;
      if (!analysis || durationUs <= 0) continue;
      const file = schedulingFile(binding, logicalCode, durationUs, analysis.usableInUs, analysis.usableOutUs, null);
      if (file) files.push(file);
    }
    if (!files.length) continue;
    const first = list[0];
    materials.push({ logicalCode, kind: first.detectedCode?.replace(/\d+$/, '') ?? logicalCode.replace(/\d+$/, ''),
      files, isVo: false, voLine: null, wide: first.wide, wideExperience: first.wideExperience });
  }
  return materials;
}

/**
 * 从当前已有的结果往下接一步：建语音识别、AI 判断、定声音或配音阶段并排任务。
 * 幂等：阶段和任务都在就返回；重试失败任务时也从这里接。
 */
export function queueFormulaV2Plan(db: Database.Database, projectId: string, batchId: string,
  selectStage: { id: string; planId: string }, request: FormulaGenerationRequest, output: FormulaGenerationOutput): void {
  if (!isFormulaRulesV2(request.rulesVersion)) return;
  const selection = selectionResult(db, selectStage.id);
  if (!selection || selection.status !== 'selected') return;
  const mode = voiceMode(request);
  const speech = readFormulaV2Speech(db, selectStage.id);
  if (mode === 'mixed') {
    const voiceSlots = selection.slots.filter(slot => isVoiceOver(slot.logicalCode) && slot.candidate);
    for (const slot of voiceSlots) {
      const candidate = slot.candidate!;
      let stage = db.prepare('SELECT id FROM live_mixcut_formula_speech_stages WHERE selectionStageId=? AND assetId=? ORDER BY revision DESC LIMIT 1')
        .get(selectStage.id, candidate.assetId) as { id: string } | undefined;
      if (!stage) {
        const id = randomUUID();
        db.prepare(`INSERT INTO live_mixcut_formula_speech_stages
          (id,selectionStageId,assetId,contentFingerprint,revision,inputJson,createdAt) VALUES (?,?,?,?,1,?,?)`)
          .run(id, selectStage.id, candidate.assetId, candidate.contentFingerprint,
            JSON.stringify({ formatVersion: 1, service: request.input.speechService ?? null }), new Date().toISOString());
        stage = { id };
      }
      createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
        requestKey: `formula:speech:${stage.id}` });
    }
    const expected = [...new Set(voiceSlots.map(slot => slot.candidate!.assetId))];
    if (expected.some(assetId => !speech.has(assetId))) return;
    for (const assetId of expected) {
      const cleaned = cleanedFormulaSpeech(request, assetId, speech.get(assetId)!.result);
      // 识别失败会让那条任务失败；这里先停下，等重试或修复后继续。
      if (cleaned.status === 'needs_attention') return;
    }
  }

  const script = request.input.scripts.find(item => item.key === output.scriptKey);
  if (!script) throw new BatchDomainError('conflict', '这条成片缺少冻结的脚本');
  const lines = formulaScriptLines(script.bodyText);
  if (!lines.length) throw new BatchDomainError('invalid_input', '这条脚本没有文案，无法定声音');

  if (!judgmentStageId(db, selectStage.id)) {
    const input: FormulaJudgmentStageInput = { formatVersion: 1, judgment: { script: { lines },
      voiceOvers: judgmentVoiceOvers(request, selection, speech), materials: judgmentMaterials(request) } };
    const id = randomUUID();
    db.prepare('INSERT INTO live_mixcut_formula_judgment_stages (id,selectionStageId,revision,inputJson,createdAt) VALUES (?,?,1,?,?)')
      .run(id, selectStage.id, JSON.stringify(input), new Date().toISOString());
    createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: id,
      requestKey: `formula:judgment:${id}` });
    return;
  }

  const judgment = readFormulaJudgmentResult(db, selectStage.id);
  if (!judgment) return;

  if (!voiceStageId(db, selectStage.id)) {
    const scriptInput: SchedulingScript = { scriptNumber: output.scriptNumber, copyIndex: output.copyIndex, lines,
      codes: output.slots.map(slot => slot.logicalCode), estimatedDurationSec: script.targetDurationSec ?? null };
    const input: FormulaVoiceStageInput = { formatVersion: 1, script: scriptInput, voiceMode: mode,
      materials: buildFormulaSchedulingMaterials(db, projectId, request, selection, speech),
      judgment: judgment.judgment };
    const id = randomUUID();
    db.prepare(`INSERT INTO live_mixcut_formula_voice_stages
      (id,selectionStageId,judgmentStageId,revision,inputJson,createdAt) VALUES (?,?,?,1,?,?)`)
      .run(id, selectStage.id, judgmentStageId(db, selectStage.id)!, JSON.stringify(input), new Date().toISOString());
    createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: id,
      requestKey: `formula:voice:${id}` });
    return;
  }

  const voice = readFormulaVoiceResult(db, selectStage.id);
  if (!voice) return;
  const narrationId = db.prepare('SELECT id FROM live_mixcut_formula_voice_narration_stages WHERE voiceStageId=?')
    .get(voiceStageId(db, selectStage.id)!) as { id: string } | undefined;
  if (narrationId || !voice.narrationLines.length) return;
  const items: FormulaVoiceNarrationItem[] = voice.narrationLines.map(lineIndex => ({ id: `line-${lineIndex}`,
    lineIndex, text: voice.plan.lines[lineIndex].text }));
  const input: FormulaVoiceNarrationStageInput = { formatVersion: 1, service: request.input.ttsService ?? null,
    items, reuseKeys: narrationReuseKeys(items, request.input.ttsService ?? null) };
  const id = randomUUID();
  db.prepare('INSERT INTO live_mixcut_formula_voice_narration_stages (id,voiceStageId,inputJson,createdAt) VALUES (?,?,?,?)')
    .run(id, voiceStageId(db, selectStage.id)!, JSON.stringify(input), new Date().toISOString());
  createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: id,
    requestKey: `formula:voice_narration:${id}` });
}

/** 定声音用到的每个文件都要能核验；失败让这条成片带原因重试。 */
export async function verifyFormulaVoicePlanFiles(db: Database.Database, projectId: string, request: FormulaGenerationRequest,
  plan: VoicePlan, signal: AbortSignal): Promise<FormulaVerifiedCandidate[]> {
  const files = plan.items.flatMap(item => 'file' in item ? [item.file] : []);
  const seen = new Set<string>();
  const verified: FormulaVerifiedCandidate[] = [];
  for (const file of files) {
    if (seen.has(file.assetId)) continue;
    seen.add(file.assetId);
    const sources = request.input.mediaSources.find(item => item.assetId === file.assetId)?.sources ?? [];
    const candidate = await verifyFormulaCandidateCached(db, projectId, file.assetId, file.contentFingerprint, sources, signal);
    if (!candidate) throw new BatchDomainError('conflict', `定声音要用到的素材无法核验：${file.fileName}。请恢复原片后重试`);
    verified.push(candidate);
  }
  return verified;
}

/** 提交定声音结果前，再确认一次文件身份。 */
export function recheckFormulaVoicePlanFiles(db: Database.Database, projectId: string,
  candidates: FormulaVerifiedCandidate[]): void {
  for (const candidate of candidates) recheckFormulaCandidateCached(db, projectId, candidate);
}
