import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { VideoMediaProbe } from '../../ffmpeg.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaVerifiedCandidate as VerifiedCandidate } from './candidate-media.ts';
import type { FormulaGenerationOutput, FormulaGenerationRequest } from './generation.ts';
import { parseFormulaAvailableRanges, type FormulaSavedAssetRanges } from './range-contract.ts';
import { findFormulaReplacements, resolveFormulaReplacementModel, type FormulaReplacement,
  describeManualFormulaReplacement, type FormulaManualReplacement, type FormulaReplacementSearch, type FormulaReplacementModelResolver } from './replacements.ts';
import type { FormulaSlotChoice } from './selection-rules.ts';
import { BatchDomainError } from '../errors.ts';
import { materialContentScore } from './material-content.ts';

export interface FormulaSelectionSlot {
  slotId: string; clipId: number; logicalCode: string; assetId: string | null;
  candidate: VerifiedCandidate | null; media: VideoMediaProbe | null; rangeStatus: 'pending' | 'confirmed';
  approvedRanges?: FormulaSavedAssetRanges | null;
  sourceLogicalCode?: string;
  replacement?: FormulaReplacement;
  manualReplacement?: FormulaManualReplacement;
  replacementCheck?: Omit<FormulaReplacementSearch, 'proposals'>;
  reason: 'exact_code' | 'same_code_stable_choice' | 'same_code_content_choice' | 'manual_primary' | 'manual_slot' | 'manual_unusable' | 'approved_rotation' | 'rotation_unusable' | 'missing_file' | 'undefined' | 'unusable' | 'automatic_replacement' | 'manual_replacement' | 'manual_replacement_unusable';
}
export interface FormulaSelection {
  algorithmVersion: 'formula-selection/1' | 'formula-selection/2' | 'formula-selection/3' | 'formula-selection/4' | 'formula-selection/5' | 'formula-selection/6';
  status: 'selected' | 'needs_attention';
  executionReady: false; slots: FormulaSelectionSlot[];
  /** 新规矩（/6）：公式里没有可用文件的编号；缺号不停，交给定声音替代。 */
  missingCodes?: string[];
}

