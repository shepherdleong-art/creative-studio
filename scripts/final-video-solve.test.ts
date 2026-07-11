import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { solveTimeline } from '../lib/final-video/solve-timeline.ts';
import type { ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineResult } from '../lib/final-video/types.ts';

const beat = (beatId: string, index: number, durationSec: number): NarrationBeat => ({
  beatId, groupId: `g-${beatId}`, index, text: beatId, audioPath: `/tmp/${beatId}.mp3`, durationSec, startSec: 99,
});
const clip = (clipId: string, shotIndex: number, clipDurationSec: number): ClipPoolItem => ({
  clipId, shotId: `s-${clipId}`, shotIndex, videoPath: `/tmp/${clipId}.mp4`, clipDurationSec,
  sourceImageId: `i-${clipId}`, sourceImagePath: `/tmp/${clipId}.png`, visualDescription: clipId,
  descriptionProviderId: null, descriptionModel: null,
});
const plan = (assignments: Array<[string, string[]]>, gaps: ArrangementPlan['gaps'] = []): ArrangementPlan => ({
  assignments: assignments.map(([clipId, beatIds], index) => ({ assignmentId: `a${index}`, clipId, beatIds })), gaps,
});
const solve = (overrides: Partial<Parameters<typeof solveTimeline>[0]> = {}) => solveTimeline({
  beats: [beat('b0', 0, 2), beat('b1', 1, 2)], clips: [clip('c0', 0, 10)],
  plan: plan([['c0', ['b0', 'b1']]]), introDurationSec: 0, targetDurationSec: 4,
  durationTolerancePct: 0.2, maxClipSeconds: 4, fps: 30, ...overrides,
});
const invariant = (result: TimelineResult, raw: number, fps: number) => {
  const sum = result.segments.reduce((total, segment) => total + segment.segmentDurationSec, 0);
  assert.ok(Math.abs(sum - result.contentDurationSec) <= 1e-9);
  assert.ok(result.contentDurationSec >= raw);
  assert.ok(result.contentDurationSec - raw < 1 / fps);
  for (const segment of result.segments) {
    assert.ok(Math.abs(segment.segmentDurationSec - segment.mediaDurationSec - segment.padStopSec) <= 1e-9);
  }
};
const codes = (result: TimelineResult) => result.issues.map((issue) => issue.code);

// Enough media trims only its tail; exact physical use is not represented as a trim.
let result = solve();
assert.equal(result.segments[0].mediaDurationSec, 4);
assert.equal(result.segments[0].trimEndToSec, 4);
assert.equal(result.segments[0].padStopSec, 0);
result = solve({ clips: [clip('c0', 0, 4)] });
assert.equal(result.segments[0].trimEndToSec, null);
assert.equal(result.segments[0].padStopSec, 0);

// A short non-final clip hands its uncovered time to the next assignment.
result = solve({
  beats: [beat('b0', 0, 2), beat('b1', 1, 2)], clips: [clip('c0', 0, 1), clip('c1', 1, 5)],
  plan: plan([['c0', ['b0']], ['c1', ['b1']]]),
});
assert.deepEqual(result.segments.map((segment) => segment.segmentDurationSec), [1, 3]);
assert.ok(codes(result).includes('clip_short_borrowed_forward'));
assert.deepEqual(result.segments[1].coveredBeatIds, ['b0', 'b1']);

// Final fallback consumes remaining physical media before freezing.
result = solve({ beats: [beat('b0', 0, 4)], clips: [clip('c0', 0, 3)], plan: plan([['c0', ['b0']]]) });
assert.equal(result.segments[0].mediaDurationSec, 3);
assert.equal(result.segments[0].padStopSec, 1);
assert.ok(codes(result).includes('last_clip_frozen'));
result = solve({
  beats: [beat('b0', 0, 1), beat('b1', 1, 3)], clips: [clip('c0', 0, 3)],
  plan: plan([['c0', ['b0']]], [{ beatId: 'b1', reason: '  no matching image  ' }]),
});
assert.equal(result.segments[0].mediaDurationSec, 3);
assert.equal(result.segments[0].padStopSec, 1);
assert.deepEqual(result.segments[0].gapBeatIds, ['b1']);
assert.deepEqual(result.issues.find((issue) => issue.code === 'visual_gap')?.beatIds, ['b1']);
assert.match(result.issues.find((issue) => issue.code === 'visual_gap')?.message ?? '', /no matching image/);

