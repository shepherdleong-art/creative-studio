/**
 * 排时间：配音之后调用。用实际配音时长和有效片段，算出每个镜头取哪一截、
 * 哪里多用一点原片、哪里插补镜、结尾镜头和收尾，生成画面轨、声音轨、字幕和审片标记。
 *
 * 规矩 g 在这里；规矩 h 的检查见 validate.ts。
 */
import {
  type NarrationTake, type SchedulingFile, type SchedulingJudgment, type SchedulingMark, type SchedulingSlotMaterial,
  type SchedulingSpeech, type TimelineClip, type TimelinePlan, type TimelineSound, type TimelineWord, type VoicePlan,
  BORROW_MAX_US, MIN_FILLER_US, SCHEDULING_FPS, SCHEDULING_VERSION, SPEECH_MARGIN_US, TAIL_US,
} from './types.ts';
import { stripEmoji } from './text.ts';
import { relatedAssetIds } from './voice.ts';

const FRAME_US = 1_000_000 / SCHEDULING_FPS;
/** 0.75 秒收尾 = 18 帧。 */
const TAIL_FRAMES = Math.round(TAIL_US / FRAME_US);
/** 多用原片的上限 0.5 秒 = 12 帧。 */
const BORROW_MAX_FRAMES = Math.round(BORROW_MAX_US / FRAME_US);
/** 补镜最短 1 秒 = 24 帧。 */
const MIN_FILLER_FRAMES = Math.round(MIN_FILLER_US / FRAME_US);

export function microsecondsToFrames(us: number): number {
  return Math.max(0, Math.round(us / FRAME_US));
}
export function framesToMicroseconds(frames: number): number {
  return Math.round(frames * 1_000_000 / SCHEDULING_FPS);
}
/**
 * 取最近的帧边界；如果这个落点越过硬边界（素材长度、被剪掉的倒数和口令），
 * 就往里收一帧。单纯四舍五入会把出点顶到素材长度之外。
 */
function frameWithin(us: number, lowerUs: number, upperUs: number): number {
  let frame = Math.max(0, Math.round(us / FRAME_US));
  if (framesToMicroseconds(frame) < lowerUs) frame += 1;
  if (framesToMicroseconds(frame) > upperUs) frame -= 1;
  return Math.max(0, frame);
}

export interface SchedulingArrangeInput {
  plan: VoicePlan;
  materials: SchedulingSlotMaterial[];
  narrations: readonly NarrationTake[];
  judgment: SchedulingJudgment | null;
  /** 原脚本号和份次，用于结尾全景镜头的轮流；份次从 1 数。 */
  scriptNumber: string;
  copyIndex: number;
}

interface PictureRange { inFrame: number; outFrame: number }

function usableFrames(file: SchedulingFile): PictureRange {
  const upper = Math.min(file.usableOutUs, file.durationUs);
  const inFrame = frameWithin(file.usableInUs, 0, Number.POSITIVE_INFINITY);
  const outFrame = Math.max(inFrame + 1, frameWithin(upper, 0, upper));
  return { inFrame, outFrame };
}

/** 口播的有效片段：说话起止前后各留 0.12 秒，余量不能伸进被剪掉的倒数和口令。 */
export function voiceUsableRange(file: SchedulingFile): { inUs: number; outUs: number } {
  const speech: SchedulingSpeech | null = file.speech;
  if (!speech) return { inUs: 0, outUs: file.durationUs };
  const headLimit = speech.headCutEndUs ?? 0;
  const tailLimit = speech.tailCutStartUs ?? file.durationUs;
  const inUs = Math.max(0, headLimit, speech.startUs - SPEECH_MARGIN_US);
  const outUs = Math.min(file.durationUs, tailLimit, speech.endUs + SPEECH_MARGIN_US);
  if (outUs <= inUs) return { inUs: Math.max(0, speech.startUs), outUs: Math.min(file.durationUs, speech.endUs) };
  return { inUs, outUs };
}

