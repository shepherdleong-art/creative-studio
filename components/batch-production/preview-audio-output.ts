import { audioProtectionCurve, AUDIO_PROTECTION_INPUT_RANGE } from '../../lib/media-core/audio-protection';
import type { AudioGainPoint } from '../../lib/media-core/audio-edges';
import { preparePreviewAudioStart } from './preview-audio-start';

export function schedulePreviewAudioGain(node: GainNode, context: BaseAudioContext, gain: number, automation: AudioGainPoint[] = []) {
  const now = context.currentTime;
  node.gain.cancelScheduledValues(now);
  node.gain.setValueAtTime(gain, now);
  for (const point of automation) node.gain.linearRampToValueAtTime(point.gain, now + point.afterSec);
}

/** One formula mix bus for speech and music; keep the ordinary preview path unchanged. */
export function createPreviewAudioOutput(context: AudioContext) {
  const input = context.createGain();
  const protection = context.createWaveShaper();
  input.gain.value = 1 / AUDIO_PROTECTION_INPUT_RANGE;
  protection.curve = audioProtectionCurve();
  protection.oversample = 'none';
  input.connect(protection).connect(context.destination);
  return { input, ready: preparePreviewAudioStart(context), dispose() { input.disconnect(); protection.disconnect(); } };
}
