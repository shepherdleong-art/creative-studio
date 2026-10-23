/** Versioned, deterministic music envelope shared by preview and rendering. Body time only. */
export interface MusicDuckingConfig {
  version: 1;
  enabled: boolean;
  reductionDb: number;
  attackMs: number;
  releaseMs: number;
}

export const DEFAULT_MUSIC_DUCKING: Readonly<MusicDuckingConfig> = Object.freeze({
  version: 1, enabled: true, reductionDb: 8, attackMs: 100, releaseMs: 250,
});

/** Missing legacy settings preserve the old constant-volume behavior. Invalid saved settings never silently change it. */
export function readMusicDucking(value: unknown): MusicDuckingConfig {
  if (value === undefined) return { ...DEFAULT_MUSIC_DUCKING, enabled: false };
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (raw.version !== 1 || typeof raw.enabled !== 'boolean'
    || typeof raw.reductionDb !== 'number' || !Number.isFinite(raw.reductionDb) || raw.reductionDb < 0 || raw.reductionDb > 24
    || !Number.isSafeInteger(raw.attackMs) || Number(raw.attackMs) < 0 || Number(raw.attackMs) > 2000
    || !Number.isSafeInteger(raw.releaseMs) || Number(raw.releaseMs) < 0 || Number(raw.releaseMs) > 5000) {
    throw new RangeError('音乐压低参数无效：降低量应为 0–24dB，压低时间为 0–2000ms，恢复时间为 0–5000ms');
  }
  return { version: 1, enabled: raw.enabled, reductionDb: raw.reductionDb, attackMs: Number(raw.attackMs), releaseMs: Number(raw.releaseMs) };
}

interface DuckingWindow { attackStartUs: number; startUs: number; endUs: number; releaseEndUs: number }
export interface MusicDuckingEnvelope { gain: number; windows: DuckingWindow[] }

export function createMusicDuckingEnvelope(clips: ReadonlyArray<{ timelineStartUs: number; timelineEndUs: number }>,
  config: MusicDuckingConfig): MusicDuckingEnvelope {
  const settings = readMusicDucking(config);
  if (!settings.enabled || settings.reductionDb === 0) return { gain: 1, windows: [] };
  const attackUs = settings.attackMs * 1000, releaseUs = settings.releaseMs * 1000;
  const windows: DuckingWindow[] = [];
  for (const clip of [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs)) {
    if (!Number.isSafeInteger(clip.timelineStartUs) || !Number.isSafeInteger(clip.timelineEndUs)
      || clip.timelineStartUs < 0 || clip.timelineEndUs <= clip.timelineStartUs) throw new RangeError('音乐压低的人声时间范围无效');
    const previous = windows.at(-1);
    // Adjacent edits and very short pauses are one voice window, preventing pumping at cuts.
    if (previous && clip.timelineStartUs - previous.endUs <= attackUs + releaseUs) {
      previous.endUs = Math.max(previous.endUs, clip.timelineEndUs);
      previous.releaseEndUs = previous.endUs + releaseUs;
    } else windows.push({ attackStartUs: Math.max(0, clip.timelineStartUs - attackUs), startUs: clip.timelineStartUs,
      endUs: clip.timelineEndUs, releaseEndUs: clip.timelineEndUs + releaseUs });
  }
  return { gain: 10 ** (-settings.reductionDb / 20), windows };
}

export function musicDuckingGainAtTime(envelope: MusicDuckingEnvelope, bodyTimeUs: number): number {
  if (!Number.isFinite(bodyTimeUs) || !envelope.windows.length) return 1;
  let low = 0, high = envelope.windows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (envelope.windows[mid].attackStartUs <= bodyTimeUs) low = mid + 1; else high = mid;
  }
  const window = envelope.windows[low - 1];
  if (!window || bodyTimeUs >= window.releaseEndUs) return 1;
  if (bodyTimeUs < window.startUs) return 1 - (1 - envelope.gain) * (bodyTimeUs - window.attackStartUs) / (window.startUs - window.attackStartUs);
  if (bodyTimeUs < window.endUs) return envelope.gain;
  return envelope.gain + (1 - envelope.gain) * (bodyTimeUs - window.endUs) / (window.releaseEndUs - window.endUs);
}

/** Sample-exact FFmpeg expression; a balanced decision tree avoids deep nesting after many edits. */
export function musicDuckingExpression(envelope: MusicDuckingEnvelope): string {
  const gain = envelope.gain.toPrecision(15), change = (1 - envelope.gain).toPrecision(15);
  const sec = (us: number) => (us / 1e6).toFixed(6);
  function build(from: number, to: number): string {
    if (from === to) return '1';
    if (to - from > 1) {
      const mid = (from + to) >>> 1;
      return `if(lt(t,${sec(envelope.windows[mid].attackStartUs)}),${build(from, mid)},${build(mid, to)})`;
    }
    const w = envelope.windows[from];
    let tail = w.releaseEndUs === w.endUs ? '1'
      : `if(lt(t,${sec(w.releaseEndUs)}),${gain}+${change}*(t-${sec(w.endUs)})/${sec(w.releaseEndUs - w.endUs)},1)`;
    tail = `if(lt(t,${sec(w.endUs)}),${gain},${tail})`;
    if (w.startUs > w.attackStartUs) tail = `if(lt(t,${sec(w.startUs)}),1-${change}*(t-${sec(w.attackStartUs)})/${sec(w.startUs - w.attackStartUs)},${tail})`;
    return `if(lt(t,${sec(w.attackStartUs)}),1,${tail})`;
  }
  return build(0, envelope.windows.length);
}
