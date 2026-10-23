/** Formula mix protection v1. Quiet audio is unchanged; only large peaks bend smoothly. */
export const AUDIO_PROTECTION_KNEE = 0.75;
export const AUDIO_PROTECTION_CEILING = 0.9;
export const AUDIO_PROTECTION_INPUT_RANGE = 32;

function protect(sample: number): number {
  const amplitude = Math.abs(sample);
  if (amplitude <= AUDIO_PROTECTION_KNEE) return sample;
  const span = AUDIO_PROTECTION_CEILING - AUDIO_PROTECTION_KNEE;
  return Math.sign(sample) * (AUDIO_PROTECTION_CEILING - span * Math.exp(-(amplitude - AUDIO_PROTECTION_KNEE) / span));
}

/** WaveShaper indexes [-1,1]; a preceding gain maps our full mix range into it. */
export function audioProtectionCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(65_537);
  for (let index = 0; index < curve.length; index++) {
    curve[index] = protect((index / (curve.length - 1) * 2 - 1) * AUDIO_PROTECTION_INPUT_RANGE);
  }
  return curve;
}

/** Same zero-latency transfer as the browser. Leave headroom for lossy encoding. */
export function audioProtectionFilter(): string {
  const span = AUDIO_PROTECTION_CEILING - AUDIO_PROTECTION_KNEE;
  const expression = (channel: number) => {
    const sample = `val(${channel})`, amplitude = `abs(${sample})`;
    return `if(lte(${amplitude},${AUDIO_PROTECTION_KNEE}),${sample},` +
      `if(lt(${sample},0),-1,1)*(${AUDIO_PROTECTION_CEILING}-${span}*exp(-(${amplitude}-${AUDIO_PROTECTION_KNEE})/${span})))`;
  };
  return `aformat=channel_layouts=stereo,aeval=exprs='${expression(0)}|${expression(1)}':c=stereo`;
}
