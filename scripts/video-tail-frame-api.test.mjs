import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploadRoute = fs.readFileSync('app/api/upload/route.ts', 'utf8');
const singleRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/route.ts', 'utf8');
const batchRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/batch/route.ts', 'utf8');
const sharedCreate = fs.readFileSync('lib/video-job-create.ts', 'utf8');

assert.match(uploadRoute, /VIDEO_TAIL_FRAME_USAGE/, 'upload API must allow the dedicated tail-frame usage');
assert.match(uploadRoute, /validateVideoTailFrameUpload/, 'upload API must enforce one project-owned tail image');
assert.match(uploadRoute, /validateUploadedImageBuffer/, 'upload API must fully decode images before writing them');

for (const [label, route] of [['single', singleRoute], ['batch', batchRoute]]) {
  assert.match(route, /createVideoJobsForShot/, `${label} video creation must use the shared creation path`);
  assert.match(route, /parseVideoJobCreationItem/, `${label} video creation must use the shared input parser`);
}
assert.match(sharedCreate, /tailImageId/, 'shared video creation must accept tailImageId');
assert.match(sharedCreate, /validateVideoTailFrameAsset/, 'shared video creation must validate the tail asset');
assert.match(
  sharedCreate,
  /INSERT INTO video_jobs[\s\S]*tailImageId/,
  'shared video creation must persist tailImageId',
);
assert.match(
  sharedCreate,
  /db\.transaction\([\s\S]*validateVideoTailFrameAsset[\s\S]*INSERT INTO video_jobs/,
  'shared video creation must validate and insert in the same transaction',
);
assert.match(batchRoute, /validateVideoTailFrameBatchDrafts/, 'batch creation must reject tail rows with blank prompts before filtering');

console.log('video tail-frame API contract tests passed');
