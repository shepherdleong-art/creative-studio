import assert from 'node:assert/strict';
import { groupFormulaVideoUploads, FORMULA_VIDEO_UPLOAD_LIMITS as limits } from '../lib/live-mixcut/formula/video-upload.ts';
const files = Array.from({ length: 257 }, (_, i) => ({ name: `G${i + 1}.mp4`, size: 7 * 1024 * 1024 }));
const result = groupFormulaVideoUploads(files);
assert.deepEqual(result.batches.flat(), files, '257 文件不可被请求上限截断');
assert(result.batches.length > 1);
for (const batch of result.batches) {
  assert(batch.length <= limits.fileCount);
  assert(batch.reduce((total, file) => total + file.size, 0) <= limits.requestBytes);
}
const mixed = groupFormulaVideoUploads([{ name: 'G1.mp4', size: limits.fileBytes }, { name: 'G2.mp4', size: limits.fileBytes + 1 }, { name: 'notes.txt', size: 1 }]);
assert.equal(mixed.batches[0].length, 1);
assert.equal(mixed.rejected.length, 2);
console.log('formula-video-upload: 257 文件完整分批、单文件及请求上限通过');
