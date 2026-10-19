import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploadRoute = fs.readFileSync('app/api/upload/route.ts', 'utf8');
const singleRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/route.ts', 'utf8');
const batchRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/batch/route.ts', 'utf8');
const providerRoute = fs.readFileSync('app/api/providers/video/route.ts', 'utf8');
const providerItemRoute = fs.readFileSync('app/api/providers/video/[id]/route.ts', 'utf8');

assert.match(uploadRoute, /VIDEO_TAIL_FRAME_USAGE/, 'upload API must allow the dedicated tail-frame usage');
assert.match(uploadRoute, /validateVideoTailFrameUpload/, 'upload API must enforce one project-owned tail image');
assert.match(uploadRoute, /validateUploadedImageBuffer/, 'upload API must fully decode images before writing them');

for (const [label, route] of [['single', singleRoute], ['batch', batchRoute]]) {
  assert.match(route, /tailImageId/, `${label} video creation must accept tailImageId`);
  assert.match(route, /validateVideoTailFrameAsset/, `${label} video creation must validate the tail asset`);
  assert.match(
    route,
    /INSERT INTO video_jobs[\s\S]*tailImageId/,
    `${label} video creation must persist tailImageId`,
  );
}

assert.match(
  singleRoute,
  /db\.transaction\([\s\S]*validateVideoTailFrameAsset[\s\S]*INSERT INTO video_jobs/,
  'single video creation must validate and insert in the same transaction',
);
assert.match(
  batchRoute,
  /db\.transaction\([\s\S]*validateVideoTailFrameAsset[\s\S]*insert\.run/,
  'batch video creation must validate and insert in the same transaction',
);

assert.match(batchRoute, /validateVideoTailFrameBatchDrafts/, 'batch creation must reject tail rows with blank prompts before filtering');

assert.match(providerRoute, /tailFrameCapability/, 'provider collection must expose safe tail-frame capability');
assert.match(providerItemRoute, /tailFrameCapability/, 'provider item must expose safe tail-frame capability');

console.log('video tail-frame API contract tests passed');
