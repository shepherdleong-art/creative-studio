// Run: node scripts/batch-preview-edits.playwright.test.mjs
// Real batch preview + H.264; isolated from user projects and app services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';
import ffmpeg from 'ffmpeg-static';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preview-edits-'));
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

const previewId = bundle(path.join(root, 'components/batch-production/BatchTimelinePreview.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if(cache[id]) return cache[id].exports; const m=cache[id]={exports:{}}; const [fn,deps]=modules[id]; fn(r=>load(deps[r]),m,m.exports); return m.exports; }
const React=load(${reactId}), Preview=load(${previewId}).default;
const intro = 20 / 24;
const assets = Object.fromEntries(['red','blue','pending','missing','cover-pending'].map(id => [id, {previewUrl:'/'+id+'.mp4',originalUrl:'/'+id+'.mp4'}]));
function App() {
  const [time,setTime]=React.useState(intro+.5);
  const [assetId,setAssetId]=React.useState('red');
  const [sourceStartUs,setSourceStartUs]=React.useState(0);
  const [coverId,setCoverId]=React.useState('red');
  const clips=[
    {clipId:'same-clip',assetId,sourceStartUs,sourceEndUs:sourceStartUs+1000000,timelineStartUs:0,timelineEndUs:1000000},
    {clipId:'next-clip',assetId:'red',sourceStartUs:0,sourceEndUs:1000000,timelineStartUs:2000000,timelineEndUs:3000000}
  ];
  const button = (text, action) => React.createElement('button',{onClick:action},text);
  return React.createElement(React.Fragment,null,
    button('Replace blue',()=>setAssetId('blue')),
    button('Replace red',()=>setAssetId('red')),
    button('Trim clip',()=>setSourceStartUs(1000000)),
    button('Replace pending',()=>setAssetId('pending')),
    button('Replace missing',()=>setAssetId('missing')),
    button('Show gap',()=>setTime(intro+1.5)),
    button('Show body',()=>setTime(intro+.5)),
    button('Show cover',()=>setTime(0)),
    button('Cover blue',()=>setCoverId('blue')),
    button('Cover pending',()=>setCoverId('cover-pending')),
    React.createElement(Preview,{
      clips,assetsById:assets,preserveGaps:true,coverUrl:null,
      coverDraft:{asset:{assetId:coverId,displayName:coverId,previewUrl:assets[coverId].previewUrl},timeUs:750000,title:null,framing:null},
      subtitleCues:[],narrationUrl:null,narrationGainDb:0,bgm:null,
      outputPreset:'3x4',playheadSec:time,onSeek:setTime,active:true
    })
  );
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
let server;
let browser;
const requests = new Map();
const media = new Map();
const errors = [];
const pendingKinds = new Set(['pending', 'cover-pending']);
const framePixel = () => {
  const canvas = document.querySelector('[data-media-frame] > canvas');
  return canvas ? Array.from(canvas.getContext('2d').getImageData(canvas.width/2,canvas.height/2,1,1).data) : null;
};
async function expectColor(page, color) {
  await page.waitForFunction(({ color }) => {
    const canvas = document.querySelector('[data-media-frame] > canvas');
    const p = canvas?.getContext('2d')?.getImageData(canvas.width/2,canvas.height/2,1,1).data;
    return p && p[color === 'red' ? 0 : 2] > 150 && p[1] < 70 && p[color === 'red' ? 2 : 0] < 70;
  }, { color }, { timeout: 5000 }).catch(async error => {
    console.log(JSON.stringify({expected:color,pixel:await page.evaluate(framePixel),requests:Object.fromEntries(requests),videos:await page.locator('video').evaluateAll(videos=>videos.map(v=>({src:v.currentSrc,ready:v.readyState,time:v.currentTime,error:v.error?.code})))}));
    throw error;
  });
}
async function expectCover(page, color) {
  await page.waitForFunction(({ color }) => {
    const video = document.querySelector('[aria-label="封面实时预览"] video');
    if (!video || video.readyState < 2 || video.seeking) return false;
    const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0,1,1);
    const p=ctx.getImageData(0,0,1,1).data;
    return p[color === 'red' ? 0 : 2]>150 && p[1]<70 && p[color === 'red' ? 2 : 0]<70 && Math.abs(video.currentTime-.75)<1/24;
  }, { color }, { timeout: 5000 }).catch(async error => {
    console.log(JSON.stringify({cover:color,requests:Object.fromEntries(requests),videos:await page.locator('video').evaluateAll(videos=>videos.map(v=>({label:v.getAttribute('aria-label'),src:v.currentSrc,ready:v.readyState,time:v.currentTime,seeking:v.seeking,error:v.error?.code})))}));
    throw error;
  });
}
try {
  for (const color of ['red', 'blue']) {
    const file = path.join(temp, `${color}.mp4`);
    const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=96x128:r=24:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    media.set(color, fs.readFileSync(file));
  }
  server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture.js') {res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(script);return;}
    const kind = url.pathname.slice(1).replace('.mp4','');
    if (url.pathname.endsWith('.mp4')) {
      const count=(requests.get(kind)??0)+1;requests.set(kind,count);
      if (kind === 'missing') {res.writeHead(404).end();return;}
      if (pendingKinds.has(kind) && count <= 2) {
        res.writeHead(202, {'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({error:'preview_pending',retryAfterMs:250}));return;
      }
      const video = media.get(pendingKinds.has(kind) ? 'blue' : kind);
      if (!video) {res.writeHead(404).end();return;}
      const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
      const start=range?Number(range[1]):0;
      const end=range?.[2]?Math.min(Number(range[2]),video.length-1):video.length-1;
      const body=video.subarray(start,end+1);
      res.writeHead(range?206:200, {'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':body.length,'Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${video.length}`}:{})});
      res.end(body);return;
    }
    if (url.pathname !== '/') {res.writeHead(404).end();return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<html><head><meta charset="utf-8"><style>${styles.join('\n')}body{margin:0}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.h-full{height:100%}.w-full{width:100%}.h-px{height:1px}.w-px{width:1px}.opacity-0{opacity:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for (const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    requests.clear();
    browser=await engine.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1024,height:720}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
    await expectColor(page,'red');
    await page.getByRole('button',{name:'Replace blue',exact:true}).click();
    await expectColor(page,'blue');
    await page.getByRole('button',{name:'Trim clip',exact:true}).click();
    await expectColor(page,'blue');
    await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-1.5)<1/24);
    await page.getByRole('button',{name:'Show gap',exact:true}).click();
    await page.waitForFunction(()=>{const c=document.querySelector('[data-media-frame] > canvas');const p=c.getContext('2d').getImageData(1,1,1,1).data;return p[0]===0&&p[1]===0&&p[2]===0;});
    await page.getByRole('button',{name:'Replace pending',exact:true}).click();
    await page.getByRole('button',{name:'Show body',exact:true}).click();
    await expectColor(page,'blue');
    await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-1.5)<1/24 && document.querySelector('video').readyState>=2,{},{timeout:5000});
    assert.ok(requests.get('pending')>=3,`${name}: pending media must recover without remount or playback`);
    await page.locator('video').first().evaluate(video=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Preview recovery did not reload the existing media element')),5000);
      video.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve();},{once:true});
      video.dispatchEvent(new Event('error'));
    }));
    await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-1.5)<1/24 && document.querySelector('video').readyState>=2);
    await page.getByRole('button',{name:'Show gap',exact:true}).click();
    await page.waitForFunction(()=>{const c=document.querySelector('[data-media-frame] > canvas');const p=c.getContext('2d').getImageData(1,1,1,1).data;return p[0]===0&&p[1]===0&&p[2]===0;});
    await page.getByRole('button',{name:'Show body',exact:true}).click();
    await expectColor(page,'blue');
    await page.getByRole('button',{name:'Replace missing',exact:true}).click();
    await page.getByRole('button',{name:'重试预览',exact:true}).waitFor({timeout:5000});
    await page.getByRole('button',{name:'Replace red',exact:true}).click();
    await expectColor(page,'red');
    assert.equal(await page.getByRole('button',{name:'重试预览',exact:true}).count(),0,'Old source failure must clear after changing clips');
    await page.getByRole('button',{name:'Show cover',exact:true}).click();
    await expectCover(page,'red');
    await page.getByRole('button',{name:'Cover blue',exact:true}).click();
    await expectCover(page,'blue');
    await page.getByRole('button',{name:'Cover pending',exact:true}).click();
    await expectCover(page,'blue');
    assert.ok(requests.get('cover-pending')>=3,`${name}: pending cover frames must recover`);
    await page.close();await browser.close();browser=null;
    console.log(`PASS: ${name} batch replace/trim, 202 recovery, seek position, real gaps, failure/retry and cover switching`);
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  await new Promise(resolve=>server?server.close(resolve):resolve());
  fs.rmSync(temp,{recursive:true,force:true});
}
