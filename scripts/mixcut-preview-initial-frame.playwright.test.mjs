// Real preview component + decoded H.264, isolated from the app and user data.
// Run: node scripts/mixcut-preview-initial-frame.playwright.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire, register } from 'node:module';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixcut-initial-frame-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = temp;
process.env.CREATIVE_STUDIO_MEDIA_CONCURRENCY = '1';
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
register('./typescript-extension-loader.mjs', import.meta.url);
const { ensureBrowserPreview, BrowserPreviewPendingError } = await import('../lib/video-browser-preview.ts');
const { fileResponse } = await import('../lib/media-core/file-response.ts');
const { withMediaResource } = await import('../lib/media-core/media-resource-gate.ts');
const { setExecutionModuleRuntime, clearExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { closeDb } = await import('../lib/db.ts');
const modules = new Map();
const styles = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    styles.push(raw);
    entry.source = 'module.exports = ' + JSON.stringify(Object.fromEntries(
      [...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => [match[1], match[1]]),
    ));
    return entry.id;
  }
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText : raw;
  const require = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2))
      : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}
const previewId = bundle(path.join(root, 'components/final-edit/FinalEditPreview.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if(cache[id]) return cache[id].exports; const m=cache[id]={exports:{}}; const [fn,deps]=modules[id]; fn(r=>load(deps[r]),m,m.exports); return m.exports; }
const React=load(${reactId}), Preview=load(${previewId}).FinalEditPreview;
const group = {id:'group',script:{narrationConfig:{playbackRate:1,gainDb:0}},narrationDurationUs:4000000,subtitleCues:[],coverTitle:{enabled:false},textStyles:{'3x4':{}}};
const asset = {videoJobId:'a',previewUrl:location.search.includes('busy-server')?'/ready.mp4?preview=1':'/video.mp4?preview=1'};
const variant = {id:'variant',outputPreset:'3x4',timeline:{bodyFrames:96,clips:[{id:'clip',videoJobId:'a',sourceInFrame:12,sourceOutFrame:108,timelineInFrame:0,timelineOutFrame:96,framing:{scale:1,offsetX:0,offsetY:0}}]},bgm:{trackId:null,gainDb:-16,fadeInSec:0,fadeOutSec:.8},cover:{sourceUrl:null}};
function App(){const [time,setTime]=React.useState(0); return React.createElement(React.Fragment,null,
 React.createElement('button',{onClick:()=>setTime(1.54)},'选择视频片段'),
 React.createElement(Preview,{group,variant,assets:[asset],selectedAsset:null,playheadSec:time,active:true,textTarget:null,onPlayheadChange:setTime,onTextPositionChange:()=>{}}));}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
let server, browser;
let videoRequests = 0;
let stallVideo = false;
const readyResponses = [];
try {
  const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=24:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(temp, 'video.mp4')], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const video = fs.readFileSync(path.join(temp, 'video.mp4'));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/ready.mp4')) {
      // Exercise the real preview/Range path while a production render holds the media slot.
      try {
        const served = await ensureBrowserPreview(path.join(temp, 'video.mp4'));
        const response = fileResponse(new Request(`http://localhost${req.url}`, { headers: req.headers }), served, 'video/mp4', { cacheControl: 'private, no-store' });
        readyResponses.push(response.status);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        Readable.fromWeb(response.body).pipe(res);
      } catch (error) {
        const status = error instanceof BrowserPreviewPendingError ? 202 : 500;
        readyResponses.push(status);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: status === 202 ? 'preview_pending' : 'preview_failed', retryAfterMs: 100 }));
      }
    } else if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script); }
    else if (req.url.startsWith('/video.mp4')) {
      if (stallVideo) return; // 真正挂起媒体请求，不产生 error/loadeddata。
      // A busy server returns this while the browser preview is being prepared.
      if (++videoRequests <= 2) {
        res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'preview_pending', retryAfterMs: 100 }));
      } else {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
        const body = video.subarray(start, end + 1);
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': body.length,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}),
        });
        res.end(body);
      }
    } else if (new URL(req.url, 'http://localhost').pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><style>body{margin:0}.previewColumn{width:500px}${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.clock.install();
  await page.addInitScript(() => {
    window.mediaEvents = [];
    for (const type of ['error', 'loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'emptied']) document.addEventListener(type, event => {
      if (event.target.tagName === 'VIDEO' && window.mediaEvents.length < 30) window.mediaEvents.push({ type, time: event.target.currentTime, ready: event.target.readyState });
    }, true);
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '选择视频片段', exact: true }).click();
  // Canvas must contain the decoded red source on first entry, without playback or remount.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas:not([aria-label]):not(.previewCanvas)');
    const pixel = canvas?.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return pixel && pixel[0] > 150 && pixel[1] < 80 && pixel[3] === 255;
  }, undefined, { timeout: 5000 }).catch(async error => {
    console.log(JSON.stringify({ videoRequests, media: await page.evaluate(() => window.mediaEvents), videos: await page.locator('video').evaluateAll(videos => videos.map(video => ({ ready: video.readyState, time: video.currentTime, error: video.error?.message }))) }));
    throw error;
  });
  const sourceTime = await page.locator('video').first().evaluate(video => video.currentTime);
  assert.ok(Math.abs(sourceTime - 28 / 24) < 1 / 24, `恢复后必须停在用户选中的时间点，实际 ${sourceTime}`);
  // 同一视频已成功加载过，再触发恢复；load() 不能把选中的时间点丢回 0。
  const previousRequests = videoRequests;
  await page.locator('video').first().evaluate(video => video.dispatchEvent(new Event('error')));
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await page.waitForFunction(() => window.mediaEvents.filter(e => e.type === 'emptied').length >= 2, undefined, { timeout: 5000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - 28 / 24) < 1 / 24;
  }, undefined, { timeout: 5000 });
  assert.ok(videoRequests > previousRequests);

  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.getAttribute('aria-label') === '成片预览');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  // 旧轻客户端拒绝原生全屏时，仍须展开到窗口大小，可通过 Esc 恢复。
  await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('permission denied')); });
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor({ timeout: 3000 });
  const fullscreenBox = await page.getByRole('main', { name: '成片预览' }).boundingBox();
  assert.ok(fullscreenBox.width >= 1200 && fullscreenBox.height >= 700, '拒绝原生全屏也应铺满窗口');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '全屏预览', exact: true }).waitFor();
  stallVideo = true;
  const stalledRequest = page.waitForRequest(request => request.url().includes('/video.mp4'));
  await page.locator('video').first().evaluate(video => { video.src = '/video.mp4?stalled=1'; video.load(); });
  await stalledRequest;
  await page.getByText('视频预览准备中…', { exact: true }).waitFor();
  await page.clock.runFor(121_000);
  await page.getByRole('button', { name: '重试预览', exact: true }).waitFor({ timeout: 3000 });
  stallVideo = false;
  await page.getByRole('button', { name: '重试预览', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - 28 / 24) < 1 / 24;
  }, undefined, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await page.close();

  // A previously playable H.264 source must stay viewable during unrelated rendering.
  assert.equal(await ensureBrowserPreview(path.join(temp, 'video.mp4')), path.join(temp, 'video.mp4'));
  setExecutionModuleRuntime({ instanceId: 'preview-test', fence: 1, facade: {} });
  let release;
  const occupied = withMediaResource({ taskId: 'unrelated-render', wait: true }, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const busyPage = await browser.newPage();
  const started = performance.now();
  try {
    await busyPage.goto(`http://127.0.0.1:${server.address().port}/?busy-server=1`, { waitUntil: 'domcontentloaded' });
    await busyPage.getByRole('button', { name: '选择视频片段', exact: true }).click();
    await busyPage.waitForFunction(() => {
      const canvas = document.querySelector('canvas:not([aria-label]):not(.previewCanvas)');
      const pixel = canvas?.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return pixel && pixel[0] > 150 && pixel[1] < 80 && pixel[3] === 255;
    }, undefined, { timeout: 2500 }).catch(error => {
      console.error(JSON.stringify({ scenario: 'playable-preview-during-render', responses: readyResponses, firstFrameMs: Math.round(performance.now() - started), result: 'no decoded frame' }));
      throw error;
    });
    assert.ok(readyResponses.every(status => status === 206 || status === 200));
    console.log(`PASS: decoded frame during occupied media slot in ${Math.round(performance.now() - started)}ms`);
  } finally {
    release();
    await occupied;
    clearExecutionModuleRuntime();
    await busyPage.close();
  }
  console.log('PASS: decoded initial/recovered frame, fullscreen fallback, bounded retry and busy-server preview');
} finally {
  clearExecutionModuleRuntime();
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
}
