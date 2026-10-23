import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { buildVerifiedZipStream, verifyZipFile } from '../lib/media-core/verified-zip.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-zip-'));
try {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 17);
  const file = { relativePath: 'video.mp4', filename: '成片/0001/中文视频.mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(path.join(root, file.relativePath), bytes);
  await verifyZipFile(root, file);
  const options = { date: new Date('2026-10-23T00:00:00Z') };
  const stream = () => buildVerifiedZipStream(root, [file], [{ filename: '清单.csv', text: '\ufeff"文件"\r\n"中文视频.mp4"' }], options);
  const zip = await JSZip.loadAsync(await new Response(stream()).arrayBuffer());
  assert.deepEqual(await zip.file(file.filename)!.async('nodebuffer'), bytes);
  assert.ok(zip.file('清单.csv'));
  const secondName = '成片/0002/中文视频.mp4';
  const repeatedNames = await JSZip.loadAsync(await new Response(buildVerifiedZipStream(root, [file, { ...file, filename: secondName }], [], options)).arrayBuffer());
  assert.deepEqual(await repeatedNames.file(file.filename)!.async('nodebuffer'), await repeatedNames.file(secondName)!.async('nodebuffer'),
    '不同成片子目录可保留相同中文文件名，不需要偷偷改名');
  assert.throws(() => buildVerifiedZipStream(root, [file, file], [], options), /重复/);
  assert.throws(() => buildVerifiedZipStream(root, [file, { ...file, filename: file.filename.replace('.mp4', '.MP4') }], [], options), /重复/);
  assert.throws(() => buildVerifiedZipStream(root, [{ ...file, filename: '../泄漏.mp4' }], [], options), /无效/);
  // After headers start flowing, replace the still-streaming source. Never finish a seemingly successful partial ZIP.
  const changing = stream().getReader();
  assert.equal((await changing.read()).done, false);
  fs.writeFileSync(path.join(root, file.relativePath), Buffer.alloc(bytes.length, 23));
  await assert.rejects(async () => { while (!(await changing.read()).done) { /* consume */ } }, /发生变化/);
  await assert.rejects(verifyZipFile(root, file), /内容已变化/);
  fs.writeFileSync(path.join(root, file.relativePath), bytes);
  const cancelled = stream().getReader();
  await cancelled.read();
  await cancelled.cancel();
  const signal = new AbortController();
  const aborted = buildVerifiedZipStream(root, [file], [], { ...options, signal: signal.signal }).getReader();
  await aborted.read(); signal.abort();
  await assert.rejects(async () => { while (!(await aborted.read()).done) { /* buffered header may arrive before the abort */ } }, /取消/);
  fs.unlinkSync(path.join(root, file.relativePath));
  await assert.rejects(verifyZipFile(root, file));
  console.log('verified ZIP: 中文文件、完整字节、重名/越界拒绝、流中变更失败、取消及缺失文件通过');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
