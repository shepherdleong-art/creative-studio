import { audioClips, normalizeAudioClip, type AudioTrackKind } from '../../../lib/media-core/audio-edit.ts';
import type { BatchOutputClipEditView } from '../../../lib/batch-production/output-arrangement.ts';

/** 时间轴、快捷键共用当前版本声音坐标；不合成一条虚假的整片口播。 */
export function reviewAudioClips(view: BatchOutputClipEditView, track: AudioTrackKind, fallbackDurationUs: number) {
  if (track === 'narration' && view.audioPlan) return view.audioPlan.clips.map(clip => normalizeAudioClip({ id: clip.id,
    sourceStartUs: clip.sourceInUs, sourceEndUs: clip.sourceOutUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs }));
  return audioClips({ audio: view.audio }, track, view.audioPlan?.bodyDurationUs ?? view.narration.durationUs ?? fallbackDurationUs);
}
