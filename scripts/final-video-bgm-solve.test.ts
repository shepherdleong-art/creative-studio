import assert from 'node:assert/strict';
import { solveBgmTimeline, TimelineSolverError } from '../lib/final-video/solve-bgm-timeline.ts';
import type { ClipPoolItem } from '../lib/final-video/types.ts';

function clip(clipId: string, clipDurationSec: number, shotIndex: number): ClipPoolItem {
  return {
    clipId,
    shotId: `shot-${clipId}`,
    shotIndex,
    videoPath: `/clips/${clipId}.mp4`,
    clipDurationSec,
    sourceImageId: `image-${clipId}`,
    sourceImagePath: `/images/${clipId}.jpg`,
    visualDescription: '',
    descriptionProviderId: null,
    descriptionModel: null,
  };
}

const clips = [clip('first', 6, 1), clip('second', 6, 2), clip('third', 2, 3)];

{
  const solved = solveBgmTimeline({
    selectedClipIds: ['second', 'first', 'third'],
    clips,
    introDurationSec: 1,
    targetDurationSec: 7,
    fps: 30,
  });

  assert.equal(solved.totalDurationSec, 7, 'target duration includes the intro');
  assert.equal(solved.contentDurationSec, 6);
  assert.deepEqual(solved.segments.map((segment) => segment.clipId), ['second', 'first']);
  assert.deepEqual(solved.segments.map((segment) => segment.mediaDurationSec), [4, 2]);
  assert.deepEqual(solved.segments.map((segment) => segment.segmentDurationSec), [4, 2]);
  assert.deepEqual(solved.segments.map((segment) => segment.startSec), [1, 5]);
  assert.equal(solved.segments[1].trimEndToSec, 2, 'the final source clip is trimmed to the exact target');
  assert.equal(solved.segments.every((segment) => segment.padStopSec === 0), true, 'sufficient material must not freeze');
  assert.deepEqual(solved.issues, []);
}

{
  const solved = solveBgmTimeline({
    selectedClipIds: ['first', 'third'],
    clips,
    introDurationSec: 1,
    targetDurationSec: 9,
    fps: 30,
  });

  assert.equal(solved.contentDurationSec, 8);
  assert.deepEqual(solved.segments.map((segment) => segment.mediaDurationSec), [4, 2]);
  assert.deepEqual(solved.segments.map((segment) => segment.padStopSec), [0, 2]);
  assert.equal(solved.segments[1].segmentDurationSec, 4);
  assert.equal(solved.segments.at(-1)?.startSec, 5);
  assert.deepEqual(solved.issues.map((issue) => issue.code), ['last_clip_frozen']);
}

{
  const solved = solveBgmTimeline({
    selectedClipIds: ['first'], clips, introDurationSec: 0, targetDurationSec: 6, fps: 30,
  });
  assert.equal(solved.segments[0].mediaDurationSec, 4, 'BGM displays are capped at the hardcoded BGM_MAX_CLIP_SECONDS regardless of clip length');
  assert.equal(solved.segments[0].padStopSec, 2);
}

assert.throws(
  () => solveBgmTimeline({
    selectedClipIds: ['missing'], clips, introDurationSec: 0, targetDurationSec: 5, fps: 30,
  }),
  (error: unknown) => error instanceof TimelineSolverError && error.code === 'selected_clip_missing',
);

assert.throws(
  () => solveBgmTimeline({
    selectedClipIds: [], clips, introDurationSec: 0, targetDurationSec: 5, fps: 30,
  }),
  (error: unknown) => error instanceof TimelineSolverError && error.code === 'no_selected_clips',
);

console.log('final-video-bgm-solve tests passed');
