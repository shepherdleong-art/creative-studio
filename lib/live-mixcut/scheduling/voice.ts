/**
 * 定声音：配音之前调用。决定哪些口播放原片、哪些文案行被原声覆盖、
 * 哪些行要配音、每行配在哪个画面上（含最后一行挪到片尾）、缺号用什么替代。
 *
 * 规矩 a～f 全在这里；时间相关的规矩 g 在 arrange-time.ts。
 */
import {
  type NarrationTake, type SchedulingFile, type SchedulingInput, type SchedulingJudgment,
  type SchedulingSlotMaterial, type SchedulingSubstitution, type VoicePlan, type VoicePlanItem, type VoicePlanLine,
  SCHEDULING_VERSION,
} from './types.ts';
import { isVoiceOver, normalizeSpeechText, rotationIndex, slotKind } from './text.ts';

interface SlotState {
  index: number;
  code: string;
  kind: string;
  isVo: boolean;
  material: SchedulingSlotMaterial | null;
  file: SchedulingFile | null;
  substitution: SchedulingSubstitution | null;
  /** 这段口播顶掉的文案行。 */
  anchor: number | null;
  role: 'anchor' | 'similar' | 'picked' | 'muted' | null;
  unused: boolean;
  unusedReason: string | null;
  /** 这段口播能不能放原片：是口播镜头、有文件、且识别出了有效台词。 */
  canSpeak: boolean;
}

type ShotItem = {
  kind: 'shot'; slotIndex: number; code: string; file: SchedulingFile | null;
  substitution: SchedulingSubstitution | null; lines: number[]; dropped: boolean;
};
type VoItem = { kind: 'vo'; slotIndex: number; code: string; file: SchedulingFile; role: 'anchor' | 'similar' | 'picked' };
type InsertItem = { kind: 'insert'; lines: number[] };
type EndingItem = { kind: 'ending'; lines: number[] };
type DraftItem = ShotItem | VoItem | InsertItem | EndingItem;

function hasSpeech(file: SchedulingFile | null): boolean {
  return Boolean(file?.speech && normalizeSpeechText(file.speech.text));
}

function buildSlots(input: SchedulingInput): SlotState[] {
  const { script } = input;
  return script.codes.map((code, index) => {
    const direct = input.materials.find(material => material.logicalCode === code) ?? null;
    const isVo = isVoiceOver(code);
    let material = direct;
    let substitution: SchedulingSubstitution | null = null;
    let file: SchedulingFile | null = null;
    if (direct?.files.length) {
      file = direct.files[rotationIndex(script.scriptNumber, script.copyIndex - 1, direct.files.length)];
    } else {
      // 有替换表就按表；表里的编号没有文件时仍算缺号。
      const target = input.replacements?.[code];
      const alternative = target ? input.materials.find(material => material.logicalCode === target) : null;
      if (alternative?.files.length) {
        const picked = alternative.files[rotationIndex(script.scriptNumber, script.copyIndex - 1, alternative.files.length)];
        material = alternative;
        file = picked;
        substitution = { replacedCode: code, from: 'replacement-table', file: picked };
      }
    }
    return {
      index, code, kind: material?.kind ?? slotKind(code), isVo, material, file, substitution,
      anchor: null, role: null, unused: false, unusedReason: null,
      canSpeak: isVo && hasSpeech(file),
    };
  });
}

/** 按台词逐字匹配：文案这一行里含这段口播的台词。 */
function anchorPlannedLines(slots: SlotState[], lines: VoicePlanLine[]): void {
  let from = 0;
  for (const slot of slots) {
    if (!slot.canSpeak || !slot.material?.voLine) continue;
    const wanted = normalizeSpeechText(slot.material.voLine);
    if (!wanted) continue;
    const line = lines.find(item => item.index >= from && !item.fate && normalizeSpeechText(item.text).includes(wanted));
    if (!line) continue;
    line.fate = { type: 'source', logicalCode: slot.code, basis: 'planned' };
    slot.anchor = line.index;
    slot.role = 'anchor';
    from = line.index + 1;
  }
}

