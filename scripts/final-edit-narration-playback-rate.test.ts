import assert from 'node:assert/strict';
import {
  formatNarrationPlaybackRateInput,
  NARRATION_PLAYBACK_RATE_MAX,
  NARRATION_PLAYBACK_RATE_MIN,
  NARRATION_PLAYBACK_RATE_PRESETS,
  NARRATION_PLAYBACK_RATE_STEP,
  normalizeNarrationPlaybackRate,
} from '../components/mixcut/narration-playback-rate.ts';

assert.equal(NARRATION_PLAYBACK_RATE_MIN, 0.5);
assert.equal(NARRATION_PLAYBACK_RATE_MAX, 2);
assert.equal(NARRATION_PLAYBACK_RATE_STEP, 0.1);
assert.deepEqual(NARRATION_PLAYBACK_RATE_PRESETS, [0.8, 1, 1.2, 1.5]);

assert.equal(normalizeNarrationPlaybackRate(0.2), 0.5);
assert.equal(normalizeNarrationPlaybackRate(2.4), 2);
assert.equal(normalizeNarrationPlaybackRate(1.35), 1.4);
assert.equal(normalizeNarrationPlaybackRate(1.34), 1.3);
assert.equal(normalizeNarrationPlaybackRate(Number.NaN), 1);
assert.equal(normalizeNarrationPlaybackRate(Number.POSITIVE_INFINITY), 1);

assert.equal(formatNarrationPlaybackRateInput(1), '1');
assert.equal(formatNarrationPlaybackRateInput(1.4), '1.4');

console.log('final-edit narration playback rate tests passed');