export function voiceFrames(file: SchedulingFile): PictureRange {
  const range = voiceUsableRange(file);
  const speech = file.speech;
  const headLimit = speech?.headCutEndUs ?? 0;
  const tailLimit = Math.min(file.durationUs, speech?.tailCutStartUs ?? file.durationUs);
  const inFrame = frameWithin(range.inUs, headLimit, Number.POSITIVE_INFINITY);
  return { inFrame, outFrame: Math.max(inFrame + 1, frameWithin(range.outUs, 0, tailLimit)) };
}

function numericSeed(scriptNumber: string, copyIndex: number): number {
  const matched = /^\d+/.exec(String(scriptNumber).trim());
  return (matched ? Number(matched[0]) : 0) + Math.max(0, copyIndex - 1);
}

function rotate<T>(items: readonly T[], seed: number): T[] {
  if (!items.length) return [];
  const offset = ((seed % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function soundWords(sound: TimelineSound, speech: SchedulingSpeech, sourceUs: number, startUs: number): TimelineWord[] {
  return speech.words
    .filter(word => word.endUs > sourceUs && word.startUs < sourceUs + (sound.sourceOutUs - sound.sourceInUs))
    .map(word => ({
      soundId: sound.id,
      text: word.text,
      startUs: startUs + Math.max(0, word.startUs - sourceUs),
      endUs: startUs + Math.max(0, word.endUs - sourceUs),
    }));
}

/**
 * 把定声音的结果排成时间轴。配音时长必须齐全；缺了直接报错，由调用方把这条成片标成失败。
 */
export function arrangeFormulaTime(input: SchedulingArrangeInput): TimelinePlan {
  const { plan, materials, narrations, judgment } = input;
  const takes = new Map(narrations.map(take => [take.lineIndex, take]));
  const missing = plan.lines.filter(line => !line.fate && !takes.has(line.index));
  if (missing.length) throw new Error(`排时间缺少第 ${missing.map(line => line.index + 1).join('、')} 行的配音`);
  const badDuration = plan.lines.filter(line => !line.fate && !(takes.get(line.index)!.durationUs > 0));
  if (badDuration.length) throw new Error(`第 ${badDuration.map(line => line.index + 1).join('、')} 行的配音时长无效`);

  const clips: TimelineClip[] = [];
  const sounds: TimelineSound[] = [];
  const words: TimelineWord[] = [];
  const marks: SchedulingMark[] = [];
  const warnings: string[] = [];
  const unused: Array<{ logicalCode: string; reason: string }> = plan.unusedSlots.map(slot => ({ logicalCode: slot.logicalCode, reason: slot.reason }));
  const seed = numericSeed(input.scriptNumber, input.copyIndex);
  const nonVoPool = materials.filter(material => !material.isVo).flatMap(material => material.files)
    .filter(file => microsecondsToFrames(file.usableOutUs) > microsecondsToFrames(file.usableInUs));
  const filesByAsset = new Map(materials.flatMap(material => material.files).map(file => [file.assetId, file]));
  const widePool = rotate(materials.filter(material => material.wide).flatMap(material => material.files), seed);
  const wideExperiencePool = rotate(materials.filter(material => material.wideExperience).flatMap(material => material.files), seed);
  const used = new Set<string>();
  for (const item of plan.items) {
    if (item.kind === 'shot' && !item.dropped) used.add(item.file.assetId);
    if (item.kind === 'vo') used.add(item.file.assetId);
  }

  // 公式里没用上的非口播镜头（从公式靠后的开始）拿来做结尾镜头。
  const spare = plan.items
    .filter((item): item is Extract<typeof item, { kind: 'shot' }> => item.kind === 'shot' && item.dropped)
    .map(item => item.file).reverse();

  let cursor = 0;
  /** 配音占几帧：向上取整，保证画面窗口不短于声音本身。 */
  const narrationFrames = (durationUs: number): number => Math.max(1, Math.ceil(durationUs / FRAME_US - 1e-6));
  const lineDurationFrames = (lineIndexes: readonly number[]) => lineIndexes
    .reduce((total, index) => total + narrationFrames(takes.get(index)!.durationUs), 0);

  function pushedClip(clip: Omit<TimelineClip, 'timelineStartFrame' | 'timelineEndFrame' | 'timelineStartUs' | 'timelineEndUs'>, lengthFrames: number): void {
    const start = cursor;
    clips.push({ ...clip, timelineStartFrame: start, timelineEndFrame: start + lengthFrames,
      timelineStartUs: framesToMicroseconds(start), timelineEndUs: framesToMicroseconds(start + lengthFrames) });
    cursor += lengthFrames;
  }

  function speakLines(lineIndexes: readonly number[], startFrame: number): number {
    let position = startFrame;
    for (const lineIndex of lineIndexes) {
      const take = takes.get(lineIndex)!;
      const length = narrationFrames(take.durationUs);
      const text = stripEmoji(take.text || plan.lines[lineIndex].text);
      // 配音的长短是音频文件自己的真实毫秒数，画面才按整帧走。声音终点跟着真实长度写，
      // 否则取整差半帧（最多 20 毫秒）会让成片校验以为「原片长度和时间线长度对不上」，
      // 而渲染本来也是按真实长度削音频、按起点延时的。
      const timelineStartUs = framesToMicroseconds(position);
      const sound: TimelineSound = {
        id: `narration:${lineIndex}`, kind: 'narration', slotIndex: null, lineIndexes: [lineIndex],
        logicalCode: null, assetId: null,
        contentFingerprint: take.contentFingerprint ?? `${take.durationUs}:${text}`,
        fileName: null, text,
        timelineStartFrame: position, timelineEndFrame: position + length,
        timelineStartUs, timelineEndUs: timelineStartUs + take.durationUs,
        sourceInUs: 0, sourceOutUs: take.durationUs, relativePath: take.relativePath ?? null,
      };
      sounds.push(sound);
      for (const word of take.words) {
        words.push({ soundId: sound.id, text: word.text,
          startUs: sound.timelineStartUs + Math.max(0, word.startUs),
          endUs: sound.timelineStartUs + Math.max(0, word.endUs) });
      }
      position += length;
    }
    return position;
  }

  function pushSourceItem(item: Extract<VoicePlan['items'][number], { kind: 'vo' }>): void {
    const file = item.file;
    const range = voiceFrames(file);
    const length = Math.max(1, range.outFrame - range.inFrame);
    const start = cursor;
    const covers = plan.voUsage.find(usage => usage.slotIndex === item.slotIndex)?.coversLines ?? [];
    pushedClip({ id: `clip:${clips.length}`, kind: 'vo', logicalCode: item.logicalCode, assetId: file.assetId,
      contentFingerprint: file.contentFingerprint, fileName: file.fileName,
      sourceInUs: framesToMicroseconds(range.inFrame), sourceOutUs: framesToMicroseconds(range.outFrame),
      lineIndexes: [...covers], slotIndex: item.slotIndex }, length);
    const speech = file.speech!;
    const sound: TimelineSound = {
      id: `source:${item.slotIndex}`, kind: 'source', slotIndex: item.slotIndex, lineIndexes: [...covers],
      logicalCode: item.logicalCode, assetId: file.assetId, contentFingerprint: file.contentFingerprint,
      fileName: file.fileName, text: stripEmoji(speech.text),
      timelineStartFrame: start, timelineEndFrame: start + length,
      timelineStartUs: framesToMicroseconds(start), timelineEndUs: framesToMicroseconds(start + length),
      sourceInUs: framesToMicroseconds(range.inFrame), sourceOutUs: framesToMicroseconds(range.outFrame),
    };
    sounds.push(sound);
    words.push(...soundWords(sound, speech, sound.sourceInUs, sound.timelineStartUs));
  }

  function chooserFor(lineIndexes: readonly number[]): () => SchedulingFile | null {
    const ranking = relatedAssetIds(judgment, lineIndexes);
    const byAsset = new Map(nonVoPool.map(file => [file.assetId, file]));
    return () => {
      for (const assetId of ranking) {
        const file = byAsset.get(assetId);
        if (file && !used.has(file.assetId)) return file;
      }
      for (const assetId of ranking) {
        const file = byAsset.get(assetId);
        if (file) return file;
      }
      return nonVoPool.find(file => !used.has(file.assetId)) ?? nonVoPool[0] ?? null;
    };
  }

  function endingChooser(): () => SchedulingFile | null {
    // 片尾按确认单：公式里没用上的镜头 → 全景展示 → 全景体验，都用过了就重复用。
    // 这三类一段都没有时才退回其余非口播素材，保证片尾仍有画面。
    const preferred = [...spare, ...widePool, ...wideExperiencePool];
    const queue = preferred.length ? preferred : nonVoPool;
    let index = 0;
    return () => {
      for (let step = 0; step < queue.length; step += 1) {
        const file = queue[(index + step) % queue.length];
        if (!used.has(file.assetId)) { index = (index + step + 1) % queue.length; return file; }
      }
      const repeat = queue[index % queue.length] ?? null;
      index = (index + 1) % Math.max(1, queue.length);
      return repeat;
    };
  }

  /** 补画面：只补「声音比画面长的这一段」，不重复算整句。 */
  function fill(frames: number, lineIndexes: readonly number[], cause: 'overflow' | 'gap' | 'ending', choose: () => SchedulingFile | null): void {
    let remain = frames;
    let guard = 0;
    while (remain > 0 && guard < 10_000) {
      guard += 1;
      const file = choose();
      if (!file) break;
      const range = usableFrames(file);
      const capacity = range.outFrame - range.inFrame;
      if (capacity < 1) continue;
      const length = Math.min(Math.max(remain, MIN_FILLER_FRAMES), capacity);
      used.add(file.assetId);
      pushedClip({ id: `clip:${clips.length}`, kind: 'filler', logicalCode: file.logicalCode ?? file.fileName, assetId: file.assetId,
        contentFingerprint: file.contentFingerprint, fileName: file.fileName,
        sourceInUs: framesToMicroseconds(range.inFrame), sourceOutUs: framesToMicroseconds(range.inFrame + length),
        lineIndexes: [...lineIndexes], fillerCause: cause }, length);
      marks.push({ type: 'filler', cause, lineIndexes: [...lineIndexes] });
      remain -= length;
    }
    if (remain > 0) warnings.push('补镜不够长，这一句声音后面可能没有画面');
  }

  for (const item of plan.items) {
    if (item.kind === 'shot') {
      if (item.dropped) continue;
      const file = item.file;
      const range = usableFrames(file);
      const need = lineDurationFrames(item.lineIndexes);
      let length = Math.min(need, range.outFrame - range.inFrame);
      const short = need - length;
      const spareTail = microsecondsToFrames(file.durationUs) - (range.inFrame + length);
      if (short > 0 && short <= BORROW_MAX_FRAMES && spareTail >= short) {
        length = need;
        warnings.push(`${item.logicalCode} 的配音只比有效片段长 ${(short / SCHEDULING_FPS).toFixed(1)} 秒：这个镜头多用一点原片，不插补镜`);
      }
      const clipStart = cursor;
      pushedClip({ id: `clip:${clips.length}`, kind: item.substitution ? 'substitute' : 'shot', logicalCode: item.logicalCode,
        assetId: file.assetId, contentFingerprint: file.contentFingerprint, fileName: file.fileName,
        sourceInUs: framesToMicroseconds(range.inFrame), sourceOutUs: framesToMicroseconds(range.inFrame + length),
        lineIndexes: [...item.lineIndexes], substitution: item.substitution }, length);
      if (item.substitution) {
        marks.push({ type: 'substitute', replacedCode: item.substitution.replacedCode,
          from: item.substitution.from, assetId: item.substitution.file.assetId });
      }
      const soundEnd = speakLines(item.lineIndexes, clipStart);
      if (need - length > 0) fill(need - length, item.lineIndexes, 'overflow', chooserFor(item.lineIndexes));
      cursor = Math.max(cursor, soundEnd);
    } else if (item.kind === 'vo') {
      pushSourceItem(item);
    } else if (item.kind === 'insert') {
      const soundEnd = speakLines(item.lineIndexes, cursor);
      fill(lineDurationFrames(item.lineIndexes), item.lineIndexes, 'gap', chooserFor(item.lineIndexes));
      cursor = Math.max(cursor, soundEnd);
    } else {
      const soundEnd = speakLines(item.lineIndexes, cursor);
      fill(lineDurationFrames(item.lineIndexes), item.lineIndexes, 'ending', endingChooser());
      cursor = Math.max(cursor, soundEnd);
    }
  }

  if (clips.length) {
    // 收尾：最后一句声音之后画面再留 0.75 秒。这 0.75 秒必须是真实画面——
    // 先把最后一段的原片往后多放，原片没有余量时才接一段短结尾画面。
    // 只把时间线拉长、不补素材，渲染时整段画面会被放慢，违反「不变速」。
    let remain = TAIL_FRAMES;
    const last = clips[clips.length - 1];
    const lastFile = filesByAsset.get(last.assetId);
    if (lastFile) {
      // 口播镜头最多放到被剪掉的倒数和口令之前；其余素材和「多用原片」一样只认文件长度。
      const limitUs = last.kind === 'vo'
        ? Math.min(lastFile.durationUs, lastFile.speech?.tailCutStartUs ?? lastFile.durationUs)
        : lastFile.durationUs;
      const available = microsecondsToFrames(limitUs) - microsecondsToFrames(last.sourceOutUs);
      const take = Math.max(0, Math.min(remain, available));
      if (take > 0) {
        last.sourceOutUs = framesToMicroseconds(microsecondsToFrames(last.sourceOutUs) + take);
        last.timelineEndFrame += take;
        last.timelineEndUs = framesToMicroseconds(last.timelineEndFrame);
        remain -= take;
      }
    }
    cursor = last.timelineEndFrame;
    if (remain > 0) {
      // 原片后面没有余量了：接一段短结尾画面。收尾是规矩本身，不算 AI 改动，不打审片标记。
      const choose = endingChooser();
      let guard = 0;
      while (remain > 0 && guard < 1_000) {
        guard += 1;
        const file = choose();
        if (!file) break;
        const range = usableFrames(file);
        const capacity = range.outFrame - range.inFrame;
        if (capacity < 1) continue;
        const length = Math.min(remain, capacity);
        used.add(file.assetId);
        pushedClip({ id: `clip:${clips.length}`, kind: 'filler', logicalCode: file.logicalCode ?? file.fileName,
          assetId: file.assetId, contentFingerprint: file.contentFingerprint, fileName: file.fileName,
          sourceInUs: framesToMicroseconds(range.inFrame), sourceOutUs: framesToMicroseconds(range.inFrame + length),
          lineIndexes: [], fillerCause: 'ending' }, length);
        remain -= length;
      }
      if (remain > 0) warnings.push('片尾找不到多余画面，收尾少放了一点');
    }
    cursor = clips[clips.length - 1].timelineEndFrame;
  }

  for (const line of plan.lines) {
    if (line.fate?.type === 'source') {
      marks.push({ type: 'skipped-line', lineIndex: line.index, logicalCode: line.fate.logicalCode, basis: line.fate.basis });
    }
  }
  if (plan.movedLast) marks.push({ type: 'last-line-moved' });
  for (const usage of plan.voUsage) {
    if (usage.role === 'muted') marks.push({ type: 'muted-vo', logicalCode: usage.logicalCode });
  }
  for (const slot of plan.unusedSlots) {
    marks.push({ type: slot.logicalCode.startsWith('VO') ? 'unused-vo' : 'unused-shot',
      logicalCode: slot.logicalCode, reason: slot.reason });
  }

  const speechEndFrame = sounds.reduce((max, sound) => Math.max(max, sound.timelineEndFrame), 0);
  return {
    algorithmVersion: SCHEDULING_VERSION,
    mode: plan.mode,
    fps: SCHEDULING_FPS,
    clips, sounds, words, marks, unused,
    totalFrames: cursor,
    totalDurationUs: framesToMicroseconds(cursor),
    speechEndUs: framesToMicroseconds(speechEndFrame),
    warnings: [...plan.warnings, ...warnings],
  };
}
