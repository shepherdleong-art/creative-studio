/**
 * 新规矩的选片：公式里的编号按轮换规则取文件，缺号记下来交给定声音替代，不停下等人。
 *
 * 与旧选片的区别：
 * - 不用 AI、不用人工指定、不用有效区间批准；只核验实际文件能不能用。
 * - 缺号、文件不可用都不让整条成片停下：结果永远是「已选片」，缺的编号写在 missingCodes。
 * - 文件名里的口播台词、全景标记跟着绑定走，定声音直接读。
 */
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { rotationIndex } from '../scheduling/text.ts';
import { selectFormulaScript, type FormulaSelectedCode } from './script-selection.ts';
import type { FormulaGenerationOutput, FormulaGenerationRequest } from './generation.ts';
import type { FormulaCandidateSource, FormulaVerifiedCandidate } from './candidate-media.ts';
import type { FormulaSelection, FormulaSelectionSlot } from './selection.ts';

/** 已核验文件的查询入口；批量里每条成片共用同一个缓存，同一文件只核验一次。 */
export type FormulaCandidateVerifier = (assetId: string, contentFingerprint: string,
  sources: FormulaCandidateSource[], signal: AbortSignal) => Promise<FormulaVerifiedCandidate | null>;

export interface FormulaSelectionV2Options {
  verify: FormulaCandidateVerifier;
  onProgress?: (completed: number, total: number) => void;
}

/** 公式里缺的编号：没有文件，或文件都核验不过。按公式顺序去重。 */
function addMissing(missing: string[], code: string): void {
  if (!missing.includes(code)) missing.push(code);
}

export async function selectFormulaOutputV2(db: Database.Database, projectId: string, request: FormulaGenerationRequest,
  output: FormulaGenerationOutput, signal: AbortSignal, options: FormulaSelectionV2Options): Promise<FormulaSelection> {
  signal.throwIfAborted();
  const script = request.input.scripts.find(item => item.key === output.scriptKey);
  if (!script) throw new BatchDomainError('conflict', '选片缺少这条脚本的冻结文案');
  const bindings = request.input.materialIndex.bindings.map(binding => ({ assetId: binding.assetId,
    contentFingerprint: binding.contentFingerprint, fileName: binding.sourceName, logicalCode: binding.logicalCode,
    available: binding.available, excludedReason: binding.excludedReason }));
  const selection = selectFormulaScript({ scriptNumber: output.scriptNumber, copyIndex: output.copyIndex,
    codes: output.slots.map(slot => slot.logicalCode), bindings });
  const byCode = new Map<string, FormulaSelectedCode>(selection.codes.map(code => [code.logicalCode, code]));
  const verified = new Map<string, FormulaVerifiedCandidate | null>();
  const codes = request.input.materialIndex.codes;
  const sources = (assetId: string) => request.input.mediaSources.find(item => item.assetId === assetId)?.sources ?? [];
  const missingCodes: string[] = [];
  let completed = 0;

  /** 轮换到的文件先试；不能用再按同一顺序试后面的，绝不因为一份文件停下整条成片。 */
  const choose = async (code: FormulaSelectedCode): Promise<FormulaVerifiedCandidate | null> => {
    if (!code.files.length) return null;
    const start = rotationIndex(output.scriptNumber, output.copyIndex - 1, code.files.length);
    const ordered = [...code.files.slice(start), ...code.files.slice(0, start)];
    for (const file of ordered) {
      signal.throwIfAborted();
      if (!verified.has(file.assetId)) {
        verified.set(file.assetId, await options.verify(file.assetId, file.contentFingerprint, sources(file.assetId), signal));
      }
      const candidate = verified.get(file.assetId);
      if (candidate) return candidate;
    }
    return null;
  };

  const slots: FormulaSelectionSlot[] = [];
  for (const slot of output.slots) {
    signal.throwIfAborted();
    const code = byCode.get(slot.logicalCode);
    const candidate = code ? await choose(code) : null;
    if (!candidate) addMissing(missingCodes, slot.logicalCode);
    const defined = codes.find(item => item.logicalCode === slot.logicalCode)?.defined ?? false;
    const fileCount = code?.files.length ?? 0;
    slots.push({ ...slot, sourceLogicalCode: slot.logicalCode, candidate, assetId: candidate?.assetId ?? null,
      media: candidate?.media ?? null, rangeStatus: 'pending',
      reason: candidate ? (fileCount > 1 ? 'same_code_stable_choice' : 'exact_code')
        : !defined ? 'undefined' : fileCount ? 'unusable' : 'missing_file' });
    completed += 1;
    options.onProgress?.(completed, output.slots.length);
  }
  return { algorithmVersion: 'formula-selection/6', status: 'selected', executionReady: false, slots, missingCodes };
}
