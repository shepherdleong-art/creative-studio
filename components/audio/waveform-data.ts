export interface WaveformData {
  peaks: Float32Array;
  binsPerSecond: number;
  durationSec: number;
  maxPeak: number;
}

/** Keep the strongest channel, so opposite-phase stereo cannot disappear. */
export function extractWaveform(channels: Float32Array[], sampleRate: number, binsPerSecond = 200): WaveformData {
  const length = channels[0]?.length ?? 0;
  const durationSec = length / sampleRate;
  const peaks = new Float32Array(Math.ceil(durationSec * binsPerSecond));
  let maxPeak = 0;
  for (let bin = 0; bin < peaks.length; bin++) {
    const start = Math.floor(bin * sampleRate / binsPerSecond);
    const end = Math.min(length, Math.floor((bin + 1) * sampleRate / binsPerSecond));
    let peak = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
    peaks[bin] = peak;
    maxPeak = Math.max(maxPeak, peak);
  }
  return { peaks, binsPerSecond, durationSec, maxPeak };
}

/** Sample source coordinates, independent of where the clip is placed on the timeline. */
export function waveformBars(data: WaveformData, sourceStartSec: number, sourceEndSec: number, count: number, loop: boolean): number[] {
  if (count <= 0 || sourceEndSec <= sourceStartSec || data.durationSec <= 0) return [];
  const peakIn = (start: number, end: number) => {
    let peak = 0;
    const from = Math.max(0, Math.floor(start * data.binsPerSecond));
    const to = Math.min(data.peaks.length, Math.ceil(end * data.binsPerSecond));
    for (let i = from; i < to; i++) peak = Math.max(peak, data.peaks[i]);
    return peak;
  };
  return Array.from({ length: count }, (_, index) => {
    const start = sourceStartSec + (sourceEndSec - sourceStartSec) * index / count;
    const end = sourceStartSec + (sourceEndSec - sourceStartSec) * (index + 1) / count;
    if (!loop) return peakIn(start, end);
    if (end - start >= data.durationSec) return data.maxPeak;
    const wrapped = ((start % data.durationSec) + data.durationSec) % data.durationSec;
    const stop = wrapped + end - start;
    return stop <= data.durationSec ? peakIn(wrapped, stop) : Math.max(peakIn(wrapped, data.durationSec), peakIn(0, stop - data.durationSec));
  });
}
