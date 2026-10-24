import { FINAL_EDIT_FPS } from '../../media-core/render-contract.ts';
import { BatchDomainError } from '../errors.ts';

export interface FormulaRangeBounds { inUs: number; outUs: number }
export interface FormulaAvailableRange extends FormulaRangeBounds { id: string; label: string; protected: FormulaRangeBounds | null }
export interface FormulaSavedAssetRanges {
  id: string; assetId: string; contentFingerprint: string; revision: number; createdAt: string;
  origin: 'manual'; audioStatus: 'pending'; mediaDurationUs: number | null; ranges: FormulaAvailableRange[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new BatchDomainError('invalid_input', '区间格式不正确');
  }
  return value as Record<string, unknown>;
}
function bounds(input: Record<string, unknown>, durationUs: number): FormulaRangeBounds {
  const { inUs, outUs } = input as unknown as FormulaRangeBounds;
  if (!Number.isSafeInteger(inUs) || !Number.isSafeInteger(outUs) || inUs < 0 || outUs <= inUs || outUs > durationUs) {
    throw new BatchDomainError('invalid_input', '区间起止时间无效或超出原片实际时长');
  }
  return { inUs, outUs };
}

export function parseFormulaAvailableRanges(value: unknown, durationUs: number): Omit<FormulaAvailableRange, 'id'>[] {
  if (!Array.isArray(value) || value.length > 100) throw new BatchDomainError('invalid_input', '每份原片最多保存 100 个可用区间');
  return value.map((raw, index) => {
    const item = object(raw, ['label', 'inUs', 'outUs', 'protected']);
    const range = bounds(item, durationUs);
    const startFrame = Math.ceil(range.inUs * FINAL_EDIT_FPS / 1_000_000);
    const endFrame = Math.floor(range.outUs * FINAL_EDIT_FPS / 1_000_000);
    if (endFrame - startFrame < FINAL_EDIT_FPS / 2) throw new BatchDomainError('invalid_input', '可用区间至少需要容纳 12 个完整输出帧（0.5 秒）');
    const protectedRange = item.protected == null ? null : bounds(object(item.protected, ['inUs', 'outUs']), durationUs);
    if (protectedRange && (protectedRange.inUs < range.inUs || protectedRange.outUs > range.outUs
      || Math.floor(protectedRange.inUs * FINAL_EDIT_FPS / 1_000_000) < startFrame
      || Math.ceil(protectedRange.outUs * FINAL_EDIT_FPS / 1_000_000) > endFrame)) {
      throw new BatchDomainError('invalid_input', '可用区间必须完整包含保护动作，并留足帧边界');
    }
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 100 || /[\u0000-\u001f\u007f]/.test(item.label))) {
      throw new BatchDomainError('invalid_input', '区间名称最多 100 字，不能包含控制字符');
    }
    return { ...range, label: (item.label as string | undefined)?.trim() || `片段 ${index + 1}`, protected: protectedRange };
  });
}
