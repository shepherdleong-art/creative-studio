export type AudioTrackKind = 'narration' | 'bgm';
export interface AudioClip { id: string; startUs: number; endUs: number }
export type AudioEdits = Partial<Record<AudioTrackKind, AudioClip[]>>;

export function audioClips(state: { audio?: AudioEdits }, track: AudioTrackKind, durationUs: number): AudioClip[] {
  return state.audio?.[track] ?? [{ id: `${track}-full`, startUs: 0, endUs: Math.round(durationUs) }];
}

export function audioAudibleAt(clips: AudioClip[] | undefined, timeUs: number): boolean {
  return clips === undefined || clips.some((clip) => timeUs >= clip.startUs && timeUs < clip.endUs);
}

export function editAudioClip(state: { audio?: AudioEdits }, track: AudioTrackKind, durationUs: number, clipId: string, splitUs?: number): void {
  if (track !== 'narration' && track !== 'bgm') throw new Error('音轨无效');
  const clips = audioClips(state, track, durationUs);
  const clip = clips.find((item) => item.id === clipId);
  if (!clip) throw new Error('音频片段不存在');
  const cut = Math.round(splitUs ?? 0);
  if (splitUs !== undefined && (!Number.isFinite(splitUs) || cut - clip.startUs < 10_000 || Math.min(clip.endUs, durationUs) - cut < 10_000)) {
    throw new Error('请在音频片段内部裁切，两侧至少保留 0.01 秒');
  }
  state.audio = { ...state.audio, [track]: clips.flatMap((item) => item.id !== clipId ? [item] : splitUs === undefined ? [] : [
    { ...item, endUs: cut }, { id: `${item.id}-${cut}`, startUs: cut, endUs: item.endUs },
  ]) };
}

export function parseAudioEdits(value: unknown): AudioEdits | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('音频裁切数据无效');
  const result: AudioEdits = {};
  for (const track of ['narration', 'bgm'] as const) {
    const clips = (value as AudioEdits)[track];
    if (clips === undefined) continue;
    if (!Array.isArray(clips)) throw new Error('音频裁切数据无效');
    let endUs = 0;
    const ids = new Set<string>();
    result[track] = clips.map((clip) => {
      if (!clip || typeof clip.id !== 'string' || !clip.id || ids.has(clip.id) || !Number.isSafeInteger(clip.startUs) || !Number.isSafeInteger(clip.endUs) || clip.startUs < endUs || clip.endUs <= clip.startUs) throw new Error('音频片段区间无效');
      ids.add(clip.id); endUs = clip.endUs;
      return { id: clip.id, startUs: clip.startUs, endUs: clip.endUs };
    });
  }
  return result;
}

/** Keep original timing and silence removed ranges. */
export function audioCutFilter(clips: AudioClip[] | undefined): string {
  if (clips === undefined) return '';
  const expression = clips.map((clip) => `gte(t,${(clip.startUs / 1e6).toFixed(6)})*lt(t,${(clip.endUs / 1e6).toFixed(6)})`).join('+') || '0';
  return `volume='min(1,${expression})':eval=frame,`;
}
