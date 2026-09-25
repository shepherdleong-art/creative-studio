import assert from 'node:assert/strict';
import { extractWaveform, waveformBars } from '../components/audio/waveform-data.ts';

const rate = 1000;
const left = new Float32Array(rate * 4);
const right = new Float32Array(rate * 4);
for (let i = rate; i < rate * 2; i++) { left[i] = .5; right[i] = -.5; }
for (let i = rate * 3; i < rate * 4; i++) right[i] = 1;
const data = extractWaveform([left, right], rate);
assert.equal(data.durationSec, 4);
assert.equal(data.peaks.length, 800);
assert.equal(data.maxPeak, 1);
assert.deepEqual(waveformBars(data, 0, 4, 4, false), [0, .5, 0, 1], 'true silence and opposite-phase stereo are retained');
const whole = waveformBars(data, 0, 4, 40, false);
assert.deepEqual([...waveformBars(data, 0, 2, 20, false), ...waveformBars(data, 2, 4, 20, false)], whole, 'split clips keep the same source waveform');
assert.deepEqual(waveformBars(data, 1, 3, 20, false), whole.slice(10, 30), 'trim uses the selected source window');
assert.deepEqual(waveformBars(data, 3, 7, 4, true), [1, 0, .5, 0], 'looped BGM repeats at its actual duration');
assert.deepEqual(waveformBars(data, 3.5, 4.5, 1, true), [1], 'a bar crossing the loop seam includes both ends');
assert.deepEqual(waveformBars(data, 4, 6, 2, false), [0, 0], 'narration past EOF is silent, never repeated');
assert.deepEqual(waveformBars(data, 0, 12, 1, true), [1]);
assert.deepEqual(waveformBars(data, 2, 2, 10, false), []);
const silence = extractWaveform([new Float32Array(200)], rate);
assert.equal(silence.maxPeak, 0);
assert.ok(waveformBars(silence, 0, .2, 10, false).every(v => v === 0));
const tail = extractWaveform([new Float32Array([0, 0, 0, 1])], rate);
assert.equal(tail.maxPeak, 1, 'partial final bin preserves its last sample');
console.log('Audio waveform extraction, source ranges, splitting, silence and BGM looping passed');
