import { BatchDomainError } from '../errors.ts';
import { speechContent } from '../../media-core/adapters/alignment.ts';
import { planFormulaDuration, type FormulaDurationAudio, type FormulaDurationResult, type FormulaDurationSlot, type FormulaDurationTarget } from './duration.ts';
import type { FormulaAudioMapping } from './audio-mapping.ts';
import type { FormulaNarrationStageResult } from './narration-store.ts';
import type { FormulaAvailableRange } from './range-contract.ts';
import { selectFormulaTimelineRanges } from './timeline-ranges.ts';

export interface FormulaTimelineSlot {
  slotId: string; logicalCode: string; assetId: string; contentFingerprint: string; sourceId: string;
  mediaDurationUs: number; sourceFps: number; ranges: FormulaAvailableRange[];
}
export interface FormulaTimelineInput {
  slots: FormulaTimelineSlot[]; mapping: { stageId: string; result: FormulaAudioMapping };
  narration: { stageId: string; result: FormulaNarrationStageResult } | null;
  target: FormulaDurationTarget; speechMarginUs: number;
}
export interface FormulaTimelineAudio {
  id: string; kind: 'source' | 'narration'; slotIds: string[]; contentFingerprint: string;
  assetId?: string; sourceId?: string; narrationId?: string; narrationStageId?: string; relativePath?: string;
  sourceInUs: number; sourceOutUs: number; timelineStartUs: number; timelineEndUs: number;
  /** 原声始终随对应画面移动/裁切，不能独立拖走。 */
  linkGroupId?: string;
}
export type FormulaTimelineResult = Exclude<FormulaDurationResult, { status: 'planned' }> | {
  status: 'planned'; algorithmVersion: 'formula-timeline/1' | 'formula-timeline/2'; executionReady: false; reviewStatus: 'pending';
  mappingStageId: string; narrationStageId: string | null;
  duration: Extract<FormulaDurationResult, { status: 'planned' }>;
  audio: FormulaTimelineAudio[];
  words: Array<{ id: string; audioId: string; text: string; startUs: number; endUs: number }>;
  onScreen?: Array<{ blockId: string; slotId: string; text: string; displayText: string; startUs: number; endUs: number }>;
  issues: Array<{ code: string; slotIds: string[]; message: string }>;
};

function invalid(message: string): never { throw new BatchDomainError('invalid_input', message); }

