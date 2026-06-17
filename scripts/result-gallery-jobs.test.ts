import assert from 'node:assert/strict';
import {
  buildSceneReferenceByImageId,
  getSceneReferenceBadgeLabel,
  getActiveSceneReferences,
  getResultGalleryCounts,
  getResultJobKind,
  getSelectableResultJobs,
} from '../lib/result-gallery-jobs.ts';

const jobs = [
  { id: 'pending-1', status: 'pending' },
  { id: 'running-1', status: 'running' },
  { id: 'retrying-1', status: 'retrying' },
  { id: 'needs-check-1', status: 'needs_check' },
  { id: 'succeeded-1', status: 'succeeded', outputFilename: 'out-1.jpg' },
  { id: 'succeeded-empty', status: 'succeeded' },
  { id: 'failed-1', status: 'failed' },
];

assert.deepEqual(getResultGalleryCounts(jobs), {
  total: 7,
  active: 4,
  succeeded: 1,
  failed: 2,
});

assert.equal(getResultJobKind(jobs[0]), 'queued');
assert.equal(getResultJobKind(jobs[1]), 'generating');
assert.equal(getResultJobKind(jobs[2]), 'generating');
assert.equal(getResultJobKind(jobs[3]), 'checking');
assert.equal(getResultJobKind(jobs[4]), 'succeeded');
assert.equal(getResultJobKind(jobs[5]), 'failed');
assert.equal(getResultJobKind(jobs[6]), 'failed');

assert.deepEqual(
  getSelectableResultJobs(jobs).map((job) => job.id),
  ['succeeded-1', 'succeeded-empty', 'failed-1'],
);

const sceneReferenceByImageId = buildSceneReferenceByImageId([
  { id: 'ref-1', name: '暖光客厅主场景', imageAssetId: 'output-1', imageFilename: 'living-room.png', status: 'active' },
  { id: 'ref-2', name: '已归档场景', imageAssetId: 'output-2', imageFilename: 'archived.png', status: 'archived' },
]);

assert.deepEqual(sceneReferenceByImageId.get('output-1'), {
  id: 'ref-1',
  name: '暖光客厅主场景',
  imageFilename: 'living-room.png',
});
assert.equal(sceneReferenceByImageId.has('output-2'), false);
assert.equal(getSceneReferenceBadgeLabel(sceneReferenceByImageId.get('output-1')), '场景参考：暖光客厅主场景');
assert.equal(getSceneReferenceBadgeLabel(undefined), '已设为场景参考');
assert.deepEqual(
  getActiveSceneReferences([
    { id: 'ref-1', name: '暖光客厅主场景', imageAssetId: 'output-1', imageFilename: 'living-room.png', status: 'active' },
    { id: 'ref-2', name: '已归档场景', imageAssetId: 'output-2', imageFilename: 'archived.png', status: 'archived' },
    { id: 'ref-3', name: '草稿场景', imageAssetId: 'output-3', imageFilename: 'draft.png', status: 'draft' },
  ]).map((ref) => ref.id),
  ['ref-1'],
);

console.log('result-gallery-jobs tests passed');
