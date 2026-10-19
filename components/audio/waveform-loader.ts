import { extractWaveform, type WaveformData } from './waveform-data';

// Shared by split clips and films using the same BGM. Decode at most two files at
// once and retain only compact peaks, never decoded PCM or AudioContexts.
const cache = new Map<string, Promise<WaveformData>>();
const waiting: Array<() => void> = [];
let running = 0;
async function decode(url: string): Promise<WaveformData> {
  if (running >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else running++;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('音频读取失败');
    const bytes = await response.arrayBuffer();
    // Offline decoding does not play audio or require an autoplay gesture.
    const context = new OfflineAudioContext(1, 1, 8_000);
    const buffer = await context.decodeAudioData(bytes);
    return extractWaveform(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

export function loadWaveform(url: string, sourceKey: string): Promise<WaveformData> {
  const key = `${url}\n${sourceKey}`;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  const request = decode(url).catch(error => { cache.delete(key); throw error; });
  cache.set(key, request);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return request;
}
