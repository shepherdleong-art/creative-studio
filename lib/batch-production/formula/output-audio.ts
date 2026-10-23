import { BatchDomainError } from '../errors.ts';
import { audioClips, editAudioClip, moveAudioClip, trimAudioClip } from '../../media-core/audio-edit.ts';
import type { BatchOutputClipEdit } from '../output-arrangement.ts';
import { groupFormulaSubtitleWords } from './subtitle-cues.ts';

export interface FormulaOutputAudioClip {
  id: string; mediaId: string; kind: 'source' | 'narration'; linkedVideoClipId?: string;
  sourceInUs: number; sourceOutUs: number; timelineStartUs: number; timelineEndUs: number; gainDb: number;
}
export interface FormulaOutputAudioPlan {
  version: 1; revision: number; bodyDurationUs: number; clips: FormulaOutputAudioClip[]; issues: FormulaOutputAudioIssue[];
}
export interface FormulaOutputAudioIssue {
  code: 'speech_incomplete' | 'speech_discontinuous' | 'source_range_unverified'; mediaId: string; message: string;
}
export interface FormulaOutputAudioSource {
  mediaId: string; kind: 'source' | 'narration'; slotId?: string; assetId?: string;
  manualMediaId?: string;
  timingSource?: 'manual'; externalNarrationId?: string;
  requiredRanges?: Array<{ inUs: number; outUs: number }>;
  contentFingerprint: string; sourceDurationUs: number; verifiedInUs: number; verifiedOutUs: number;
  words: Array<{ id: string; text: string; sourceInUs: number; sourceOutUs: number }>;
}
export interface FormulaOutputBasis {
  version: 1; selectionStageId: string; timelineStageId: string; audioSources: FormulaOutputAudioSource[];
  videoSources?: Array<{ mediaId: string; assetId: string; contentFingerprint: string }>;
  replacedNarration?: Array<{ clipId: string; mediaId: string; inUs: number; outUs: number }>;
}