/** 把已核验的原声/实际配音放到正文时间轴；封面偏移由预览和渲染统一加一次。 */
export function buildFormulaTimeline(input: FormulaTimelineInput): FormulaTimelineResult {
  const mapping = input.mapping.result;
  if (mapping.status === 'waiting_speech') return { status: 'waiting_audio', executionReady: false, pendingIds: mapping.slotIds };
  if (mapping.status === 'needs_attention') return { status: 'needs_attention', executionReady: false, conflicts: mapping.issues };
  if (!input.mapping.stageId || !Number.isSafeInteger(input.speechMarginUs) || input.speechMarginUs < 0) invalid('声音修订或原声边距无效');
  if (!Number.isSafeInteger(input.target.durationUs) || input.target.durationUs <= 0
    || !['reference', 'strict_max', 'fixed'].includes(input.target.mode) || !['body', 'total'].includes(input.target.scope)) invalid('目标时长或计时方式无效');
  if (mapping.narrations.length && !input.narration) return { status: 'waiting_audio', executionReady: false, pendingIds: mapping.narrations.map(item => item.id) };
  const voices = input.narration?.result.items ?? [];
  if (voices.length !== mapping.narrations.length || mapping.narrations.some(item => !voices.some(voice => voice.id === item.id
    && voice.text === item.text && JSON.stringify(voice.slotIds) === JSON.stringify(item.slotIds) && JSON.stringify(voice.blockIds) === JSON.stringify(item.blockIds)))) {
    invalid('实际配音与这份成片的文案映射不一致');
  }
  const candidates: FormulaDurationSlot[][] = input.slots.map(slot => {
    const ranges = slot.ranges.length ? slot.ranges.map(range => ({ ...range, confirmed: true }))
      : [{ id: `suggested:${slot.slotId}`, inUs: 0, outUs: slot.mediaDurationUs, protected: null, confirmed: false }];
    return ranges.map(range => ({ ...slot, preferredDurationUs: Math.max(1, Math.round(input.target.durationUs / Math.max(1, input.slots.length))), range }));
  });
  const durationAudio: Extract<FormulaDurationAudio, { status: 'ready' }> = { status: 'ready',
    revisionId: input.narration?.stageId ?? input.mapping.stageId,
    sources: mapping.sources.map(source => ({ slotId: source.slotId, assetId: source.assetId, contentFingerprint: source.contentFingerprint,
      speech: { inUs: source.speechInUs, outUs: source.speechOutUs }, marginUs: input.speechMarginUs })),
    narrations: voices.map(voice => ({ id: voice.id, slotIds: voice.slotIds, audioArtifactId: `${input.narration!.stageId}:${voice.id}`,
      contentFingerprint: voice.audio.fingerprint, mediaDurationUs: voice.audio.durationUs, sourceInUs: 0, sourceOutUs: voice.audio.durationUs })) };
  const chosen = selectFormulaTimelineRanges(candidates, input.target, durationAudio);
  if ('conflict' in chosen) return chosen.conflict;
  const duration = planFormulaDuration({ slots: chosen.slots, target: input.target, audio: durationAudio });
  if (duration.status !== 'planned') return duration;
  const onScreen: NonNullable<Extract<FormulaTimelineResult, { status: 'planned' }>['onScreen']> = [];
  for (const clip of duration.clips) {
    const displayed = mapping.blocks.filter(block => block.kind === 'on_screen' && block.slotId === clip.slotId);
    const frames = clip.timelineEndFrame - clip.timelineStartFrame;
    if (displayed.length * 12 > frames) return { status: 'needs_attention', executionReady: false,
      conflicts: [{ code: 'on_screen_too_short', slotIds: [clip.slotId], message: `镜头 ${clip.logicalCode} 放不下 ${displayed.length} 条花字，每条至少需要半秒；请减少文字或延长画面。` }] };
    for (const [index, block] of displayed.entries()) {
      if (!block.displayText) invalid('花字缺少已核对的显示文字');
      const time = (position: number) => Math.round((clip.timelineStartFrame + Math.floor(frames * position / displayed.length)) * 1_000_000 / duration.fps);
      onScreen.push({ blockId: block.id, slotId: clip.slotId, text: block.text, displayText: block.displayText,
        startUs: time(index), endUs: time(index + 1) });
    }
  }
  if (onScreen.length !== mapping.blocks.filter(block => block.kind === 'on_screen').length) invalid('花字镜头与实际排片不一致');
  const audio: FormulaTimelineAudio[] = [];
  const words: Extract<FormulaTimelineResult, { status: 'planned' }>['words'] = [];
  function addWords(track: FormulaTimelineAudio, text: string, timings: Array<{ text: string; startUs: number; endUs: number }>) {
    if (!timings.length || speechContent(timings.map(word => word.text).join('')) !== speechContent(text)) invalid('声音字幕内容不一致');
    let previous = track.sourceInUs;
    for (const [index, word] of timings.entries()) {
      if (!Number.isSafeInteger(word.startUs) || !Number.isSafeInteger(word.endUs) || word.startUs < previous
        || word.endUs <= word.startUs || word.endUs > track.sourceOutUs) invalid('声音字幕超出实际声音区间');
      words.push({ id: `${track.id}:word:${index}`, audioId: track.id, text: word.text,
        startUs: track.timelineStartUs + word.startUs - track.sourceInUs, endUs: track.timelineStartUs + word.endUs - track.sourceInUs });
      previous = word.endUs;
    }
  }
  for (const source of mapping.sources) {
    const clip = duration.clips.find(clip => clip.slotId === source.slotId)!;
    const slot = input.slots.find(slot => slot.slotId === source.slotId)!;
    if (slot.sourceId !== source.sourceId || slot.mediaDurationUs !== source.mediaDurationUs) invalid('原声来源或时长与所选画面不一致');
    const track: FormulaTimelineAudio = { id: `source:${source.slotId}`, kind: 'source', slotIds: [source.slotId],
      assetId: source.assetId, sourceId: source.sourceId, contentFingerprint: source.contentFingerprint, linkGroupId: source.slotId,
      sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs };
    audio.push(track); addWords(track, source.text, source.words);
  }
  for (const voice of voices) {
    const timed = duration.narrations.find(timed => timed.id === voice.id)!;
    const track: FormulaTimelineAudio = { id: `tts:${voice.id}`, kind: 'narration', slotIds: voice.slotIds,
      narrationId: voice.id, narrationStageId: input.narration!.stageId, relativePath: voice.audio.relativePath, contentFingerprint: voice.audio.fingerprint,
      sourceInUs: timed.sourceInUs, sourceOutUs: timed.sourceOutUs, timelineStartUs: timed.timelineStartUs, timelineEndUs: timed.timelineEndUs };
    audio.push(track); addWords(track, voice.text, voice.audio.words);
  }
  return { status: 'planned', algorithmVersion: 'formula-timeline/2', executionReady: false, reviewStatus: 'pending',
    mappingStageId: input.mapping.stageId, narrationStageId: input.narration?.stageId ?? null, duration,
    audio: audio.sort((a, b) => a.timelineStartUs - b.timelineStartUs), words: words.sort((a, b) => a.startUs - b.startUs), onScreen,
    issues: [...mapping.issues, ...duration.issues] };
}
