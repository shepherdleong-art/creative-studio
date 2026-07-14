import assert from 'node:assert/strict';
import { validateArrangement } from '../lib/final-video/arrangement.ts';
import type { ArrangementPlan, ClipPoolItem, NarrationBeat } from '../lib/final-video/types.ts';

const beat = (beatId: string, index: number, durationSec = 1): NarrationBeat => ({
  beatId, index, text: beatId, subtitleText: beatId, shotId: `shot-${beatId}`, imageAssetId: `image-${beatId}`, audioPath: `/tmp/${beatId}.mp3`, durationSec, startSec: index,
});
const clip = (clipId: string, shotIndex: number): ClipPoolItem => ({
  clipId, shotId: `shot-${clipId}`, shotIndex, videoPath: `/tmp/${clipId}.mp4`, clipDurationSec: 10,
  sourceImageId: `image-${clipId}`, sourceImagePath: `/tmp/${clipId}.png`,
});
const beats = [beat('b0', 0), beat('b1', 1), beat('b2', 2), beat('b3', 3)];
const clips = [clip('c0', 0), clip('c1', 1), clip('c2', 2)];
const valid: ArrangementPlan = {
  assignments: [{ assignmentId: 'a0', clipId: 'c0', beatIds: ['b0', 'b1'] }],
  gaps: [{ beatId: 'b2', reason: '  missing visual  ' }, { beatId: 'b3', reason: 'later' }],
};
const invalid = (plan: ArrangementPlan, testBeats = beats, testClips = clips) => {
  const result = validateArrangement(plan, testBeats, testClips);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected invalid arrangement');
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => issue.code === 'arrangement_invalid' && issue.severity === 'error'));
};

const normalized = validateArrangement({
  assignments: [{ ...valid.assignments[0], ignored: true }],
  gaps: valid.gaps.map((gap) => ({ ...gap, ignored: true })),
  ignored: true,
} as unknown as ArrangementPlan, beats, clips);
assert.equal(normalized.ok, true);
if (!normalized.ok) throw new Error('expected valid arrangement');
assert.deepEqual(normalized.plan, {
  assignments: [{ assignmentId: 'a0', clipId: 'c0', beatIds: ['b0', 'b1'] }],
  gaps: [{ beatId: 'b2', reason: 'missing visual' }, { beatId: 'b3', reason: 'later' }],
});
assert.deepEqual(Object.keys(normalized.plan).sort(), ['assignments', 'gaps']);

invalid({ assignments: [{ assignmentId: 'a', clipId: 'unknown', beatIds: ['b0'] }], gaps: beats.slice(1).map(({ beatId }) => ({ beatId, reason: 'x' })) });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['unknown'] }], gaps: beats.map(({ beatId }) => ({ beatId, reason: 'x' })) });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: [] }], gaps: beats.map(({ beatId }) => ({ beatId, reason: 'x' })) });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0', 'b2'] }], gaps: [{ beatId: 'b1', reason: 'x' }, { beatId: 'b3', reason: 'x' }] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b1', 'b0'] }], gaps: [{ beatId: 'b2', reason: 'x' }, { beatId: 'b3', reason: 'x' }] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b2'] }, { assignmentId: 'b', clipId: 'c1', beatIds: ['b0', 'b1'] }], gaps: [{ beatId: 'b3', reason: 'x' }] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0', 'b1'] }, { assignmentId: 'b', clipId: 'c1', beatIds: ['b1', 'b2'] }], gaps: [{ beatId: 'b3', reason: 'x' }] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0'] }], gaps: [{ beatId: 'b1', reason: 'x' }, { beatId: 'b1', reason: 'again' }, { beatId: 'b2', reason: 'x' }, { beatId: 'b3', reason: 'x' }] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0'] }], gaps: [{ beatId: 'b0', reason: 'x' }, ...beats.slice(1).map(({ beatId }) => ({ beatId, reason: 'x' }))] });
invalid({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0'] }, { assignmentId: 'b', clipId: 'c0', beatIds: ['b1'] }], gaps: beats.slice(2).map(({ beatId }) => ({ beatId, reason: 'x' })) });
invalid({ assignments: [], gaps: beats.slice(1).map(({ beatId }) => ({ beatId, reason: 'x' })) });
invalid({ assignments: [], gaps: [{ beatId: 'unknown', reason: 'x' }, ...beats.map(({ beatId }) => ({ beatId, reason: 'x' }))] });
invalid({ assignments: [], gaps: beats.map(({ beatId }) => ({ beatId, reason: '   ' })) });
invalid({ assignments: [], gaps: beats.map(({ beatId }) => ({ beatId, reason: 'x'.repeat(201) })) });
assert.equal(validateArrangement({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0', 'b1'] }], gaps: [] }, [beat('b0', 0, 2), beat('b1', 1, 2)], clips).ok, true);
assert.equal(validateArrangement({ assignments: [{ assignmentId: 'a', clipId: 'c0', beatIds: ['b0', 'b1'] }], gaps: [] }, [beat('b0', 0, 0.1), beat('b1', 1, 0.2)], clips).ok, true);
for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) invalid({ assignments: [], gaps: [{ beatId: 'b', reason: 'x' }] }, [beat('b', 0, duration)], clips);

console.log('final-video-arrangement tests passed');
