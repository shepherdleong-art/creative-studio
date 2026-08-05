import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertNarrationPublishable,
  createLocalNarrationSnapshot,
  createSilentNarrationPlaceholder,
} from '../lib/batch-production/narration.ts';

const placeholder = createSilentNarrationPlaceholder({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  targetDurationUs: 9_000_000,
});
const repeated = createSilentNarrationPlaceholder({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  targetDurationUs: 9_000_000,
});
assert.deepEqual(repeated, placeholder, '预计 timing 必须确定性复现');
assert.equal(placeholder.mode, 'silent_placeholder');
assert.equal(placeholder.productionReady, false, '静音视觉候选不得伪装成正式口播');
assert.equal(placeholder.segments[0]?.startUs, 0);
assert.equal(placeholder.segments.at(-1)?.endUs, 9_000_000);
assert.ok(placeholder.segments.every((segment, index) => (
  segment.endUs > segment.startUs
  && (index === 0 || segment.startUs === placeholder.segments[index - 1]?.endUs)
)));
assert.throws(() => assertNarrationPublishable(placeholder), /尚未准备/);

const localFingerprint = `sha256:${createHash('sha256').update('local narration').digest('hex')}`;
const local = createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: 'storage/batch-narration/snapshot-a.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments.map(({ sourceSegmentId, startUs, endUs }) => ({
      sourceSegmentId,
      startUs,
      endUs,
    })),
  },
});
assert.equal(local.productionReady, true);
assert.equal(local.mode, 'local_ready');
assert.doesNotThrow(() => assertNarrationPublishable(local));
assert.ok(local.segments.every((segment) => segment.timingSource === 'aligned'));

assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: '/tmp/escape.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments,
  },
}), /storage 相对路径/);

assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: '../escape.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: placeholder.segments,
  },
}), /storage 相对路径/);

const invalidTimings = placeholder.segments.map(({ sourceSegmentId, startUs, endUs }) => ({
  sourceSegmentId,
  startUs,
  endUs,
}));
invalidTimings[1] = { ...invalidTimings[1]!, startUs: 0 };
assert.throws(() => createLocalNarrationSnapshot({
  scriptSnapshotId: 'snapshot-a',
  bodyText: '第一句介绍产品。第二句说明优势！最后一句引导行动。',
  artifact: {
    audioRelativePath: 'storage/batch-narration/snapshot-a.wav',
    audioFingerprint: localFingerprint,
    durationUs: 9_000_000,
    segmentTimings: invalidTimings,
  },
}), /时间非法|重叠/);

console.log('batch narration seam tests passed');