function fail(message: string): never { throw new BatchDomainError('conflict', message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('公式声音计划格式无效');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('公式声音时间或修订无效');
  return Number(value);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('公式声音来源身份无效');
  return value;
}
function kind(value: unknown): 'source' | 'narration' {
  if (value !== 'source' && value !== 'narration') fail('不支持这类公式声音');
  return value;
}

/** 来源依据由服务端从不可变排片建立，不接受撤销请求更改来源身份。 */
export function readFormulaOutputBasis(value: unknown): FormulaOutputBasis | undefined {
  if (value === undefined) return undefined;
  const basis = record(value);
  if (basis.version !== 1 || !Array.isArray(basis.audioSources) || basis.audioSources.length > 1_000) fail('不支持这版公式声音依据');
  const seen = new Set<string>();
  const audioSources = basis.audioSources.map(entry => {
    const item = record(entry);
    const mediaId = text(item.mediaId);
    if (seen.has(mediaId)) fail('公式声音来源重复');
    seen.add(mediaId);
    const type = kind(item.kind);
    const sourceDurationUs = integer(item.sourceDurationUs);
    const verifiedInUs = integer(item.verifiedInUs), verifiedOutUs = integer(item.verifiedOutUs);
    if (verifiedInUs >= verifiedOutUs || verifiedOutUs > sourceDurationUs || !Array.isArray(item.words)) fail('公式声音核验区间无效');
    let previous = verifiedInUs;
    const words = item.words.map(entry => {
      const word = record(entry);
      const sourceInUs = integer(word.sourceInUs), sourceOutUs = integer(word.sourceOutUs);
      if (sourceInUs < previous || sourceOutUs <= sourceInUs || sourceOutUs > verifiedOutUs) fail('公式声音字幕区间无效');
      previous = sourceOutUs;
      return { id: text(word.id), text: text(word.text), sourceInUs, sourceOutUs };
    });
    return { mediaId, kind: type, contentFingerprint: text(item.contentFingerprint), sourceDurationUs, verifiedInUs, verifiedOutUs, words,
      ...(type === 'source' ? { slotId: text(item.slotId), assetId: text(item.assetId) } : {}),
      ...(item.timingSource === 'manual' ? { timingSource: 'manual' as const } : {}),
      ...(item.externalNarrationId ? { externalNarrationId: text(item.externalNarrationId) } : {}) };
  });
  const videoSources = Array.isArray(basis.videoSources) ? basis.videoSources.map(entry => {
    const video = record(entry);
    return { mediaId: text(video.mediaId), assetId: text(video.assetId), contentFingerprint: text(video.contentFingerprint) };
  }) : undefined;
  return { version: 1, selectionStageId: text(basis.selectionStageId), timelineStageId: text(basis.timelineStageId), audioSources, videoSources };
}

export function readFormulaOutputAudioPlan(value: unknown): FormulaOutputAudioPlan | undefined {
  if (value === undefined) return undefined;
  const plan = record(value);
  if (plan.version !== 1 || !Array.isArray(plan.clips) || plan.clips.length > 1_000) fail('不支持这版公式声音计划');
  const bodyDurationUs = integer(plan.bodyDurationUs);
  const seen = new Set<string>();
  const clips = plan.clips.map(entry => {
    const clip = record(entry);
    const id = text(clip.id), type = kind(clip.kind);
    if (seen.has(id)) fail('公式声音片段重复');
    seen.add(id);
    const sourceInUs = integer(clip.sourceInUs), sourceOutUs = integer(clip.sourceOutUs);
    const timelineStartUs = integer(clip.timelineStartUs), timelineEndUs = integer(clip.timelineEndUs);
    if (sourceOutUs <= sourceInUs || timelineEndUs <= timelineStartUs || timelineEndUs > bodyDurationUs
      || Math.abs(sourceOutUs - sourceInUs - (timelineEndUs - timelineStartUs)) > 1) fail('公式声音区间无效');
    if (typeof clip.gainDb !== 'number' || !Number.isFinite(clip.gainDb) || clip.gainDb < -60 || clip.gainDb > 24) fail('公式声音音量无效');
    return { id, mediaId: text(clip.mediaId), kind: type, sourceInUs, sourceOutUs, timelineStartUs, timelineEndUs, gainDb: clip.gainDb,
      ...(type === 'source' ? { linkedVideoClipId: text(clip.linkedVideoClipId) } : {}) };
  }).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  for (let i = 1; i < clips.length; i++) if (clips[i].timelineStartUs < clips[i - 1].timelineEndUs) fail('原声与配音发生重叠，请先调整声音或画面位置');
  const issues: FormulaOutputAudioIssue[] = (Array.isArray(plan.issues) ? plan.issues : []).map(entry => {
    const issue = record(entry);
    if (issue.code !== 'speech_incomplete' && issue.code !== 'speech_discontinuous' && issue.code !== 'source_range_unverified') fail('声音问题类型无效');
    return { code: issue.code, mediaId: text(issue.mediaId), message: text(issue.message) };
  });
  return { version: 1, revision: integer(plan.revision), bodyDurationUs, clips, issues };
}

interface TimedPiece { sourceSegmentId: string; mediaId: string; sourceInUs: number; sourceOutUs: number; startUs: number; endUs: number }
function piecesFor(clips: FormulaOutputAudioClip[], mediaId: string, sourceInUs: number, sourceOutUs: number): TimedPiece[] {
  return clips.filter(clip => clip.mediaId === mediaId).flatMap(clip => {
    const start = Math.max(sourceInUs, clip.sourceInUs), end = Math.min(sourceOutUs, clip.sourceOutUs);
    return end > start ? [{ sourceSegmentId: clip.id, mediaId, sourceInUs: start, sourceOutUs: end,
      startUs: clip.timelineStartUs + start - clip.sourceInUs, endUs: clip.timelineStartUs + end - clip.sourceInUs }] : [];
  });
}
function mergePieces(pieces: TimedPiece[]): TimedPiece[] {
  const merged: TimedPiece[] = [];
  for (const piece of pieces.sort((a, b) => a.startUs - b.startUs)) {
    const previous = merged.at(-1);
    if (previous && previous.mediaId === piece.mediaId && previous.sourceOutUs === piece.sourceInUs && Math.abs(previous.endUs - piece.startUs) <= 1) {
      previous.sourceOutUs = piece.sourceOutUs; previous.endUs = piece.endUs;
    } else merged.push({ ...piece });
  }
  return merged;
}

function remapManualCues(value: unknown, before: FormulaOutputAudioPlan, after: FormulaOutputAudioPlan) {
  if (!Array.isArray(value)) fail('公式成片缺少人工字幕');
  const ids = new Set<string>();
  return value.flatMap(entry => {
    const cue = record(entry);
    const cueId = text(cue.id), startUs = integer(cue.startUs), endUs = integer(cue.endUs);
    const affected = before.clips.filter(clip => startUs < clip.timelineEndUs && endUs > clip.timelineStartUs);
    if (!affected.length) return [cue];
    const pieces = mergePieces(affected.flatMap(clip => piecesFor(after.clips, clip.mediaId,
      clip.sourceInUs + Math.max(0, startUs - clip.timelineStartUs),
      clip.sourceInUs + Math.min(clip.sourceOutUs - clip.sourceInUs, endUs - clip.timelineStartUs))));
    return pieces.map((piece, i) => {
      let id = i ? `${cueId}:part:${i}` : cueId;
      while (ids.has(id)) id += ':part';
      ids.add(id);
      return { ...cue, id, sourceSegmentId: piece.sourceSegmentId, startUs: piece.startUs, endUs: piece.endUs };
    });
  }).sort((a, b) => Number(a.startUs) - Number(b.startUs));
}

/** 在原成片编辑事务内重建联动画面原声；配音保留独立位置。 */
export function reconcileFormulaOutputAudio(arrangement: Record<string, unknown>, clips: Array<Record<string, unknown>>,
  restore?: { audioPlan: unknown }, before?: FormulaOutputAudioPlan, effectiveBasis?: FormulaOutputBasis): boolean {
  const basis = effectiveBasis ?? readFormulaOutputBasis(arrangement.formula);
  if (!basis) return false;
  const current = before ?? readFormulaOutputAudioPlan(arrangement.audioPlan);
  if (!current) fail('公式成片缺少声音计划');
  const input = readFormulaOutputAudioPlan(restore ? restore.audioPlan : arrangement.audioPlan);
  if (!input) fail('撤销快照缺少公式声音计划，请刷新后重试');
  for (const sound of input.clips) {
    if (!restore && sound.kind === 'source') continue; // Rebuilt below from verified video sources.
    const source = basis.audioSources.find(source => source.mediaId === sound.mediaId);
    if (!source || source.kind !== sound.kind || sound.sourceOutUs > source.sourceDurationUs) fail('声音片段与保存的来源不一致');
    if (restore && sound.kind === 'source') {
      const video = clips.find(clip => clip.clipId === sound.linkedVideoClipId);
      if (!video || (source.manualMediaId ? video.formulaSourceId !== source.manualMediaId : video.segmentId !== source.slotId)
        || video.assetId !== source.assetId || video.contentFingerprint !== source.contentFingerprint
        || video.sourceStartUs !== sound.sourceInUs || video.sourceEndUs !== sound.sourceOutUs
        || video.timelineStartUs !== sound.timelineStartUs || video.timelineEndUs !== sound.timelineEndUs) fail('撤销快照的原声与画面不一致');
    }
  }
  const sounds: FormulaOutputAudioClip[] = input.clips.filter(clip => {
    if (clip.kind !== 'narration') return false;
    const replaced = basis.replacedNarration?.some(range => range.clipId === clip.id && range.mediaId === clip.mediaId
      && range.inUs === clip.sourceInUs && range.outUs === clip.sourceOutUs);
    if (replaced && restore) fail('撤销快照同时保留了已被新原声替代的配音');
    return !replaced;
  });
  for (const clip of clips) {
    const source = basis.audioSources.find(source => source.kind === 'source' && (clip.formulaSourceId
      ? source.manualMediaId === clip.formulaSourceId : !source.manualMediaId && source.slotId === clip.segmentId));
    if (!source) continue;
    if (clip.assetId !== source.assetId || clip.contentFingerprint !== source.contentFingerprint) fail('换片后必须重新核验原声，不能沿用原素材声音');
    if (clip.playbackRate !== undefined && clip.playbackRate !== 1) fail('保留原声的画面暂不支持变速');
    if (Number(clip.sourceEndUs) > source.sourceDurationUs) fail('原声区间超出原片');
    const previous = input.clips.find(sound => sound.linkedVideoClipId === clip.clipId);
    if (restore && !previous) fail('撤销快照缺少与画面关联的原声');
    sounds.push({ id: previous?.id ?? `source:${text(clip.clipId)}`, kind: 'source', mediaId: source.mediaId,
      linkedVideoClipId: text(clip.clipId), sourceInUs: integer(clip.sourceStartUs), sourceOutUs: integer(clip.sourceEndUs),
      timelineStartUs: integer(clip.timelineStartUs), timelineEndUs: integer(clip.timelineEndUs), gainDb: previous?.gainDb ?? 0 });
  }
  const bodyDurationUs = Math.max(0, ...clips.map(clip => Number(clip.timelineEndUs)), ...sounds.map(sound => sound.timelineEndUs));
  const next = readFormulaOutputAudioPlan({ ...current, bodyDurationUs, clips: sounds })!;
  const audioChanged = JSON.stringify(next.clips) !== JSON.stringify(current.clips);
  const issues: FormulaOutputAudioIssue[] = [];
  const addIssue = (code: FormulaOutputAudioIssue['code'], source: FormulaOutputAudioSource, message: string) => {
    if (!issues.some(issue => issue.code === code && issue.mediaId === source.mediaId)) issues.push({ code, mediaId: source.mediaId, message });
  };
  for (const source of basis.audioSources) {
    const first = source.words[0], last = source.words.at(-1);
    const required = source.requiredRanges ?? (first && last ? [{ inUs: first.sourceInUs, outUs: last.sourceOutUs }] : []);
    for (const range of required) {
      const speech = mergePieces(piecesFor(next.clips, source.mediaId, range.inUs, range.outUs));
      if (speech.length > 1) addIssue('speech_discontinuous', source, '一句话被拆到不同位置，请恢复连续声音后再确认');
      if (speech.reduce((sum, piece) => sum + piece.sourceOutUs - piece.sourceInUs, 0) < range.outUs - range.inUs) {
        addIssue('speech_incomplete', source, '编辑截断或删除了需要保留的话语，请恢复完整声音后再确认');
      }
    }
  }
  const cues = basis.audioSources.flatMap(source => (source.manualMediaId || source.timingSource === 'manual'
    ? source.words : groupFormulaSubtitleWords(source.words)).flatMap(word => {
    const merged = mergePieces(piecesFor(next.clips, source.mediaId, word.sourceInUs, word.sourceOutUs));
    if (merged.reduce((sum, piece) => sum + piece.sourceOutUs - piece.sourceInUs, 0) < word.sourceOutUs - word.sourceInUs) {
      addIssue('speech_incomplete', source, '编辑截断或删除了需要保留的话语，请恢复完整声音后再确认');
    } else if (merged.length > 1) addIssue('speech_discontinuous', source, '一句话被拆到不同位置，请恢复连续声音后再确认');
    return merged.map((piece, i) => ({ id: i ? `${word.id}:part:${i}` : word.id, sourceSegmentId: piece.sourceSegmentId,
      text: word.text, startUs: piece.startUs, endUs: piece.endUs, timingSource: source.manualMediaId || source.timingSource === 'manual' ? 'manual' : 'aligned' }));
  })).sort((a, b) => a.startUs - b.startUs);
  for (const sound of next.clips) {
    const source = basis.audioSources.find(source => source.mediaId === sound.mediaId);
    if (!source || source.kind !== sound.kind || sound.sourceOutUs > source.sourceDurationUs) fail('声音片段与保存的来源不一致');
    if (sound.sourceInUs < source.verifiedInUs || sound.sourceOutUs > source.verifiedOutUs) addIssue('source_range_unverified', source, '扩展后的原声区间尚未核验');
  }
  next.issues = issues;
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) next.revision++;
  arrangement.audioPlan = next;
  const subtitle = (arrangement.subtitle as Record<string, unknown> | undefined) ?? {};
  if (subtitle.source !== 'manual' && subtitle.mode !== 'manual') arrangement.subtitle = { ...subtitle, cues };
  else if (audioChanged && !restore) {
    const newSourceIds = new Set(next.clips.filter(clip => clip.kind === 'source' && !current.clips.some(old => old.mediaId === clip.mediaId)).map(clip => clip.id));
    arrangement.subtitle = { ...subtitle, cues: [...remapManualCues(subtitle.cues, current, next),
      ...cues.filter(cue => newSourceIds.has(cue.sourceSegmentId))].sort((a, b) => Number(a.startUs) - Number(b.startUs)) };
  }
  return changed;
}

