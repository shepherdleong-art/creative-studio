import { audioEdgeFades, audioEdgeEnvelope, type AudioGainPoint, type AudioEdgeFade } from './audio-edges.ts';

/** 所有位置均为正文微秒；片头偏移由播放器调用边界减去一次。 */
export interface PreviewAudioClip {
  id: string; kind: 'source' | 'narration'; url: string; sourceDurationUs: number;
  sourceInUs: number; sourceOutUs: number; timelineStartUs: number; timelineEndUs: number; gainDb: number;
}
export interface PreviewAudioTimeline { revisionId: string; bodyDurationUs: number; clips: PreviewAudioClip[] }
export interface PreviewAudioMedia {
  readyState: number; duration: number; currentTime: number; paused: boolean; seeking: boolean;
  play(): Promise<void>; pause(): void; setGain(gain: number, automation?: AudioGainPoint[]): void; dispose(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
export type PreviewAudioState = { status: 'ready' | 'loading' | 'error'; message?: string };
interface Entry {
  clip: PreviewAudioClip; media: PreviewAudioMedia; removeListeners: () => void;
  pending: boolean; generation: number; error: string | null;
}

function validate(input: PreviewAudioTimeline): PreviewAudioTimeline {
  if (!input.revisionId || !Number.isSafeInteger(input.bodyDurationUs) || input.bodyDurationUs <= 0 || input.clips.length > 1000) throw new Error('声音时间线无效');
  const ids = new Set<string>();
  const clips = input.clips.map(clip => {
    if (!clip.id || ids.has(clip.id) || !['source', 'narration'].includes(clip.kind) || !clip.url
      || ![clip.sourceDurationUs, clip.sourceInUs, clip.sourceOutUs, clip.timelineStartUs, clip.timelineEndUs].every(Number.isSafeInteger)
      || clip.sourceDurationUs <= 0 || clip.sourceInUs < 0 || clip.sourceOutUs <= clip.sourceInUs || clip.sourceOutUs > clip.sourceDurationUs
      || clip.timelineStartUs < 0 || clip.timelineEndUs <= clip.timelineStartUs || clip.timelineEndUs > input.bodyDurationUs
      || Math.abs((clip.sourceOutUs - clip.sourceInUs) - (clip.timelineEndUs - clip.timelineStartUs)) > 1
      || !Number.isFinite(clip.gainDb) || clip.gainDb < -60 || clip.gainDb > 24) throw new Error('声音来源或播放区间无效');
    ids.add(clip.id); return { ...clip };
  }).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  if (clips.some((clip, i) => i > 0 && clip.timelineStartUs < clips[i - 1].timelineEndUs)) throw new Error('原声与配音不能重叠播放');
  // Editing may split one continuous source into several blocks. Keep that
  // structure in the saved edit, but play it without a second decoder/start.
  const playback: PreviewAudioClip[] = [];
  for (const clip of clips) {
    const previous = playback.at(-1);
    if (previous && previous.kind === clip.kind && previous.url === clip.url && previous.gainDb === clip.gainDb
      && previous.sourceDurationUs === clip.sourceDurationUs
      && Math.abs(previous.sourceOutUs - clip.sourceInUs) <= 1
      && Math.abs(previous.timelineEndUs - clip.timelineStartUs) <= 1) {
      previous.sourceOutUs = clip.sourceOutUs; previous.timelineEndUs = clip.timelineEndUs;
    } else playback.push({ ...clip });
  }
  return { ...input, clips: playback };
}

/** 媒体 API 是外部边界；保留当前及下一段，避免为长公式一次加载全部原片。 */
export class PreviewAudioTimelinePlayer {
  private timeline: PreviewAudioTimeline;
  private edges: Map<string, AudioEdgeFade>;
  private entries = new Map<string, Entry>();
  private positionUs = -1;
  private playing = false;
  private disposed = false;
  private lastState = '';
  private createMedia: (clip: PreviewAudioClip) => PreviewAudioMedia;
  private onState: (state: PreviewAudioState) => void;

  constructor(timeline: PreviewAudioTimeline, createMedia: (clip: PreviewAudioClip) => PreviewAudioMedia,
    onState: (state: PreviewAudioState) => void = () => {}) {
    this.timeline = validate(timeline); this.createMedia = createMedia; this.onState = onState;
    this.edges = audioEdgeFades(this.timeline.clips.map(clip => ({ ...clip, sourceKey: clip.url,
      sourceStartUs: clip.sourceInUs, sourceEndUs: clip.sourceOutUs })));
  }

  private report(state: PreviewAudioState): boolean {
    const key = JSON.stringify(state);
    if (key !== this.lastState) { this.lastState = key; this.onState(state); }
    return state.status === 'ready';
  }

  private ensure(clip: PreviewAudioClip): Entry {
    const existing = this.entries.get(clip.id);
    if (existing) return existing;
    const media = this.createMedia(clip);
    const entry: Entry = { clip, media, pending: false, generation: 0, error: null, removeListeners: () => {} };
    const current = () => !this.disposed && this.entries.get(clip.id) === entry;
    const synchronize = () => { if (current()) this.sync(this.positionUs, this.playing); };
    const error = () => {
      if (!current()) return;
      entry.error = '声音文件加载失败，请检查素材后重试。'; synchronize();
    };
    for (const event of ['loadedmetadata', 'canplay', 'seeked']) media.addEventListener(event, synchronize);
    media.addEventListener('error', error);
    entry.removeListeners = () => {
      for (const event of ['loadedmetadata', 'canplay', 'seeked']) media.removeEventListener(event, synchronize);
      media.removeEventListener('error', error);
    };
    this.entries.set(clip.id, entry); media.setGain(0);
    return entry;
  }

  private silence(entry: Entry): void {
    entry.generation++; entry.pending = false; entry.media.setGain(0); entry.media.pause();
  }

  /** 返回 false 时调用方应暂停推进播放时钟，不能把加载失败当作无声区间。 */
  sync(positionUs: number, playing: boolean): boolean {
    if (this.disposed) return false;
    if (!Number.isFinite(positionUs)) throw new Error('播放位置无效');
    this.positionUs = positionUs; this.playing = playing;
    const index = this.timeline.clips.findIndex(clip => clip.timelineEndUs > positionUs);
    const upcoming = index >= 0 ? this.timeline.clips.slice(index, index + 2) : [];
    const active = upcoming[0] && positionUs >= upcoming[0].timelineStartUs ? upcoming[0] : null;
    for (const clip of upcoming) this.ensure(clip);
    for (const [id, entry] of this.entries) {
      if (id !== active?.id) this.silence(entry);
      if (!upcoming.some(clip => clip.id === id)) {
        this.entries.delete(id); entry.removeListeners(); entry.media.dispose();
      }
    }
    if (!active || positionUs >= this.timeline.bodyDurationUs) return this.report({ status: 'ready' });
    const entry = this.entries.get(active.id)!;
    const media = entry.media;
    if (entry.error) { this.silence(entry); return this.report({ status: 'error', message: entry.error }); }
    if (media.readyState < 1) { this.silence(entry); return this.report({ status: 'loading' }); }
    if (!Number.isFinite(media.duration) || active.sourceOutUs > media.duration * 1_000_000 + 50_000) {
      entry.error = '声音长度与已保存区间不符，请重新核验。'; this.silence(entry);
      return this.report({ status: 'error', message: entry.error });
    }
    const expected = (active.sourceInUs + positionUs - active.timelineStartUs) / 1_000_000;
    if (Math.abs(media.currentTime - expected) > (playing ? 0.08 : 0.001)) {
      this.silence(entry);
      if (!media.seeking) media.currentTime = expected;
    }
    if (media.readyState < 2 || media.seeking) { this.silence(entry); return this.report({ status: 'loading' }); }
    if (!playing) { this.silence(entry); return this.report({ status: 'ready' }); }
    // Stop follows the transport clock, so its fade must follow that clock too.
    // The media adapter separately fades the first decoded samples on startup.
    const envelope = audioEdgeEnvelope(this.edges.get(active.id)!, positionUs - active.timelineStartUs,
      active.timelineEndUs - active.timelineStartUs, 10 ** (active.gainDb / 20));
    media.setGain(envelope[0].gain, envelope.slice(1));
    if (media.paused && !entry.pending) {
      entry.pending = true;
      const generation = ++entry.generation;
      void media.play().then(() => {
        if (this.disposed || this.entries.get(active.id) !== entry || !this.playing
          || this.positionUs < active.timelineStartUs || this.positionUs >= active.timelineEndUs) { media.setGain(0); media.pause(); }
        if (entry.generation === generation) entry.pending = false;
      }).catch(() => {
        if (this.disposed || this.entries.get(active.id) !== entry || generation !== entry.generation) return;
        entry.pending = false; entry.error = '声音播放被阻止，请再次点击播放或检查素材。';
        this.sync(this.positionUs, this.playing);
      });
    }
    return this.report({ status: 'ready' });
  }

  pause(): void { this.playing = false; for (const entry of this.entries.values()) this.silence(entry); }
  /** 仅在用户明确重播时重建失败音源，后台轮询不能反复重试失败请求。 */
  retryFailed(): void {
    if (this.disposed) return;
    for (const [id, entry] of this.entries) {
      if (!entry.error) continue;
      this.entries.delete(id); entry.removeListeners(); entry.media.dispose();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pause();
    for (const entry of this.entries.values()) { entry.removeListeners(); entry.media.dispose(); }
    this.entries.clear();
  }
}