// An all-gap plan uses the lowest-shot filler and retains every explicit gap.
result = solve({
  beats: [beat('b0', 0, 1), beat('b1', 1, 2)], clips: [clip('later', 5, 1), clip('first', 1, 2)],
  plan: plan([], [{ beatId: 'b0', reason: 'one' }, { beatId: 'b1', reason: 'two' }]), targetDurationSec: 3,
});
assert.equal(result.segments[0].clipId, 'first');
assert.equal(result.segments[0].mediaDurationSec, 2);
assert.equal(result.segments[0].padStopSec, 1);
assert.deepEqual(result.segments[0].gapBeatIds, ['b0', 'b1']);
assert.equal(result.issues.filter((issue) => issue.code === 'visual_gap').length, 2);

// A gap remains visible even if a borrowed-forward neighboring visual overlaps it.
result = solve({
  beats: [beat('b0', 0, 1), beat('b1', 1, 1), beat('b2', 2, 1)],
  clips: [clip('c0', 0, 1), clip('c1', 1, 5)],
  plan: plan([['c0', ['b0']], ['c1', ['b2']]], [{ beatId: 'b1', reason: 'gap' }]), targetDurationSec: 3,
});
assert.deepEqual(result.segments[1].gapBeatIds, ['b1']);
assert.ok(codes(result).includes('visual_gap'));

// Intro is added exactly once, and tolerance equality is accepted while a strict excess warns.
result = solve({ introDurationSec: 2, targetDurationSec: 6, durationTolerancePct: 0 });
assert.equal(result.totalDurationSec, 6);
assert.equal(result.segments[0].startSec, 2);
assert.ok(!codes(result).includes('target_duration_out_of_tolerance'));
assert.ok(!codes(solve({ targetDurationSec: 5, durationTolerancePct: 0.2 })).includes('target_duration_out_of_tolerance'));
assert.ok(!codes(solve({ targetDurationSec: 5, durationTolerancePct: 0.2 - 5e-10 })).includes('target_duration_out_of_tolerance'));
assert.ok(codes(solve({ targetDurationSec: 5, durationTolerancePct: 0.19 })).includes('target_duration_out_of_tolerance'));

// Frame-safe tail rounds upward without cutting narration; half-open coverage excludes exact boundaries.
result = solve({
  beats: [beat('b0', 0, 1), beat('b1', 1, 0.001)], clips: [clip('c0', 0, 1), clip('c1', 1, 1)],
  plan: plan([['c0', ['b0']], ['c1', ['b1']]]), targetDurationSec: 1.001,
});
assert.equal(result.contentDurationSec, 31 / 30);
assert.deepEqual(result.segments[0].coveredBeatIds, ['b0']);
invariant(result, 1.001, 30);

// A narration duration infinitesimally above a frame boundary must never be shortened.
result = solve({
  beats: [beat('b0', 0, 1.00000000001)], clips: [clip('c0', 0, 2)],
  plan: plan([['c0', ['b0']]]), targetDurationSec: 1.00000000001,
});
assert.equal(result.contentDurationSec, 31 / 30);
assert.ok(result.contentDurationSec >= 1.00000000001);
invariant(result, 1.00000000001, 30);

// Binary multiplication noise must not add a whole frame when the quotient is exactly representable.
result = solve({
  beats: [beat('b0', 0, 2.2)], clips: [clip('c0', 0, 3)],
  plan: plan([['c0', ['b0']]]), targetDurationSec: 2.2, fps: 25,
});
assert.equal(result.contentDurationSec, 55 / 25);
invariant(result, 2.2, 25);