/** 复用共享音频编辑规则；每个 TTS 块保留自己的真实来源，原声只能随画面编辑。 */
export function editFormulaOutputNarration(arrangement: Record<string, unknown>, edit: Extract<BatchOutputClipEdit,
  { type: 'split_audio_clip' | 'delete_audio_clip' | 'trim_audio_clip' | 'move_audio_clip' }>): boolean {
  const plan = readFormulaOutputAudioPlan(arrangement.audioPlan), basis = readFormulaOutputBasis(arrangement.formula);
  if (!plan || !basis) fail('公式成片缺少声音计划');
  const target = plan.clips.find(clip => clip.id === edit.clipId);
  if (!target) fail('配音片段不存在');
  if (target.kind !== 'narration') fail('原声与画面关联，请在视频轨道编辑');
  const source = basis.audioSources.find(source => source.mediaId === target.mediaId);
  if (!source || source.kind !== 'narration') fail('配音来源不存在');
  const state = { audio: { narration: [{ id: target.id, sourceStartUs: target.sourceInUs, sourceEndUs: target.sourceOutUs,
    timelineStartUs: target.timelineStartUs, timelineEndUs: target.timelineEndUs }] } };
  try {
    if (edit.type === 'split_audio_clip') editAudioClip(state, 'narration', plan.bodyDurationUs, target.id, edit.atUs);
    else if (edit.type === 'delete_audio_clip') editAudioClip(state, 'narration', plan.bodyDurationUs, target.id);
    else if (edit.type === 'move_audio_clip') moveAudioClip(state, 'narration', plan.bodyDurationUs, target.id, edit.timelineStartUs);
    else trimAudioClip(state, 'narration', plan.bodyDurationUs, target.id, { ...edit, sourceDurationUs: source.sourceDurationUs, minDurationUs: 500_000 });
  } catch (error) { throw new BatchDomainError('invalid_input', error instanceof Error ? error.message : '配音编辑失败'); }
  const updated = audioClips(state, 'narration', plan.bodyDurationUs).map(clip => ({ ...target, id: clip.id,
    sourceInUs: clip.sourceStartUs, sourceOutUs: clip.sourceEndUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs }));
  const clips = [...plan.clips.filter(clip => clip.id !== target.id), ...updated];
  const next = readFormulaOutputAudioPlan({ ...plan, clips,
    bodyDurationUs: Math.max(plan.bodyDurationUs, ...clips.map(clip => clip.timelineEndUs)) });
  if (JSON.stringify(next) === JSON.stringify(plan)) return false;
  arrangement.audioPlan = next;
  return true;
}
