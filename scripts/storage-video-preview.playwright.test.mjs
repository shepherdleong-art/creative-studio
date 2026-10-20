// Optional argv[2]: a registered video under dataRoot()/storage; original bytes are preserved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import { toStorageVideoUrl } from '../lib/storage-url.ts';
import { fileResponse } from '../lib/media-core/file-response.ts';
import { ensureBrowserPreview } from '../lib/video-browser-preview.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { dataRoot } from '../lib/data-root.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-video-preview-'));
let browser, server;
try {
  const storageRoot = process.argv[2] ? path.join(dataRoot(), 'storage') : temp;
  const file = process.argv[2] || path.join(temp, 'outputs', 'reassembled-productions', '片段 01.mp4');
  if (!process.argv[2]) {
    fs.mkdirSync(path.dirname(file), { recursive:true });
    await runFfmpeg(['-y','-f','lavfi','-i','testsrc2=size=320x240:rate=24:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',file], {timeoutMs:60000});
  }
  const url = toStorageVideoUrl(file, storageRoot);
  assert.ok(url);
  // Mirror the API path resolution and streaming boundary used by both UI previews.
  server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/api/videos/')) { res.setHeader('Content-Type','text/html'); res.end('<video muted controls></video>'); return; }
    const relative = new URL(req.url, 'http://localhost').pathname.slice('/api/videos/'.length).split('/').map(decodeURIComponent);
    const resolved = path.resolve(storageRoot, ...relative);
    assert.equal(resolved, path.resolve(file));
    const served = await ensureBrowserPreview(resolved);
    const result = fileResponse(new Request('http://localhost'+req.url, {headers: req.headers}), served, 'video/mp4');
    res.writeHead(result.status, Object.fromEntries(result.headers));
    Readable.fromWeb(result.body).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(url=>{document.querySelector('video').src=url+'?preview=1';},url);
  await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
  await page.evaluate(()=>document.querySelector('video').play());
  await page.waitForFunction(()=>document.querySelector('video').currentTime>.2);
  await page.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=v.duration/2;});
  await page.waitForFunction(()=>{const v=document.querySelector('video');return !v.seeking && v.readyState>=2 && Math.abs(v.currentTime-v.duration/2)<.1;});
  console.log('PASS: registered skill video loads, plays and seeks through its actual storage URL.');
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve=>server.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
}
