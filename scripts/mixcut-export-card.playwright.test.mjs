// 真导出组件 + 真 CSS + H.264/AAC，隔离验证成片卡片、播放/重试和窗口尺寸。
// Run: node scripts/mixcut-export-card.playwright.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire, register } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { chromium, webkit } from 'playwright';

register('./typescript-extension-loader.mjs', import.meta.url);
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
const { fileResponse } = await import('../lib/media-core/file-response.ts');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixcut-export-card-'));
const modules = new Map();
const styles = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    const parsed = postcss.parse(raw);
    parsed.walkRules(rule => {
      const globals = [];
      rule.selector = rule.selector.replace(/:global\(([^)]+)\)/g, (_, value) => {
        globals.push(value); return `GLOBAL${globals.length - 1}`;
      }).replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.test${entry.id}_${name}`)
        .replace(/GLOBAL(\d+)/g, (_, index) => globals[Number(index)]);
    });
    styles.push(parsed.toString());
    entry.source = 'module.exports=' + JSON.stringify(Object.fromEntries(
      [...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => [match[1], `test${entry.id}_${match[1]}`]),
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
    const resolved = local && ['', '.ts', '.tsx', '.js', '.css'].map(ext => local + ext)
      .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}
const exportId = bundle(path.join(root, 'components/mixcut/ExportStep.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}),ExportStep=load(${exportId}).ExportStep,noop=()=>{};
const packaged=new URLSearchParams(location.search).has('packaged');
const group={id:'group',revision:1,totalDurationUs:4000000,narrationDurationUs:4000000,
 script:{title:'验收成片',narrationConfig:{voice:'验收音色'}},subtitleCues:[{text:'测试'}],packaging:{enabled:packaged,template:'overlay-poster'},
 variants:[{id:'variant',indexNum:1,outputPreset:'3x4',revision:1,timeline:{clips:[{}]},issues:[],cover:{coverKey:'cover'},bgm:{trackId:null}}],
 jobs:[{id:'render',variantId:'variant',kind:'render',status:'succeeded',renderRevision:{groupRevision:1,variantRevision:1}}]};
const output={videoFilename:'成片.mp4',coverFilename:'封面.png',videoUrl:'/api/final-edit-jobs/render/video',videoDownloadUrl:'/download',coverUrl:'/cover.png',coverDownloadUrl:'/cover.png?download=1',packagingDeferred:packaged,packagingJobId:'packaged'};
window.fetch=async url=>{const name=new URL(url,location.origin).pathname;
 const value=name.endsWith('/capabilities')?{revealInFolder:false}:name.endsWith('/groups/group')?group:name.endsWith('/packaged')?{id:'packaged',status:'succeeded',output:{videoFilename:'成片.mp4',videoUrl:'/api/final-edit-jobs/packaged/video',videoDownloadUrl:'/download'}}:{id:'render',variantId:'variant',status:'succeeded',phase:'succeeded',progress:1,output};
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});};
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(ExportStep,{project:{id:'project',name:'验收项目',productCode:'TEST',taskDate:'20261111'},group,initialVariantId:'variant',active:true,onBack:noop,onGroupChange:noop,onProjectInfoChange:noop}));
`;
let server, browser;
let mediaRequests = 0;
try {
  // 组件验收只需扫描组件中的 utility；不扫描仓库的原型、历史文档和本地产物。
  const css = (await postcss([tailwind({ base: path.join(root, 'components') })]).process(
    fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8').replace(/@theme\s*\{/g, '@theme static {'),
    { from: path.join(root, 'app/globals.css') },
  )).css;
  const videoPath = path.join(temp, 'film.mp4');
  const encoded = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=300x400:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', videoPath],
  { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(encoded.status, 0, encoded.stderr);
  const cover = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#5c8cbd' } }).png().toBuffer();
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); }
    else if (pathname === '/cover.png') { res.setHeader('Content-Type', 'image/png'); res.end(cover); }
    else if (/^\/fonts\/[\w.-]+\.woff2$/.test(pathname)) {
      res.setHeader('Content-Type', 'font/woff2');
      res.end(fs.readFileSync(path.join(root, 'public', pathname)));
    }
    else if (pathname.endsWith('/video')) {
      mediaRequests++;
      const response = fileResponse(new Request('http://localhost' + req.url, { headers: req.headers }), videoPath, 'video/mp4', { cacheControl: 'private, no-store' });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><style>${css}\n${styles.join('\n')}#root{display:flex;flex-direction:column;height:100dvh;max-width:1100px;margin:auto;padding:16px}body{margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch({ headless: true });
    for (const packaged of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const before = mediaRequests;
      await page.goto(`http://127.0.0.1:${server.address().port}/${packaged ? '?packaged=1' : ''}`);
      const card = page.getByRole('button', { name: '打开成片预览' });
      await card.waitFor();
      assert.equal(await card.locator('video').count(), 0);
      assert.equal(mediaRequests, before, '点卡片前不预加载成片');
      await card.click();
      const dialog = page.getByTestId('film-preview-dialog');
      const video = dialog.locator('video');
      assert.equal(await video.getAttribute('src'), `/api/final-edit-jobs/${packaged ? 'packaged' : 'render'}/video`);
      assert.equal(await video.evaluate(video => video.muted), false);
      if (engineName === 'chromium') {
        await dialog.getByRole('button', { name: '播放预览' }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="film-preview-stage"] video')?.currentTime > 0.25);
        await page.keyboard.press(' ');
        await page.waitForFunction(() => document.querySelector('[data-testid="film-preview-stage"] video')?.paused);
        const bar = await dialog.getByRole('slider').boundingBox();
        await page.mouse.click(bar.x + bar.width * 0.6, bar.y + bar.height / 2);
        await page.waitForFunction(() => document.querySelector('[data-testid="film-preview-stage"] video')?.currentTime > 2);
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      if (engineName === 'chromium' && packaged) {
        const pattern = '**/api/final-edit-jobs/packaged/video';
        const unavailable = route => route.fulfill({ status: 503, body: 'fixture unavailable' });
        await page.route(pattern, unavailable);
        await card.click();
        await dialog.getByRole('alert').waitFor();
        await page.unroute(pattern, unavailable);
        await dialog.getByRole('button', { name: '重试预览' }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="film-preview-stage"] video')?.currentTime > 0.25);
        await video.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="film-preview-stage"] video')?.paused);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
      }
      for (const viewport of [{ width: 1536, height: 864 }, { width: 1280, height: 720 }, { width: 1024, height: 720 }]) {
        await page.setViewportSize(viewport);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await card.scrollIntoViewIfNeeded();
          const rect = await card.boundingBox();
          assert.ok(rect.width <= 280 && Math.abs(rect.width / rect.height - 0.75) < 0.02, `${engineName}/${viewport.width}/${theme}: 3:4 卡片`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
          if (packaged && process.env.MIXCUT_EXPORT_EVIDENCE_DIR) {
            fs.mkdirSync(process.env.MIXCUT_EXPORT_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.MIXCUT_EXPORT_EVIDENCE_DIR, `card-${engineName}-${viewport.width}-${theme}.png`) });
          }
          await card.click();
          await page.waitForFunction(() => {
            const rect = document.querySelector('[data-testid="film-preview-stage"]')?.getBoundingClientRect();
            return rect && rect.width >= 200 && rect.height >= 260 && rect.right <= innerWidth && rect.bottom <= innerHeight
              && Math.abs(rect.width / rect.height - 0.75) < 0.02;
          });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    await browser.close(); browser = null;
  }
  console.log('PASS: exported/packaged cards; decoded playback, seek and retry; Chromium/WebKit × 3 sizes × 2 themes');
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
