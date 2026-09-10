import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { videoStorageFilename, writeVideoOutputFile } from '../lib/video-output-storage.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-output-storage-'));
try {
  const name = '01-LH122K3-沙发-缓慢推近-V01.mp4';
  const first = writeVideoOutputFile(dir, name, Buffer.from('first'));
  const second = writeVideoOutputFile(dir, name, Buffer.from('second'));
  assert.equal(first.filename, name);
  assert.equal(second.filename, '01-LH122K3-沙发-缓慢推近-V01 (2).mp4');
  assert.equal(fs.readFileSync(first.videoPath, 'utf8'), 'first');
  assert.equal(fs.readFileSync(second.videoPath, 'utf8'), 'second');
  fs.writeFileSync(path.join(dir, '孤立.preview.mp4'), 'old preview');
  assert.equal(writeVideoOutputFile(dir, '孤立.mp4', Buffer.from('new')).filename, '孤立 (2).mp4');
  for (const name of ['../../escape.mp4', 'C:\\folder\\CON.mp4', 'a:*?"<>|.mp4', '...mp4']) {
    const result = writeVideoOutputFile(dir, name, Buffer.from('safe'));
    assert.equal(path.dirname(result.videoPath), dir);
    assert.doesNotMatch(result.filename, /[<>:"/\\|?*]/);
  }
  assert.equal(videoStorageFilename('CON.mp4'), '视频-CON.mp4');
  assert.equal(videoStorageFilename('名称. .mp4'), '名称.mp4');
  assert.ok(videoStorageFilename('长'.repeat(500) + '.mp4').length <= 120);
} finally { fs.rmSync(dir, {recursive:true,force:true}); }
console.log('video output storage tests passed');
