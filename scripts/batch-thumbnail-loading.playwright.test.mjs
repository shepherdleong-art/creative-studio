// node scripts/batch-thumbnail-loading.playwright.test.mjs
// Real asset cards and browser connections: slow thumbnails must not starve video.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { chromium, expect } from '@playwright/test';
const root = process.cwd(), modules = new Map(), styles = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    styles.push(raw);
    entry.source = 'module.exports=' + JSON.stringify(Object.fromEntries([...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => [m[1], m[1]])));
    return entry.id;
  }
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText : raw;
  const require = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2)) : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}
const cards = bundle(path.join(root, 'components/batch-production/BatchInputSelectionCards.tsx'));
const require = createRequire(import.meta.url), react = bundle(require.resolve('react')), dom = bundle(require.resolve('react-dom/client'));
const script = `const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const[fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${react}),Card=load(${cards}).BatchAssetSelectionCard;
function App(){const[preview,setPreview]=React.useState(false),[visible,setVisible]=React.useState(true),[generation,setGeneration]=React.useState(0);
window.showCards=()=>{setGeneration(v=>v+1);setVisible(true)};window.hideCards=()=>setVisible(false);
return React.createElement(React.Fragment,null,preview&&React.createElement('video',{src:'/preview.mp4',muted:true,autoPlay:true,style:{position:'fixed',right:0,bottom:0,width:100}}),visible&&React.createElement('div',{id:'cards'},Array.from({length:24},(_,i)=>React.createElement(Card,{key:i,asset:{id:String(i),status:'online',media:{displayName:'素材 '+i,durationSec:2},sources:[],currentAnalysisId:'analysis',analysisLevel:'content',thumbnailUrl:'/thumbnail?generation='+generation+'&id='+i,previewUrl:'/preview.mp4'},selected:false,onSelectedChange:()=>{},onPreview:()=>setPreview(true)}))));}
load(${dom}).createRoot(document.getElementById('root')).render(React.createElement(App));`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-thumbnails-'));
const pending = new Set(), requests = [], errors = [];
let server, browser, releaseThumbnails = false;
try {
  const file = path.join(temp, 'preview.mp4');
  const rendered = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=lime:s=96x96:r=24:d=2', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(rendered.status, 0, rendered.error?.message || rendered.stderr);
  const video = fs.readFileSync(file), jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const sendThumbnail = res => { if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpeg); };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
    if (url.pathname === '/thumbnail') {
      requests.push(url.search); pending.add(res); res.on('close', () => pending.delete(res));
      if (releaseThumbnails) sendThumbnail(res);
      return;
    }
    if (url.pathname === '/preview.mp4') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ''), start = Number(range?.[1] ?? 0), end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) }).end(video.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(`<html><head><style>${styles.join('\n')}body{margin:0}#cards{display:grid;grid-template-columns:repeat(6,150px);gap:4px}.body{display:none}.preview{height:90px;aspect-ratio:auto}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => pending.size).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '预览素材 素材 0', exact: true }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    if (!video || video.readyState < 2) return false;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[1] > 240;
  }, null, { timeout: 2000 });
  assert.ok(requests.length <= 2, `Thumbnail traffic must leave connections for video; started ${requests.length}`);
  console.log('PASS: held thumbnail requests leave the real video frame available');
  await page.evaluate(() => window.hideCards());
  await expect.poll(() => pending.size).toBe(0);
  const cancelledCount = requests.length;
  await page.evaluate(() => window.showCards());
  await expect.poll(() => pending.size).toBe(2);
  assert.equal(requests.length, cancelledCount + 2, 'Unmounted queued thumbnails must not start later');
  assert.ok(requests.slice(cancelledCount).every(query => query.includes('generation=1')), 'Remount uses fresh source URLs');
  releaseThumbnails = true;
  for (const res of pending) sendThumbnail(res);
  await page.waitForFunction(() => [...document.querySelectorAll('#cards img')].length === 24 && [...document.querySelectorAll('#cards img')].every(img => img.complete && img.naturalWidth === 4));
  assert.deepEqual(errors, []);
  console.log('PASS: leaving preparation cancels active/queued thumbnails; remount loads every visible card');
} finally {
  await browser?.close();
  for (const res of pending) res.destroy();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