/** AI 判断意思相近的行；对不上号的条目丢掉不用。 */
function anchorSimilarLines(input: SchedulingInput, slots: SlotState[], lines: VoicePlanLine[]): void {
  const restored = new Set(input.restoredLines ?? []);
  for (const entry of input.judgment?.similar ?? []) {
    if (!Number.isSafeInteger(entry.lineIndex) || entry.lineIndex < 0 || entry.lineIndex >= lines.length) continue;
    if (restored.has(entry.lineIndex)) continue;
    const line = lines[entry.lineIndex];
    if (!line || line.fate) continue;
    const slot = slots.find(item => item.code === entry.logicalCode && item.canSpeak && item.anchor === null && item.role === null);
    if (!slot) continue;
    line.fate = { type: 'source', logicalCode: slot.code, basis: 'similar' };
    slot.anchor = line.index;
    slot.role = 'similar';
  }
}

function pickBestVoiceOver(candidates: readonly SlotState[], judgment: SchedulingJudgment | null): SlotState | null {
  if (!candidates.length) return null;
  const wanted = judgment?.bestVo ? candidates.find(slot => slot.code === judgment.bestVo) : null;
  return wanted ?? candidates[0];
}

/** 一段画面都没有、却有要读的行：中间段配补镜，最后一段放到片尾。 */
function place(items: DraftItem[], pendingLines: number[], isLastStretch: boolean, leftovers: number[]): void {
  const shots = items.filter((item): item is ShotItem => item.kind === 'shot');
  if (!shots.length) {
    if (isLastStretch) leftovers.push(...pendingLines);
    else if (pendingLines.length) items.push({ kind: 'insert', lines: pendingLines });
    return;
  }
  shots.forEach((shot, index) => {
    if (index < pendingLines.length) shot.lines.push(pendingLines[index]);
    else shot.dropped = true;
  });
  const extra = pendingLines.slice(shots.length);
  if (!extra.length) return;
  if (isLastStretch) leftovers.push(...extra);
  else shots[shots.length - 1].lines.push(...extra);
}

function usedAssetIds(items: DraftItem[]): Set<string> {
  const used = new Set<string>();
  for (const item of items) {
    if (item.kind === 'vo') used.add(item.file.assetId);
    if (item.kind === 'shot' && !item.dropped && item.file) used.add(item.file.assetId);
  }
  return used;
}

/** 相关排序：同一份成片里多行时，按行顺序合并去重。 */
export function relatedAssetIds(judgment: SchedulingJudgment | null, lineIndexes: readonly number[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const lineIndex of lineIndexes) {
    const entry = judgment?.related.find(item => item.lineIndex === lineIndex);
    for (const assetId of entry?.assetIds ?? []) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      result.push(assetId);
    }
  }
  return result;
}

function allNonVoFiles(materials: SchedulingSlotMaterial[]): SchedulingFile[] {
  return materials.filter(material => !material.isVo).flatMap(material => material.files);
}

function pickRelatedFile(assetIds: readonly string[], pool: readonly SchedulingFile[], used: Set<string>): SchedulingFile | null {
  const byAsset = new Map(pool.map(file => [file.assetId, file]));
  for (const assetId of assetIds) {
    const file = byAsset.get(assetId);
    if (file && !used.has(file.assetId)) return file;
  }
  // 都用过了，就从排序第一个起重复用。
  for (const assetId of assetIds) {
    const file = byAsset.get(assetId);
    if (file) return file;
  }
  // 没有相关排序时，先用本条没用过的非口播素材。
  return pool.find(file => !used.has(file.assetId)) ?? pool[0] ?? null;
}

function pickFromPools(materials: SchedulingSlotMaterial[], used: Set<string>): SchedulingFile | null {
  for (const pool of [materials.filter(material => material.wide), materials.filter(material => material.wideExperience)]) {
    const files = pool.flatMap(material => material.files);
    for (const file of files) if (!used.has(file.assetId)) return file;
  }
  return null;
}

