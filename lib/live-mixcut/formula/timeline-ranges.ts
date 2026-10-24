import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../../media-core/render-contract.ts';
import { planFormulaDuration, type FormulaDurationAudio, type FormulaDurationResult, type FormulaDurationSlot, type FormulaDurationTarget } from './duration.ts';

interface Option<T> { min: number; max: number; value: T }
interface Span<T> { min: number; max: number; previous?: Span<T>; option?: Option<T> }
type RangeConflict = Exclude<FormulaDurationResult, { status: 'planned' }>;
class RangeSearchLimit extends Error {}

/** 每段覆盖保存一个可追溯的组合，重叠部分只保留确定性的一条路径；不枚举所有区间乘积。 */
function extend<T>(previous: Span<T>[], options: Option<T>[]): Span<T>[] {
  if (previous.length * options.length > 1_000_000) throw new RangeSearchLimit();
  const candidates = previous.flatMap(prior => options.map(option => ({ min: prior.min + option.min, max: prior.max + option.max, previous: prior, option })));
  candidates.sort((a, b) => a.min - b.min || b.max - a.max);
  const kept: Span<T>[] = [];
  let covered = -1;
  for (const item of candidates) {
    if (item.max <= covered) continue;
    kept.push({ ...item, min: Math.max(item.min, covered + 1) });
    covered = item.max;
  }
  if (kept.length > 20_000) throw new RangeSearchLimit();
  return kept;
}

function unwind<T>(span: Span<T>, total: number): Array<{ value: T; frames: number }> {
  const choices: Array<{ value: T; frames: number }> = [];
  let current = span;
  while (current.option && current.previous) {
    const low = Math.max(current.option.min, total - current.previous.max);
    const high = Math.min(current.option.max, total - current.previous.min);
    const frames = Math.min(high, Math.max(low, current.option.min));
    choices.push({ value: current.option.value, frames });
    total -= frames; current = current.previous;
  }
  return choices.reverse();
}

/** 先找能保全原声/动作/配音的区间组合，再交给帧级计划器分配实际镜头长度。 */
export function selectFormulaTimelineRanges(candidates: FormulaDurationSlot[][], target: FormulaDurationTarget,
  audio: Extract<FormulaDurationAudio, { status: 'ready' }>): { slots: FormulaDurationSlot[] } | { conflict: RangeConflict } {
  const options: Array<Option<FormulaDurationSlot>[]> = [];
  for (const choices of candidates) {
    const legal: Option<FormulaDurationSlot>[] = [];
    let firstConflict: RangeConflict | undefined;
    for (const slot of choices) {
      const sourceAudio = { ...audio, narrations: [], sources: audio.sources.filter(source => source.slotId === slot.slotId) };
      const minimum = planFormulaDuration({ slots: [slot], target: { mode: 'reference', scope: 'body', durationUs: 1 }, audio: sourceAudio });
      if (minimum.status !== 'planned') { firstConflict ??= minimum; continue; }
      const maximum = planFormulaDuration({ slots: [slot], target: { mode: 'reference', scope: 'body', durationUs: slot.mediaDurationUs }, audio: sourceAudio });
      if (maximum.status !== 'planned') { firstConflict ??= maximum; continue; }
      legal.push({ min: minimum.bodyFrames, max: maximum.bodyFrames, value: slot });
    }
    if (!legal.length) return { conflict: firstConflict! };
    options.push(legal);
  }
  try {
    const grouped: Array<Option<Span<FormulaDurationSlot>>[]> = [];
    for (let index = 0; index < candidates.length;) {
      const window = audio.narrations.find(window => window.slotIds[0] === candidates[index][0].slotId);
      const size = window?.slotIds.length ?? 1;
      // 非连续/重叠/跨原声错误交回主计划器，由它返回稳定的冲突代码。
      if (window && window.slotIds.some((id, i) => candidates[index + i]?.[0].slotId !== id)) return { slots: options.map(items => items[0].value) };
      let frontier: Span<FormulaDurationSlot>[] = [{ min: 0, max: 0 }];
      for (let i = 0; i < size; i++) frontier = extend(frontier, options[index + i]);
      const required = window ? Math.ceil((window.sourceOutUs - window.sourceInUs) * FINAL_EDIT_FPS / 1_000_000) : 0;
      const allowed = frontier.filter(span => span.max >= required).map(span => ({ min: Math.max(span.min, required), max: span.max, value: span }));
      // 无可用组合时保留最大画面容量，最终返回真实的配音窗口不足，而不随意丢声音。
      grouped.push(allowed.length ? allowed : [{ min: frontier.at(-1)!.min, max: frontier.at(-1)!.max, value: frontier.at(-1)! }]);
      index += size;
    }
    let totals: Span<Span<FormulaDurationSlot>>[] = [{ min: 0, max: 0 }];
    for (const group of grouped) totals = extend(totals, group);
    const numerator = BigInt(target.durationUs) * BigInt(FINAL_EDIT_FPS);
    const targetFrames = Number((numerator + BigInt(target.mode === 'strict_max' ? 0 : 500_000)) / BigInt(1_000_000))
      - (target.scope === 'total' ? FINAL_EDIT_INTRO_FRAMES : 0);
    const best = totals.reduce((best, span) => {
      const at = Math.min(span.max, Math.max(span.min, targetFrames));
      const bestAt = Math.min(best.max, Math.max(best.min, targetFrames));
      const score = target.mode === 'strict_max' && at > targetFrames ? Number.POSITIVE_INFINITY : Math.abs(at - targetFrames);
      const bestScore = target.mode === 'strict_max' && bestAt > targetFrames ? Number.POSITIVE_INFINITY : Math.abs(bestAt - targetFrames);
      return score < bestScore ? span : best;
    });
    const frames = Math.min(best.max, Math.max(best.min, targetFrames));
    return { slots: unwind(best, frames).flatMap(group => unwind(group.value, group.frames).map(item => item.value)) };
  } catch (error) {
    if (!(error instanceof RangeSearchLimit)) throw error;
    return { conflict: { status: 'needs_attention', executionReady: false, conflicts: [{ code: 'range_search_limit',
      slotIds: candidates.map(items => items[0].slotId), message: '可用区间组合过多，请减少候选区间后重试；本次未截断或跳过镜头。' }] } };
  }
}
