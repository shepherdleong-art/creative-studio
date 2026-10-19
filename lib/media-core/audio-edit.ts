export type AudioTrackKind = 'narration' | 'bgm';

export interface AudioClip {
  id: string;
  /** 时间轴上的起始与结束微秒 */
  timelineStartUs?: number;
  timelineEndUs?: number;
  /** 对应源音频文件中的起始与结束微秒 */
  sourceStartUs?: number;
  sourceEndUs?: number;
  /** 兼容历史旧字段（在序列化/反序列化与旧代码读取中保持一致） */
  startUs?: number;
  endUs?: number;
}

export interface NormalizedAudioClip extends AudioClip {
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  startUs: number;
  endUs: number;
}

export type AudioEdits = Partial<Record<AudioTrackKind, AudioClip[]>>;

export function normalizeAudioClip(clip: {
  id: string;
  timelineStartUs?: number;
  timelineEndUs?: number;
  sourceStartUs?: number;
  sourceEndUs?: number;
  startUs?: number;
  endUs?: number;
}): NormalizedAudioClip {
  const tStart = Math.round(clip.timelineStartUs ?? clip.startUs ?? 0);
  const tEnd = Math.round(clip.timelineEndUs ?? clip.endUs ?? tStart);
  const sStart = Math.round(clip.sourceStartUs ?? clip.startUs ?? 0);
  const duration = Math.max(0, tEnd - tStart);
  const sEnd = Math.round(clip.sourceEndUs ?? (clip.endUs !== undefined ? clip.endUs : sStart + duration));
  return {
    id: clip.id,
    timelineStartUs: tStart,
    timelineEndUs: tEnd,
    sourceStartUs: sStart,
    sourceEndUs: sEnd,
    startUs: tStart,
    endUs: tEnd,
  };
}

export function audioClips(state: { audio?: AudioEdits }, track: AudioTrackKind, durationUs: number): NormalizedAudioClip[] {
  const list = state.audio?.[track];
  if (!list) {
    const end = Math.round(durationUs);
    return [{
      id: `${track}-full`,
      timelineStartUs: 0,
      timelineEndUs: end,
      sourceStartUs: 0,
      sourceEndUs: end,
      startUs: 0,
      endUs: end,
    }];
  }
  return list.map(normalizeAudioClip);
}

export function audioAudibleAt(clips: AudioClip[] | undefined, timeUs: number): boolean {
  if (clips === undefined) return true;
  return clips.some((clip) => {
    const c = normalizeAudioClip(clip);
    return timeUs >= c.timelineStartUs && timeUs < c.timelineEndUs;
  });
}

export function editAudioClip(
  state: { audio?: AudioEdits },
  track: AudioTrackKind,
  durationUs: number,
  clipId: string,
  splitUs?: number,
): void {
  if (track !== 'narration' && track !== 'bgm') throw new Error('音轨无效');
  const clips = audioClips(state, track, durationUs);
  const clip = clips.find((item) => item.id === clipId);
  if (!clip) throw new Error('音频片段不存在');
  const cut = Math.round(splitUs ?? 0);
  if (splitUs !== undefined && (!Number.isFinite(splitUs) || cut - clip.timelineStartUs < 10_000 || Math.min(clip.timelineEndUs, durationUs) - cut < 10_000)) {
    throw new Error('请在音频片段内部裁切，两侧至少保留 0.01 秒');
  }
  state.audio = {
    ...state.audio,
    [track]: clips.flatMap((item) => {
      if (item.id !== clipId) return [item];
      if (splitUs === undefined) return []; // delete
      const cutOffset = cut - item.timelineStartUs;
      const leftSourceEnd = item.sourceStartUs + cutOffset;
      const left = normalizeAudioClip({
        ...item,
        timelineEndUs: cut,
        sourceEndUs: leftSourceEnd,
        endUs: cut,
      });
      const right = normalizeAudioClip({
        id: `${item.id}-${cut}`,
        timelineStartUs: cut,
        timelineEndUs: item.timelineEndUs,
        sourceStartUs: leftSourceEnd,
        sourceEndUs: item.sourceEndUs,
        startUs: cut,
        endUs: item.timelineEndUs,
      });
      return [left, right];
    }),
  };
}

export function trimAudioClip(
  state: { audio?: AudioEdits },
  track: AudioTrackKind,
  durationUs: number,
  clipId: string,
  options: {
    sourceStartUs: number;
    sourceEndUs: number;
    timelineStartUs?: number;
    timelineEndUs?: number;
    sourceDurationUs?: number;
    minDurationUs?: number;
  },
): void {
  if (track !== 'narration' && track !== 'bgm') throw new Error('音轨无效');
  const clips = audioClips(state, track, durationUs);
  const index = clips.findIndex((item) => item.id === clipId);
  if (index < 0) throw new Error('音频片段不存在');
  const clip = clips[index];
  const sourceStart = Math.round(options.sourceStartUs);
  const sourceEnd = Math.round(options.sourceEndUs);
  const clipDuration = sourceEnd - sourceStart;
  const minDur = options.minDurationUs ?? 10_000;
  if (clipDuration < minDur) throw new Error(`修剪后音频长度不能短于 ${(minDur / 1_000_000).toFixed(1)} 秒`);
  if (options.sourceDurationUs && sourceEnd > options.sourceDurationUs) {
    throw new Error('截取区间超出原音频时长');
  }
  const timelineStart = Math.round(options.timelineStartUs ?? clip.timelineStartUs);
  const timelineEnd = Math.round(options.timelineEndUs ?? (timelineStart + clipDuration));
  if (timelineEnd <= timelineStart) throw new Error('音频时间轴区间无效');

  const prev = index > 0 ? clips[index - 1] : null;
  const next = index + 1 < clips.length ? clips[index + 1] : null;
  if (prev && timelineStart < prev.timelineEndUs) throw new Error('修剪超出当前空位，不能覆盖相邻音频片段');
  if (next && timelineEnd > next.timelineStartUs) throw new Error('修剪超出当前空位，不能覆盖相邻音频片段');

  const updated = normalizeAudioClip({
    ...clip,
    sourceStartUs: sourceStart,
    sourceEndUs: sourceEnd,
    timelineStartUs: timelineStart,
    timelineEndUs: timelineEnd,
    startUs: timelineStart,
    endUs: timelineEnd,
  });

  const nextClips = [...clips];
  nextClips[index] = updated;
  state.audio = { ...state.audio, [track]: nextClips };
}

