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

// ── 规格 §6：自动模式意图标记与「不能只信前端 generationMode」 ──
assert.match(sharedCreate, /modeIntent/, 'shared creation must accept the backward-compatible auto-mode intent marker');
assert.match(sharedCreate, /reconcileAutoModeItems/, 'shared creation must reconcile auto-mode items on the server');
assert.match(sharedCreate, /decideVideoGenerationMode/, 'server must reuse the same pure mode rule as the browser');
for (const [label, route] of [['single', singleRoute], ['batch', batchRoute]]) {
  assert.match(route, /parseVideoJobCreationItem/, `${label} route must go through the shared parser`);
}
// 自动模式核对必须先于图片预处理与落任务事务，保证「付费 POST 前失败」。
const reconcileAt = sharedCreate.indexOf('reconcileAutoModeItems({');
const insertAt = sharedCreate.indexOf('INSERT INTO video_jobs');
const preprocessAt = sharedCreate.indexOf('prepareVideoJobImage({');
assert.notEqual(reconcileAt, -1);
assert.ok(reconcileAt < insertAt, 'auto-mode reconciliation must run before the insert transaction');
assert.ok(reconcileAt < preprocessAt, 'auto-mode reconciliation must run before image preprocessing');

console.log('video tail-frame API contract tests passed');
