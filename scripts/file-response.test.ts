import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileResponse } from '../lib/media-core/file-response.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-stream-'));
const file = path.join(root, 'video.mp4');
const bytes = Buffer.alloc(256 * 1024, 7);
fs.writeFileSync(file, bytes);
for (const [range, status, size] of [['bytes=0-1023', 206, 1024], ['bytes=-500', 206, 500], ['bytes=262000-999999', 206, 144], ['bytes=999999-', 416, 0], ['bytes=100-1', 416, 0], ['bytes=-0', 416, 0], ['bytes=abc', 416, 0]] as const) {
  const result = fileResponse(new Request('http://localhost/video', { headers: { range } }), file, 'video/mp4');
  assert.equal(result.status, status, range);
  assert.equal((await result.arrayBuffer()).byteLength, size, range);
}
const full = fileResponse(new Request('http://localhost/video'), file, 'video/mp4');
assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
console.log('PASS: streamed full file, seeks, suffix range, clipped end, invalid ranges.');