export function moveAudioClip(
  state: { audio?: AudioEdits },
  track: AudioTrackKind,
  durationUs: number,
  clipId: string,
  timelineStartUs: number,
): void {
  if (track !== 'narration' && track !== 'bgm') throw new Error('音轨无效');
  const clips = audioClips(state, track, durationUs);
  const index = clips.findIndex((item) => item.id === clipId);
  if (index < 0) throw new Error('音频片段不存在');
  const clip = clips[index];
  const tStart = Math.max(0, Math.round(timelineStartUs));
  const length = clip.timelineEndUs - clip.timelineStartUs;
  const tEnd = tStart + length;

  const prev = index > 0 ? clips[index - 1] : null;
  const next = index + 1 < clips.length ? clips[index + 1] : null;
  if (prev && tStart < prev.timelineEndUs) throw new Error('移动超出当前空位，不能覆盖相邻音频片段');
  if (next && tEnd > next.timelineStartUs) throw new Error('移动超出当前空位，不能覆盖相邻音频片段');

  const updated = normalizeAudioClip({
    ...clip,
    timelineStartUs: tStart,
    timelineEndUs: tEnd,
    startUs: tStart,
    endUs: tEnd,
  });
  const nextClips = [...clips];
  nextClips[index] = updated;
  state.audio = { ...state.audio, [track]: nextClips };
}

export function parseAudioEdits(value: unknown): AudioEdits | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('音频裁切数据无效');
  const result: AudioEdits = {};
  for (const track of ['narration', 'bgm'] as const) {
    const rawTrack = (value as Record<string, unknown>)[track];
    if (rawTrack === undefined) continue;
    const clips = Array.isArray(rawTrack)
      ? rawTrack
      : (rawTrack && typeof rawTrack === 'object' && Array.isArray((rawTrack as Record<string, unknown>).clips))
        ? (rawTrack as Record<string, unknown>).clips as unknown[]
        : null;
    if (!clips) throw new Error('音频裁切数据无效');
    let lastTimelineEndUs = 0;
    const ids = new Set<string>();
    result[track] = clips.map((raw) => {
      const item = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
      const id = typeof item?.id === 'string' && item.id ? item.id : typeof item?.clipId === 'string' && item.clipId ? item.clipId : null;
      if (!item || !id || ids.has(id)) {
        throw new Error('音频片段数据无效');
      }
      const tStart = typeof item.timelineStartUs === 'number' ? item.timelineStartUs : typeof item.startUs === 'number' ? item.startUs : null;
      const tEnd = typeof item.timelineEndUs === 'number' ? item.timelineEndUs : typeof item.endUs === 'number' ? item.endUs : null;
      const sStart = typeof item.sourceStartUs === 'number' ? item.sourceStartUs : tStart;
      const sEnd = typeof item.sourceEndUs === 'number' ? item.sourceEndUs : tEnd;

      if (
        tStart === null || !Number.isSafeInteger(tStart) || tStart < 0
        || tEnd === null || !Number.isSafeInteger(tEnd) || tEnd <= tStart
        || sStart === null || !Number.isSafeInteger(sStart) || sStart < 0
        || sEnd === null || !Number.isSafeInteger(sEnd) || sEnd <= sStart
        || tStart < lastTimelineEndUs
      ) {
        throw new Error('音频片段区间无效');
      }
      ids.add(id);
      lastTimelineEndUs = tEnd;
      return normalizeAudioClip({
        id,
        timelineStartUs: tStart,
        timelineEndUs: tEnd,
        sourceStartUs: sStart,
        sourceEndUs: sEnd,
      });
    });
  }
  return result;
}

/** Keep original timing and silence removed ranges. */
export function audioCutFilter(clips: AudioClip[] | undefined): string {
  if (clips === undefined) return '';
  const expression = clips.map((clip) => {
    const c = normalizeAudioClip(clip);
    return `gte(t,${(c.timelineStartUs / 1e6).toFixed(6)})*lt(t,${(c.timelineEndUs / 1e6).toFixed(6)})`;
  }).join('+') || '0';
  return `volume='min(1,${expression})':eval=frame,`;
}

/** Check if any audio clip has been displaced from its source timeline position. */
export function isAudioClipsMoved(clips: AudioClip[] | undefined): boolean {
  if (!clips || clips.length === 0) return false;
  return clips.some((clip) => {
    const c = normalizeAudioClip(clip);
    return Math.abs(c.sourceStartUs - c.timelineStartUs) > 1000 || Math.abs(c.sourceEndUs - c.timelineEndUs) > 1000;
  });
}
