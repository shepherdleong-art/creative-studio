/** Snap either edge of a moving clip; preserve exact existing seams. */
export function snapMovingClip(input: {
  startSec: number; durationSec: number; candidates: number[];
  preferredCandidates?: number[]; pxPerSecond: number; enabled: boolean; fps: number;
}): { startSec: number; snapSec: number | null } {
  if (input.enabled) {
    for (const candidates of [input.preferredCandidates ?? [], input.candidates]) {
      let best: { startSec: number; snapSec: number } | null = null;
      let distance = 9 / input.pxPerSecond;
      for (const sec of candidates) {
        for (const offset of [0, input.durationSec]) {
          const delta = Math.abs(sec - (input.startSec + offset));
          if (sec - offset >= 0 && delta < distance) {
            best = { startSec: sec - offset, snapSec: sec };
            distance = delta;
          }
        }
      }
      if (best) return best;
    }
  }
  return { startSec: Math.max(0, Math.round(input.startSec * input.fps) / input.fps), snapSec: null };
}