/** 先核验原编号，确实不可用才按冻结资料寻找直接替代；替换始终待审。 */
export async function selectFormulaOutput(db: Database.Database, projectId: string, request: FormulaGenerationRequest,
  output: FormulaGenerationOutput, signal: AbortSignal, onProgress: (completed: number, total: number) => void,
  resolveModel: FormulaReplacementModelResolver = () => resolveFormulaReplacementModel(request, projectId),
  overrides?: FormulaSlotChoice[]): Promise<FormulaSelection> {
  signal.throwIfAborted();
  if (!db.prepare(`SELECT 1 FROM live_mixcut_formula_generation_requests r
    JOIN live_mixcut_formula_generation_outputs o ON o.requestId=r.id WHERE r.id=? AND r.projectId=? AND r.batchVersionId=? AND o.planId=?`)
    .get(request.id, projectId, request.batchVersionId, output.planId)) {
    throw new BatchDomainError('not_found', '此项目的公式生成请求或输出不存在');
  }
  const verified = new Map<string, VerifiedCandidate | null>();
  const replacementSearches = new Map<string, FormulaReplacementSearch>();
  let model: ReturnType<FormulaReplacementModelResolver> | undefined;
  const slots: FormulaSelectionSlot[] = [];
  for (const slot of output.slots) {
    signal.throwIfAborted();
    const override = (overrides ?? request.input.selectionRules?.rules.overrides)?.find(choice => choice.scriptKey === output.scriptKey
      && choice.slotIndex === slot.clipId && choice.logicalCode === slot.logicalCode);
    async function choose(sourceLogicalCode: string, override?: FormulaSlotChoice, permittedAssets?: readonly string[]) {
      const bindings = request.input.materialIndex.bindings.filter(binding => binding.logicalCode === sourceLogicalCode
        && !binding.excludedReason && binding.available && (!permittedAssets || permittedAssets.includes(binding.assetId)));
      const primary = request.input.selectionRules?.rules.primary.find(choice => choice.logicalCode === sourceLogicalCode);
      const rotation = request.input.selectionRules?.rules.rotation?.find(pool => pool.logicalCode === sourceLogicalCode);
      const fixed = override ?? primary;
      let assetIds = fixed ? bindings.filter(binding => binding.assetId === fixed.assetId
        && binding.contentFingerprint === fixed.contentFingerprint).map(binding => binding.assetId)
        : rotation ? rotation.candidates.map(candidate => candidate.assetId).sort() : [...new Set(bindings.map(binding => binding.assetId))].sort();
      const script = request.input.scripts.find(script => script.key === output.scriptKey);
      const context = [request.input.materialIndex.codes.find(code => code.logicalCode === sourceLogicalCode)?.description, script?.bodyText].filter(Boolean).join('；');
      const scores = new Map(assetIds.map(id => [id, materialContentScore(request.input.materialNotes, id, sourceLogicalCode, context)]));
      const contentRanked = !fixed && !rotation && new Set(scores.values()).size > 1;
      if (contentRanked) assetIds.sort((a, b) => scores.get(b)! - scores.get(a)! || a.localeCompare(b));
      if (rotation && !fixed && assetIds.length) {
        const seedOffset = createHash('sha256').update(JSON.stringify([request.seed, sourceLogicalCode])).digest().readUInt32BE(0);
        const scriptIndex = request.input.scripts.findIndex(script => script.key === output.scriptKey);
        const offset = (seedOffset + Math.max(0, scriptIndex) + output.copyIndex - 1 + slot.clipId) % assetIds.length;
        assetIds = [...assetIds.slice(offset), ...assetIds.slice(0, offset)];
      }
      let candidate: VerifiedCandidate | null = null;
      let approvedRanges: FormulaSavedAssetRanges | null = null;
      for (const assetId of assetIds) {
        const binding = bindings.find(binding => binding.assetId === assetId);
        const approved = request.input.assetRanges?.find(range => range.assetId === assetId
          && range.contentFingerprint === binding?.contentFingerprint && range.ranges.length) ?? null;
        if (!binding || (!fixed && rotation && !rotation.candidates.some(item => item.assetId === assetId
          && item.contentFingerprint === binding.contentFingerprint && item.rangeRevisionId === approved?.id))) continue;
        if (!verified.has(assetId)) verified.set(assetId, await verifyFormulaCandidate(db, projectId, assetId,
          binding.contentFingerprint,
          request.input.mediaSources.find(item => item.assetId === assetId)?.sources ?? [], signal));
        candidate = verified.get(assetId)!;
        if (candidate && approved) {
          try { parseFormulaAvailableRanges(approved.ranges.map(({ label, inUs, outUs, protected: protection }) => ({ label, inUs, outUs, protected: protection })), candidate.media.durationUs); }
          catch { candidate = null; }
        }
        if (candidate) { approvedRanges = approved; break; }
      }
      return { sourceLogicalCode, candidate, approvedRanges, fixed, primary, rotation, assetIds, contentRanked };
    }
    let choice = await choose(override?.sourceLogicalCode ?? slot.logicalCode, override);
    let replacement: FormulaReplacement | undefined;
    let manualReplacement: FormulaManualReplacement | undefined;
    let replacementCheck: FormulaSelectionSlot['replacementCheck'];
    // 人工固定及批准池无可用文件时保持“需处理”，不越过用户选择另找编号。
    if (!choice.candidate && !choice.fixed && !choice.rotation) {
      const mapping = request.input.selectionRules?.rules.replacements?.find(rule => rule.logicalCode === slot.logicalCode);
      if (mapping) {
        manualReplacement = describeManualFormulaReplacement(request, mapping);
        if (!request.input.materialIndex.codes.some(code => code.logicalCode === slot.logicalCode && code.defined)) {
          replacementCheck = { status: 'undefined', message: '原编号的素材定义已缺失，请补充资料或修正公式后重新生成' };
        } else {
          choice = await choose(mapping.replacementCode);
          if (!choice.candidate) replacementCheck = { status: 'no_equivalent', message: '人工指定的直接替代素材或已批准区间不可用，请修正规则后重新生成' };
        }
      } else {
      if (!replacementSearches.has(slot.logicalCode)) replacementSearches.set(slot.logicalCode,
        await findFormulaReplacements(request, output, slot.logicalCode, signal, () => model ??= resolveModel()));
      const search = replacementSearches.get(slot.logicalCode)!;
      replacementCheck = { status: search.status, message: search.message };
      for (const proposal of search.proposals) {
        const target = await choose(proposal.replacementCode, undefined, proposal.candidateAssetIds);
        if (target.candidate) { choice = target; replacement = proposal; break; }
      }
      if (search.proposals.length && !replacement) replacementCheck = { status: 'no_equivalent', message: '有资料相符的候选，但实际文件或已批准区间不可用，请补充素材后重新生成' };
      }
    }
    const { sourceLogicalCode, candidate, approvedRanges, fixed, primary, rotation, assetIds, contentRanked } = choice;
    const defined = request.input.materialIndex.codes.find(code => code.logicalCode === slot.logicalCode)?.defined;
    slots.push({ ...slot, sourceLogicalCode, candidate, approvedRanges, assetId: candidate?.assetId ?? null,
      ...(replacement ? { replacement } : {}), ...(replacementCheck ? { replacementCheck } : {}),
      ...(manualReplacement ? { manualReplacement } : {}),
      media: candidate?.media ?? null, rangeStatus: approvedRanges ? 'confirmed' : 'pending',
      reason: candidate ? (manualReplacement ? 'manual_replacement' : replacement ? 'automatic_replacement' : override ? 'manual_slot' : primary ? 'manual_primary' : rotation ? 'approved_rotation' : contentRanked ? 'same_code_content_choice' : assetIds.length > 1 ? 'same_code_stable_choice' : 'exact_code')
        : manualReplacement ? 'manual_replacement_unusable' : fixed ? 'manual_unusable' : rotation ? 'rotation_unusable' : assetIds.length ? 'unusable' : defined ? 'missing_file' : 'undefined' });
    onProgress(slots.length, output.slots.length);
  }
  return { algorithmVersion: 'formula-selection/5', status: slots.every(slot => slot.candidate) ? 'selected' : 'needs_attention',
    executionReady: false, slots };
}

export function recheckSelectionFiles(db: Database.Database, projectId: string, selection: FormulaSelection): void {
  for (const slot of selection.slots) {
    if (slot.candidate) recheckFormulaCandidate(db, projectId, slot.candidate);
  }
}