// Decimal equality uses epsilon and results are deterministic without mutating inputs.
const input = {
  beats: [beat('b1', 1, 0.2), beat('b0', 0, 0.1)], clips: [clip('c0', 0, 1)],
  plan: plan([['c0', ['b0', 'b1']]]), introDurationSec: 0, targetDurationSec: 0.3,
  durationTolerancePct: 0, maxClipSeconds: 0.3, fps: 10,
};
const snapshot = structuredClone(input);
const first = solveTimeline(input);
assert.deepEqual(input, snapshot);
assert.deepEqual(solveTimeline(input), first);
invariant(first, input.beats.reduce((sum, item) => sum + item.durationSec, 0), 10);

// Stable local error codes cover scalar and collection preconditions and invalid arrangements.
const expectCode = (code: string, overrides: Partial<Parameters<typeof solveTimeline>[0]>) => assert.throws(
  () => solve(overrides), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code,
);
for (const fps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expectCode('invalid_fps', { fps });
for (const targetDurationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expectCode('invalid_target_duration', { targetDurationSec });
for (const maxClipSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expectCode('invalid_max_clip_seconds', { maxClipSeconds });
for (const introDurationSec of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expectCode('invalid_intro_duration', { introDurationSec });
for (const durationTolerancePct of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expectCode('invalid_duration_tolerance', { durationTolerancePct });
expectCode('no_visual_source', { clips: [] });
expectCode('invalid_beats', { beats: [beat('b', 0, 1), beat('b', 1, 1)] });
expectCode('invalid_beats', { beats: [beat('a', 0, 1), beat('b', 0, 1)] });
expectCode('invalid_beats', { beats: [beat('a', 0, 1), beat('b', 2, 1)] });
expectCode('invalid_beats', { beats: [beat('a', 0, 0)] });
expectCode('invalid_clips', { clips: [clip('c', 0, 1), clip('c', 1, 1)] });
expectCode('invalid_clips', { clips: [clip('c', 0, 0)] });
expectCode('invalid_arrangement', { plan: plan([['missing', ['b0']]], [{ beatId: 'b1', reason: 'gap' }]) });

// Overflow must terminate promptly instead of entering an unbounded frame-adjustment loop.
const overflowProbe = (durations: number[], fps: number) => {
  const source = `
    import { solveTimeline } from './lib/final-video/solve-timeline.ts';
    const durations = ${JSON.stringify(durations)};
    const beats = durations.map((durationSec, index) => ({ beatId: 'b' + index, groupId: 'g' + index, index, text: '', audioPath: '', durationSec, startSec: 0 }));
    const gaps = beats.map(({ beatId }) => ({ beatId, reason: 'gap' }));
    const clips = [{ clipId: 'c', shotId: 's', shotIndex: 0, videoPath: '/tmp/c.mp4', clipDurationSec: 1, sourceImageId: 'i', sourceImagePath: '/tmp/i.png', visualDescription: '', descriptionProviderId: null, descriptionModel: null }];
    try { solveTimeline({ plan: { assignments: [], gaps }, beats, clips, introDurationSec: 0, targetDurationSec: 1, durationTolerancePct: 0, maxClipSeconds: 4, fps: ${fps} }); }
    catch (error) { process.stdout.write(error.code ?? 'missing_code'); }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: process.cwd(), encoding: 'utf8', timeout: 1_000 });
};
for (const probe of [overflowProbe([1e308], 2), overflowProbe([1e308, 1e308], 1)]) {
  assert.equal(probe.signal, null, `overflow probe did not terminate: ${probe.error?.message ?? probe.signal}`);
  assert.equal(probe.stdout, 'invalid_timeline_input');
}
try {
  solve({ plan: plan([['missing', ['b0']]], [{ beatId: 'b1', reason: 'gap' }]) });
  assert.fail('expected invalid arrangement');
} catch (error) {
  assert.ok(error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues));
}

console.log('final-video-solve tests passed');
