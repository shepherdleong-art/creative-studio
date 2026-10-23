/** Five milliseconds within the selected interval; never extend or overlap speech. */
export const AUDIO_EDGE_FADE_US = 5_000;
export interface AudioEdgeFade { inUs: number; outUs: number }
export interface AudioGainPoint { afterSec: number; gain: number }
interface EdgeClip {
  id: string; sourceKey: string; sourceStartUs: number; sourceEndUs: number;
  timelineStartUs: number; timelineEndUs: number; gainDb?: number; sourcePeriodUs?: number;
}

/** A structural split of one continuous source must not create a new fade. */
export function audioEdgeFades(clips: readonly EdgeClip[]): Map<string, AudioEdgeFade> {
  const ordered = [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  const continuous = (a: EdgeClip | undefined, b: EdgeClip | undefined) => {
    if (!a || !b || a.sourceKey !== b.sourceKey || (a.gainDb ?? 0) !== (b.gainDb ?? 0)
      || Math.abs(a.timelineEndUs - b.timelineStartUs) > 1) return false;
    const end = a.sourcePeriodUs ? a.sourceEndUs % a.sourcePeriodUs : a.sourceEndUs;
    const start = b.sourcePeriodUs ? b.sourceStartUs % b.sourcePeriodUs : b.sourceStartUs;
    return Math.abs(end - start) <= 1;
  };
  return new Map(ordered.map((clip, index) => {
    const duration = Math.min(AUDIO_EDGE_FADE_US, Math.floor((clip.timelineEndUs - clip.timelineStartUs) / 2));
    return [clip.id, { inUs: continuous(ordered[index - 1], clip) ? 0 : duration,
      outUs: continuous(clip, ordered[index + 1]) ? 0 : duration }];
  }));
}

export function audioEdgeFilter(fade: AudioEdgeFade, durationUs: number): string {
  const seconds = (us: number) => (us / 1e6).toFixed(6);
  return [fade.inUs ? `afade=t=in:st=0:d=${seconds(fade.inUs)}` : '',
    fade.outUs ? `afade=t=out:st=${seconds(durationUs - fade.outUs)}:d=${seconds(fade.outUs)}` : ''].filter(Boolean).join(',');
}

/** Current gain plus future linear ramps, scheduled on the audio clock (not rAF). */
export function audioEdgeEnvelope(fade: AudioEdgeFade, positionUs: number, durationUs: number, gain = 1): AudioGainPoint[] {
  const level = (at: number) => gain * Math.min(
    fade.inUs ? Math.max(0, Math.min(1, at / fade.inUs)) : 1,
    fade.outUs ? Math.max(0, Math.min(1, (durationUs - at) / fade.outUs)) : 1,
  );
  const future = [...new Set([fade.inUs, durationUs - fade.outUs, durationUs])]
    .filter(at => at > positionUs).sort((a, b) => a - b);
  return [{ afterSec: 0, gain: level(positionUs) }, ...future.map(at => ({ afterSec: (at - positionUs) / 1e6, gain: level(at) }))];
}