function substituteMissingSlots(input: SchedulingInput, items: DraftItem[]): string[] {
  const warnings: string[] = [];
  const used = usedAssetIds(items);
  const pool = allNonVoFiles(input.materials);
  for (const item of items) {
    if (item.kind !== 'shot' || item.dropped || item.file || item.substitution) continue;
    const lineIndexes = item.lines;
    // 缺的口播镜头当一个普通镜头位置：先从全景展示挑，再从全景体验挑。
    if (isVoiceOver(item.code)) {
      const file = pickFromPools(input.materials, used);
      if (file) {
        item.substitution = { replacedCode: item.code, from: input.materials.some(material => material.wide
          && material.files.some(candidate => candidate.assetId === file.assetId)) ? 'wide' : 'wide-experience', file };
        used.add(file.assetId);
      } else warnings.push(`${item.code} 缺素材，也没有可用的全景镜头替代`);
      continue;
    }
    const related = relatedAssetIds(input.judgment, lineIndexes);
    const sameKind = input.materials.filter(material => !material.isVo && material.kind === slotKind(item.code))
      .flatMap(material => material.files);
    let file = pickRelatedFile(related, sameKind, used);
    if (file) {
      item.substitution = { replacedCode: item.code, from: 'same-kind', file };
    } else {
      const fallback = pickFromPools(input.materials, used);
      if (fallback) {
        item.substitution = { replacedCode: item.code, from: input.materials.some(material => material.wide
          && material.files.some(candidate => candidate.assetId === fallback.assetId)) ? 'wide' : 'wide-experience', file: fallback };
        file = fallback;
      }
    }
    if (!file) {
      file = pickRelatedFile([], pool, used);
      if (file) item.substitution = { replacedCode: item.code, from: 'other', file };
    }
    if (file) used.add(file.assetId);
    else warnings.push(`${item.code} 缺素材，也没有可用的替代镜头`);
  }
  return warnings;
}

function convertItems(items: DraftItem[]): VoicePlanItem[] {
  return items.map(item => {
    if (item.kind === 'shot') {
      const file = item.file ?? item.substitution?.file ?? null;
      if (!file) return { kind: 'insert' as const, lineIndexes: [...item.lines] };
      return { kind: 'shot' as const, slotIndex: item.slotIndex, logicalCode: item.code, file,
        lineIndexes: [...item.lines], dropped: item.dropped, substitution: item.substitution };
    }
    if (item.kind === 'vo') return { kind: 'vo' as const, slotIndex: item.slotIndex, logicalCode: item.code,
      file: item.file, role: item.role };
    return { kind: item.kind, lineIndexes: [...item.lines] };
  });
}

/**
 * 把一条脚本定声音。纯计算，不读写任何外部资源。
 * 同样的输入必须得到同样的结果。
 */
