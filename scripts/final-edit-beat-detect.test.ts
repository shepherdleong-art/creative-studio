import assert from 'node:assert/strict';
import { parseSilencePoints, uniformBeatFallback } from '../lib/final-edit/beat-detect.ts';

const stderr = `
[silencedetect @ x] silence_start: 0
[silencedetect @ x] silence_end: 0.4 | silence_duration: 0.4
[silencedetect @ x] silence_start: 1.2
[silencedetect @ x] silence_end: 1.8 | silence_duration: 0.6
`;
assert.deepEqual(parseSilencePoints(stderr), [200_000, 1_500_000]);
assert.deepEqual(parseSilencePoints('[silencedetect @ x] silence_end: 0.3 | silence_duration: 0.3'), [150_000]);
assert.deepEqual(parseSilencePoints('no silence here'), []);

assert.deepEqual(uniformBeatFallback(8_000_000), [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 6_000_000, 7_000_000]);
assert.deepEqual(uniformBeatFallback(0), []);

console.log('final-edit beat detection tests passed');
