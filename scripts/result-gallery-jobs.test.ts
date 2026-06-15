import assert from 'node:assert/strict';
import {
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
  failed: 1,
});

assert.equal(getResultJobKind(jobs[0]), 'queued');
assert.equal(getResultJobKind(jobs[1]), 'generating');
assert.equal(getResultJobKind(jobs[2]), 'generating');
assert.equal(getResultJobKind(jobs[3]), 'checking');
assert.equal(getResultJobKind(jobs[4]), 'succeeded');
assert.equal(getResultJobKind(jobs[5]), 'empty');
assert.equal(getResultJobKind(jobs[6]), 'failed');

assert.deepEqual(
  getSelectableResultJobs(jobs).map((job) => job.id),
  ['succeeded-1', 'failed-1'],
);

console.log('result-gallery-jobs tests passed');
