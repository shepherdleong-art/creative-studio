/**
 * 新规矩的「排时间」：配音之后用排片计算排出画面、声音、字幕和审片标记。
 *
 * 输入全部来自前面阶段的冻结数据和结果：定声音的 plan、配音的实际时长与逐字时间。
 * 这一步只有两种结果：排好了（存结果、生成成片版本），或者失败（带原因，能重试）。
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { readFormulaGenerationRequest } from './generation.ts';
import { assertFormulaNarrationAudio } from './narration.ts';
import { verifyFormulaCandidate } from './candidate-media.ts';
import { projectAssetFileIdentity, projectAssetMimeType } from '../project-asset-media.ts';
import { resolveSourceFilePath } from '../media-catalog.ts';
import { arrangeFormulaTime, validateFormulaShortFilm, type NarrationTake, type TimelinePlan, type VoicePlan } from '../scheduling/index.ts';
import type { SchedulingJudgment, SchedulingScript } from '../scheduling/types.ts';
import type { FormulaGenerationOutput, FormulaGenerationRequest } from './generation.ts';
import type { FormulaSelection } from './selection.ts';
import { readFormulaVoiceStage, readFormulaVoiceNarrationResult, readFormulaVoiceResult,
  type FormulaVoiceNarrationStageResult } from './pipeline-v2.ts';
import { verifyFormulaCandidateCached, recheckFormulaCandidateCached } from './candidate-cache.ts';
import type { FormulaVerifiedCandidate } from './candidate-media.ts';

export interface FormulaScheduleStageInput {
  formatVersion: 1;
  voiceStageId: string;
  narrationStageId: string | null;
}

export interface FormulaScheduleStageResult {
  status: 'planned';
  algorithmVersion: 'formula-schedule/1';
  executionReady: false;
  reviewStatus: 'pending';
  voiceStageId: string;
  narrationStageId: string | null;
  plan: VoicePlan;
  timeline: TimelinePlan;
  warnings: string[];
}

export interface FormulaScheduleStage {
  id: string; selectionStageId: string; voiceStageId: string; narrationStageId: string | null;
  revision: number; input: FormulaScheduleStageInput;
}

export function readFormulaScheduleStage(db: Database.Database, stageId: string): FormulaScheduleStage {
  const row = db.prepare('SELECT * FROM live_mixcut_formula_schedule_stages WHERE id=?').get(stageId) as
    { id: string; selectionStageId: string; voiceStageId: string; narrationStageId: string | null; revision: number; inputJson: string } | undefined;
  if (!row) throw new BatchDomainError('not_found', '排时间阶段不存在');
  const input = JSON.parse(row.inputJson) as FormulaScheduleStageInput;
  if (input.formatVersion !== 1) throw new BatchDomainError('conflict', '不支持这次排时间的输入版本');
  return { ...row, input };
}

export function readFormulaScheduleStageResult(db: Database.Database, stageId: string): FormulaScheduleStageResult | null {
  const row = db.prepare('SELECT resultJson FROM live_mixcut_formula_schedule_results WHERE stageId=?').get(stageId) as
    { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaScheduleStageResult : null;
}

/** 这条成片最新一次排时间的结果；没有就是还没排。 */
export function readFormulaScheduleResult(db: Database.Database, selectStageId: string): FormulaScheduleStageResult | null {
  const row = db.prepare(`SELECT x.resultJson FROM live_mixcut_formula_schedule_stages s
    JOIN live_mixcut_formula_schedule_results x ON x.stageId=s.id
    WHERE s.selectionStageId=? ORDER BY s.revision DESC LIMIT 1`).get(selectStageId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as FormulaScheduleStageResult : null;
}

export function readFormulaScheduleStageId(db: Database.Database, selectStageId: string): string | null {
  const row = db.prepare('SELECT id FROM live_mixcut_formula_schedule_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectStageId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 配音的逐行结果；没有要配音的行时是空数组。 */
export function narrationTakes(result: FormulaVoiceNarrationStageResult | null): NarrationTake[] {
  return (result?.items ?? []).map(item => ({ lineIndex: item.lineIndex, text: item.text,
    durationUs: item.audio.durationUs, words: item.audio.words.map(word => ({ text: word.text, startUs: word.startUs, endUs: word.endUs })),
    contentFingerprint: item.audio.fingerprint, relativePath: item.audio.relativePath }));
}

export interface FormulaSchedulePlanInput {
  script: SchedulingScript;
  plan: VoicePlan;
  materials: import('../scheduling/types.ts').SchedulingSlotMaterial[];
  judgment: SchedulingJudgment;
  narration: FormulaVoiceNarrationStageResult | null;
}

/** 纯计算：排片计算 + 逐条检查。规矩 h 不通过时抛错，由调用方让这条成片带原因失败。 */
export function buildFormulaSchedulePlan(input: FormulaSchedulePlanInput): TimelinePlan {
  const narration = narrationTakes(input.narration);
  const timeline = arrangeFormulaTime({ plan: input.plan, materials: input.materials, narrations: narration,
    judgment: input.judgment, scriptNumber: input.script.scriptNumber, copyIndex: input.script.copyIndex });
  const problems = validateFormulaShortFilm({ plan: input.plan, timeline, materials: input.materials });
  if (problems.length) throw new BatchDomainError('conflict', `排时间没有通过检查：${problems.join('；')}`);
  return timeline;
}

/** 从阶段自己的冻结输入还原排时间要用的全部东西。 */
export function readFormulaScheduleInput(db: Database.Database, stage: FormulaScheduleStage) {
  const voiceStage = readFormulaVoiceStage(db, stage.voiceStageId);
  const plan = readFormulaVoiceResult(db, stage.selectionStageId);
  if (!plan) throw new BatchDomainError('conflict', '排时间缺少定声音结果');
  const narration = stage.narrationStageId ? readFormulaVoiceNarrationResult(db, stage.selectionStageId) : null;
  if (stage.narrationStageId && !narration) throw new BatchDomainError('conflict', '排时间缺少配音结果');
  if (plan.narrationLines.length && !narration) throw new BatchDomainError('conflict', '排时间缺少这部成片的配音');
  const selection = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?')
    .get(stage.selectionStageId) as { resultJson: string } | undefined;
  if (!selection) throw new BatchDomainError('conflict', '排时间缺少选片结果');
  return { voiceStage, plan, narration, selection: JSON.parse(selection.resultJson) as FormulaSelection };
}

export function readFormulaScheduleSelection(db: Database.Database, selectStageId: string): FormulaSelection {
  const row = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?').get(selectStageId) as
    { resultJson: string } | undefined;
  if (!row) throw new BatchDomainError('conflict', '排时间缺少选片结果');
  return JSON.parse(row.resultJson) as FormulaSelection;
}

/** 定声音里的 slotIndex 就是公式镜头序号，和选片槽位一一对应。 */
export function selectionSlotId(selection: FormulaSelection, slotIndex: number): string {
  const slot = selection.slots[slotIndex];
  if (!slot) throw new BatchDomainError('conflict', '排时间与选片槽位对不上');
  return slot.slotId;
}

/** 成片版本和排时间结果对得上；失败信息写明是哪一份材料出了问题。 */
export async function verifyFormulaScheduleFiles(db: Database.Database, projectId: string, request: FormulaGenerationRequest,
  timeline: TimelinePlan, signal: AbortSignal): Promise<{ verified: FormulaVerifiedCandidate[]; recheck: () => void }> {
  const files = new Map<string, { contentFingerprint: string; fileName: string }>();
  for (const clip of timeline.clips) files.set(clip.assetId, { contentFingerprint: clip.contentFingerprint, fileName: clip.fileName });
  const verified: FormulaVerifiedCandidate[] = [];
  for (const [assetId, file] of files) {
    const sources = request.input.mediaSources.find(item => item.assetId === assetId)?.sources ?? [];
    const candidate = await verifyFormulaCandidateCached(db, projectId, assetId, file.contentFingerprint, sources, signal);
    if (!candidate) throw new BatchDomainError('conflict', `排时间要用到的素材无法核验：${file.fileName}。请恢复原片后重试`);
    verified.push(candidate);
  }
  return { verified, recheck: () => { for (const candidate of verified) recheckFormulaCandidateCached(db, projectId, candidate); } };
}

/** 生成时的脚本编号和份次，排时间只需要这两个数。 */
export function scheduleScriptOf(request: FormulaGenerationRequest, output: FormulaGenerationOutput): SchedulingScript {
  const script = request.input.scripts.find(item => item.key === output.scriptKey);
  if (!script) throw new BatchDomainError('conflict', '这条成片缺少冻结的脚本');
  return { scriptNumber: output.scriptNumber, copyIndex: output.copyIndex,
    lines: script.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    codes: output.slots.map(slot => slot.logicalCode), estimatedDurationSec: script.targetDurationSec ?? null };
}

export interface FormulaScheduleOutputOwner { planId: string; selectionStageId: string; requestId: string }

/** 这条成片确实由这次排时间产生；界面传来的阶段身份不接受张冠李戴。 */
export function readFormulaScheduleOutputOwner(db: Database.Database, outputVersionId: string,
  scheduleStageId: string, selectionStageId: string): FormulaScheduleOutputOwner | null {
  const row = db.prepare(`SELECT planId,selectionStageId,sourceStageId,requestId FROM live_mixcut_formula_output_lineage
    WHERE outputVersionId=? AND sourceKind='schedule'`).get(outputVersionId) as
      { planId: string; selectionStageId: string; sourceStageId: string; requestId: string } | undefined;
  if (!row || row.sourceStageId !== scheduleStageId || row.selectionStageId !== selectionStageId) return null;
  return { planId: row.planId, selectionStageId: row.selectionStageId, requestId: row.requestId };
}

/** 排时间结果的画面和声音来自哪里：只认这份结果里登记过的片段，重新核验原片。 */
export async function resolveFormulaScheduleMedia(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId: string, scheduleStageId: string, outputVersionId: string, kind: string, mediaId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const owner = readFormulaScheduleOutputOwner(db, outputVersionId, scheduleStageId, selectionStageId);
  if (!owner || owner.planId !== planId) throw new BatchDomainError('not_found', '排片预览不存在，请刷新');
  const result = readFormulaScheduleStageResult(db, scheduleStageId);
  if (!result || result.status !== 'planned') throw new BatchDomainError('not_found', '排片预览尚未就绪');
  const request = readFormulaGenerationRequest(db, projectId, batchId, owner.requestId);
  const verify = async (assetId: string, contentFingerprint: string, needAudio: boolean) => {
    const sources = request.input.mediaSources.find(item => item.assetId === assetId)?.sources ?? [];
    const verified = await verifyFormulaCandidate(db, projectId, assetId, contentFingerprint, sources, signal);
    if (!verified || (needAudio && !verified.media.hasAudio)) throw new BatchDomainError('conflict', '原片已变化，请重新核验');
    return verified;
  };
  if (kind === 'video') {
    const clip = result.timeline.clips.find(item => item.id === mediaId);
    if (!clip) throw new BatchDomainError('not_found', '这段画面不属于当前排片');
    const verified = await verify(clip.assetId, clip.contentFingerprint, false);
    const absolutePath = resolveSourceFilePath(verified.location);
    signal.throwIfAborted();
    return { absolutePath, identity: verified.fileIdentity, mimeType: projectAssetMimeType(absolutePath) };
  }
  const sound = result.timeline.sounds.find(item => item.id === mediaId);
  if (!sound) throw new BatchDomainError('not_found', '这段声音不属于当前排片');
  if (sound.kind === 'narration') {
    const narration = result.narrationStageId ? readFormulaVoiceNarrationResult(db, owner.selectionStageId) : null;
    const item = narration?.items.find(entry => `narration:${entry.lineIndex}` === sound.id);
    if (!item || item.audio.fingerprint !== sound.contentFingerprint) throw new BatchDomainError('conflict', '配音不属于这份成片');
    const absolutePath = assertFormulaNarrationAudio(projectId, item.text, item.audio);
    return { absolutePath, identity: projectAssetFileIdentity(fs.statSync(absolutePath)), mimeType: 'audio/wav' };
  }
  if (!sound.assetId) throw new BatchDomainError('conflict', '这段原声缺少关联画面');
  const verified = await verify(sound.assetId, sound.contentFingerprint, true);
  const absolutePath = resolveSourceFilePath(verified.location);
  signal.throwIfAborted();
  return { absolutePath, identity: verified.fileIdentity, mimeType: projectAssetMimeType(absolutePath) };
}