export function assignFormulaVoice(input: SchedulingInput): VoicePlan {
  const { script } = input;
  if (!Array.isArray(script.lines) || !Array.isArray(script.codes)) throw new Error('排片需要脚本的文案行和编号公式');
  if (input.voiceMode !== 'mixed' && input.voiceMode !== 'narration') throw new Error('声音方式只能是原声＋配音或统一配音');
  const slots = buildSlots(input);
  const lines: VoicePlanLine[] = script.lines.map((text, index) => ({ index, text, fate: null }));

  // 只有原声＋配音才放原片；统一配音里口播全部静音，锚行会让这一行既没原声也没配音。
  if (input.voiceMode === 'mixed') {
    anchorPlannedLines(slots, lines);
    anchorSimilarLines(input, slots, lines);
  }

  // 公式里的口播按文案用：用到的都放原片，其余不用；一段都没用上时 AI 挑一段。
  const talking = slots.filter(slot => slot.isVo && slot.file);
  // 原声＋配音要挑一段能放原片的；统一配音只当画面，有文件就行。
  const playable = input.voiceMode === 'narration' ? talking : talking.filter(slot => slot.canSpeak);
  let keep: SlotState[] = input.voiceMode === 'mixed' ? slots.filter(slot => slot.anchor !== null) : [];
  if (!keep.length && playable.length) {
    const best = pickBestVoiceOver(playable, input.judgment);
    if (best) {
      best.role = input.voiceMode === 'narration' ? 'muted' : 'picked';
      keep = [best];
    }
  }
  const keepIndexes = new Set(keep.map(slot => slot.index));
  for (const slot of talking) {
    if (keepIndexes.has(slot.index) || slot.role !== null) continue;
    slot.unused = true;
    slot.unusedReason = input.voiceMode === 'narration'
      ? '统一配音：口播画面只留一段'
      : '口播：文案里没写它的台词，和用到的口播是同一类，叠着放只会重复';
  }

  // 按公式顺序排：一行文案配一个非口播镜头。
  const items: DraftItem[] = [];
  const leftovers: number[] = [];
  let stretch: DraftItem[] = [];
  let pointer = 0;
  const pendingLines = (from: number, to: number) => lines
    .filter(line => line.index >= from && line.index < to && !line.fate).map(line => line.index);

  for (const slot of slots) {
    if (slot.unused) continue;
    const speaking = input.voiceMode === 'mixed' && slot.canSpeak;
    if (speaking) {
      if (slot.anchor !== null) {
        place(stretch, pendingLines(pointer, slot.anchor), false, leftovers);
        items.push(...stretch);
        stretch = [];
        // 口播在公式里的先后和文案行的先后不一定一致；指针只能往前走，不能把读过的行再排一遍。
        pointer = Math.max(pointer, slot.anchor + 1);
      }
      stretch.push({ kind: 'vo', slotIndex: slot.index, code: slot.code, file: slot.file!,
        role: slot.role === 'similar' ? 'similar' : slot.role === 'picked' ? 'picked' : 'anchor' });
    } else {
      stretch.push({ kind: 'shot', slotIndex: slot.index, code: slot.code, file: slot.file,
        substitution: slot.substitution, lines: [], dropped: false });
    }
  }
  place(stretch, pendingLines(pointer, lines.length), true, leftovers);
  items.push(...stretch);

  // 文案最后一行要配音、而它后面还有放原片的口播时，把它挪到片尾读。
  let movedLast = false;
  const last = lines[lines.length - 1];
  if (last && !last.fate) {
    const at = items.findIndex(item => (item.kind === 'shot' || item.kind === 'insert')
      && item.lines.includes(last.index));
    if (at >= 0 && items.slice(at + 1).some(item => item.kind === 'vo')) {
      const item = items[at];
      if (item.kind === 'shot' || item.kind === 'insert') {
        item.lines = item.lines.filter(index => index !== last.index);
        if (!item.lines.length) {
          if (item.kind === 'shot') item.dropped = true;
          else items.splice(at, 1);
        }
        leftovers.push(last.index);
        movedLast = true;
      }
    }
  }
  if (leftovers.length) items.push({ kind: 'ending', lines: leftovers });

  const warnings = substituteMissingSlots(input, items);

  const unusedSlots = slots.filter(slot => slot.unused).map(slot => ({ slotIndex: slot.index, logicalCode: slot.code, reason: slot.unusedReason! }));
  for (const item of items) {
    if (item.kind !== 'shot' || !item.dropped) continue;
    unusedSlots.push({ slotIndex: item.slotIndex, logicalCode: item.code,
      reason: item.file || item.substitution ? '文案已经读完，画面够了，这个镜头不用' : '缺素材，排到这里文案已经读完，不用补' });
  }

  const voUsage = slots.filter(slot => slot.role !== null).map(slot => ({
    slotIndex: slot.index, logicalCode: slot.code,
    role: slot.role!,
    coversLines: slot.anchor === null ? [] : [slot.anchor],
  }));
  // 被 AI 判断相近的口播可能顶多行（同一段口播对应几条同义文案）。
  for (const usage of voUsage) {
    if (usage.role !== 'similar') continue;
    usage.coversLines = lines.filter(line => line.fate?.type === 'source'
      && line.fate.logicalCode === usage.logicalCode && line.fate.basis === 'similar').map(line => line.index);
  }

  return {
    algorithmVersion: SCHEDULING_VERSION,
    mode: input.voiceMode,
    lines,
    items: convertItems(items),
    voUsage,
    unusedSlots,
    missingCodes: slots.filter(slot => !slot.material?.files.length).map(slot => slot.code),
    movedLast,
    warnings,
  };
}

/** 排时间需要、但定声音不用的配音时长；调用方在配音后传入。 */
export function linesToNarrate(plan: VoicePlan): number[] {
  return plan.lines.filter(line => !line.fate).map(line => line.index);
}

/** 配音时长是否齐全。 */
export function missingNarrationLines(plan: VoicePlan, narrations: readonly NarrationTake[]): number[] {
  const provided = new Set(narrations.map(take => take.lineIndex));
  return linesToNarrate(plan).filter(index => !provided.has(index));
}
