import { audioClips, type AudioClip } from './audio-edit.ts';

export interface MusicTimelineClip {
  id: string;
  timelineStartUs: number; timelineEndUs: number;
  sourceStartUs: number; sourceEndUs: number;
}
export interface MusicTimeline { sourceDurationUs: number; clips: MusicTimelineClip[] }

/** Music loops at the source-file boundary; edits and fades use body coordinates. */
export function buildMusicTimeline(edits: AudioClip[] | undefined, bodyDurationUs: number, sourceDurationUs: number): MusicTimeline {
  if (!Number.isSafeInteger(bodyDurationUs) || bodyDurationUs <= 0
    || !Number.isSafeInteger(sourceDurationUs) || sourceDurationUs <= 0) throw new RangeError('背景音乐或正文时长无效');
  const input = audioClips({ audio: { bgm: edits } }, 'bgm', bodyDurationUs);
  if (input.length > 1000) throw new RangeError('背景音乐片段过多，请合并后重试');
  const ids = new Set<string>();
  const clips: MusicTimelineClip[] = [];
  let previousEndUs = 0;
  for (const clip of input) {
    if (!clip.id || ids.has(clip.id)
      || ![clip.timelineStartUs, clip.timelineEndUs, clip.sourceStartUs, clip.sourceEndUs].every(Number.isSafeInteger)
      || clip.timelineStartUs < previousEndUs || clip.timelineEndUs <= clip.timelineStartUs
      || clip.sourceStartUs < 0 || clip.sourceEndUs <= clip.sourceStartUs
      || Math.abs((clip.sourceEndUs - clip.sourceStartUs) - (clip.timelineEndUs - clip.timelineStartUs)) > 1) {
      throw new RangeError('背景音乐取源与时间轴区间无效，不能重叠或改变播放速度');
    }
    ids.add(clip.id); previousEndUs = clip.timelineEndUs;
    const timelineEndUs = Math.min(bodyDurationUs, clip.timelineEndUs);
    if (clip.timelineStartUs >= timelineEndUs) continue;
    const sourceStartUs = clip.sourceStartUs % sourceDurationUs;
    const sourceEndUs = sourceStartUs + timelineEndUs - clip.timelineStartUs;
    if (!Number.isSafeInteger(sourceEndUs)) throw new RangeError('背景音乐取源区间过长');
    clips.push({ id: clip.id, timelineStartUs: clip.timelineStartUs, timelineEndUs, sourceStartUs, sourceEndUs });
  }
  return { sourceDurationUs, clips };
}

/** Null means a removed range, cover or the end of the body: no music is audible. */
export function musicPositionAtTime(timeline: MusicTimeline, bodyTimeUs: number): { clipId: string; sourceTimeUs: number } | null {
  if (!Number.isFinite(bodyTimeUs)) return null;
  const clip = timeline.clips.find(clip => bodyTimeUs >= clip.timelineStartUs && bodyTimeUs < clip.timelineEndUs);
  return clip ? { clipId: clip.id, sourceTimeUs: (clip.sourceStartUs + bodyTimeUs - clip.timelineStartUs) % timeline.sourceDurationUs } : null;
}
