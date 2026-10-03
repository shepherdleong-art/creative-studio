import { FINAL_EDIT_MIN_CLIP_FRAMES, type AudioTrackKind, type TimelineClip, type VideoTimeline } from './types.ts';
import { FinalEditError } from './errors.ts';

export function videoPlaybackRate(clip: TimelineClip): number {
  return clip.playbackRate ?? 1;
}

export function changeVideoPlaybackRate(timeline: VideoTimeline, clipId: string, playbackRate: number): void {
  if (!Number.isFinite(playbackRate) || playbackRate < 0.25 || playbackRate > 4) {
    throw new FinalEditError('invalid_video_playback_rate', '视频倍速须在 0.25–4 倍之间');
  }
  const clip = timeline.clips.find((item) => item.id === clipId);
  if (!clip) throw new FinalEditError('clip_not_found', '视频片段不存在', 404);
  const duration = Math.round((clip.sourceOutFrame - clip.sourceInFrame) / playbackRate);
  if (duration < FINAL_EDIT_MIN_CLIP_FRAMES) throw new FinalEditError('clip_too_short', '变速后片段不能短于 0.5 秒');
  const nextStart = Math.min(timeline.bodyFrames, ...timeline.clips.filter((item) => item.id !== clipId && item.timelineInFrame >= clip.timelineOutFrame).map((item) => item.timelineInFrame));
  if (clip.timelineInFrame + duration > nextStart) throw new FinalEditError('timeline_overlap', '变速后空位不足，请先移动后面的片段或缩短当前片段');
  clip.playbackRate = playbackRate;
  clip.timelineOutFrame = clip.timelineInFrame + duration;
  timeline.allowGaps = true;
}

export { audioClips, audioAudibleAt, audioCutFilter } from '../media-core/audio-edit.ts';
import { editAudioClip as editAudio } from '../media-core/audio-edit.ts';
export function editAudioClip(timeline: VideoTimeline, track: AudioTrackKind, durationUs: number, clipId: string, splitUs?: number): void {
  try { editAudio(timeline, track, durationUs, clipId, splitUs); }
  catch (error) { throw new FinalEditError('invalid_audio_edit', error instanceof Error ? error.message : '音频裁切失败'); }
}
