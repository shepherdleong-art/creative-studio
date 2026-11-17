// Run: node scripts/batch-packaging-preview-stability.playwright.test.mjs
// Real batch preview dock, video, packaging templates and pointer gestures; no user data or app service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';
import { packagingPreviewHtml } from '../lib/media-core/packaging-preview.ts';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-packaging-stability-'));
const modules = new Map();
const styles = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    styles.push(raw.replace(/:global\(([^)]+)\)/g, '$1'));
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
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}

const dockId = bundle(path.join(root, 'components/batch-production/review/BatchReviewPreviewDock.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const initialView = {
  planId: 'one', outputVersionId: 'version', editRevision: 0, editable: true,
  clips: [{ clipId: 'clip', assetId: 'asset', sourceStartUs: 0, sourceEndUs: 6000000, timelineStartUs: 0, timelineEndUs: 6000000 }],
  visualDurationUs: 6000000, coverAssetId: 'asset', coverTimeUs: 0, coverFraming: null, coverTitle: null,
  subtitleCues: [], narration: { durationUs: 6000000 }, music: { trackId: null }, musicLibrary: [],
  packaging: { enabled: true, template: 'overlay-poster', varsOverrides: {}, pointCuesMode: 'timed', pointCues: [{ id: 'point', text: '四种宽度', startSec: 1, endSec: 5 }] },
};
let savedView = structuredClone(initialView);
let failNextSave = false;
const requests = [];
const edits = [];
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}),Dock=load(${dockId}).default;
const assets=[{assetId:'asset',displayName:'测试视频',durationSec:6,previewUrl:'/source.mp4'}];
const initialView=__INITIAL_VIEW__;
function App(){
  const [view,setView]=React.useState(initialView),[time,setTime]=React.useState(2);
  window.view=view;
  window.seek=setTime;
  window.refreshView=async(patch)=>{
    const response=await fetch('/fixture-update',{method:'POST',body:JSON.stringify(patch)});
    setView(await response.json());
  };
  const save=async(plan,edit)=>{
    const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(edit)});
    if(!response.ok)return false;
    setView(await response.json());return true;
  };
  return React.createElement('div',{style:{width:800,height:640}},React.createElement(Dock,{
    projectId:'test',batchId:'test',outputPreset:'3x4',packagingEditable:true,
    previewFilm:{planId:'one',seq:1,scriptTitle:'卖点位置测试',durationSec:6,approvable:true,arrangement:view},
    previewAsset:null,onClearPreviewAsset:()=>{},playheadSec:time,onSeek:setTime,poolAssets:assets,onSourceApply:save
  }));
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;

let server;
let browser;
try {
  const mediaFile = path.join(temp, 'source.mp4');
  const generated = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=96x128:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], { windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0, generated.error?.message || generated.stderr?.toString());
  const media = fs.readFileSync(mediaFile);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script.replace('__INITIAL_VIEW__', JSON.stringify(savedView))); return; }
    if (url.pathname === '/save') {
      let body = ''; for await (const chunk of req) body += chunk;
      const edit = JSON.parse(body); edits.push(edit);
      assert.equal(edit.expectedEditRevision, savedView.editRevision);
      assert.equal(edit.expectedOutputVersionId, savedView.outputVersionId);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (failNextSave) { failNextSave = false; res.writeHead(409).end(); return; }
      savedView = { ...savedView, editRevision: savedView.editRevision + 1, packaging: edit.config };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(savedView)); return;
    }
    if (url.pathname === '/fixture-update') {
      let body = ''; for await (const chunk of req) body += chunk;
      savedView = { ...savedView, ...JSON.parse(body), editRevision: savedView.editRevision + 1 };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(savedView)); return;
    }
    if (url.pathname.endsWith('/packaging-preview')) {
      requests.push(url.search);
      // A short local response delay makes an unwanted document reload observable.
      await new Promise(resolve => setTimeout(resolve, 80));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(packagingPreviewHtml({ config: savedView.packaging, vars: { title: '标题', subtitle: '副标题', point1: '', point2: '', point3: '', ...savedView.packaging.varsOverrides }, totalSec: 6 + 20 / 24, coverSec: 20 / 24, edit: true })); return;
    }
    if (url.pathname.startsWith('/api/packaging/templates/')) {
      const relative = decodeURIComponent(url.pathname).replace('/api/packaging/templates/', '');
      let file = path.resolve(root, 'packaging/templates', relative);
      if (!file.startsWith(path.join(root, 'packaging/templates') + path.sep)) { res.writeHead(404).end(); return; }
      if (!fs.existsSync(file) && relative.includes('/fonts/')) file = path.join(root, 'packaging/fonts', relative.split('/fonts/')[1]);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf' })[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file)); return;
    }
    if (url.pathname === '/source.mp4' || url.pathname.endsWith('/preview')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) });
      res.end(media.subarray(start, end + 1)); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><meta charset="utf-8"><style>${styles.join('\n')}body{margin:0}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.h-full{height:100%}.w-full{width:100%}.h-px{height:1px}.w-px{width:1px}.opacity-0{opacity:0}.border-0{border:0}.sr-only{display:none}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const overlay = page.frameLocator('iframe');
  const point = overlay.locator('[data-point-id="cue:point"]');
  const ready = () => page.waitForFunction(() => {
    const win = document.querySelector('iframe')?.contentWindow;
    return win?.__editMode?.active && win?.__timelines?.overlay?.time() > 2 && win.document.readyState === 'complete';
  });
  const frameState = () => page.evaluate(() => ({
    sameFrame: window.originalFrame === document.querySelector('iframe'),
    sameDocument: window.originalDocument === document.querySelector('iframe')?.contentDocument,
    sameVideo: window.originalVideo === document.querySelector('video'),
  }));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const drag = async (target, dx, dy, duringDrag, heightFraction = 0.5) => {
    const box = await target.boundingBox(); assert.ok(box);
    const count = edits.length;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * heightFraction);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height * heightFraction + dy, { steps: 8 });
    if (duringDrag) await duringDrag();
    assert.equal(edits.length, count, '拖动中不保存');
    await page.mouse.up();
  };
  const refresh = async (patch) => {
    const revision = savedView.editRevision;
    await page.evaluate(patch => window.refreshView(patch), patch);
    await page.waitForFunction(revision => window.view.editRevision > revision, revision);
    await settle();
  };
  const assertPosition = async (target, expected, label) => {
    const current = await target.boundingBox();
    for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(current[field] - expected[field]) < 1.5, `${label} ${field}: ${current[field]} / ${expected[field]}`);
  };
  const templateFilter = process.argv.find(arg => arg.startsWith('--template='))?.slice('--template='.length);
  const templates = ['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'].filter(template => !templateFilter || templateFilter === template);
  assert.ok(templates.length, '模板参数必须是内置模板 ID');
  for (const template of templates) {
    savedView = structuredClone(initialView);
    savedView.packaging.template = template;
    requests.length = 0; edits.length = 0;
    await page.goto(`${origin}/?template=${template}`);
    await point.waitFor(); await ready();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-media-frame] > canvas');
      return canvas?.getContext('2d')?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[2] > 150;
    });
    const defaultPosition = await point.boundingBox();
    if (template === 'overlay-variety') {
      // The legacy f4 cover's invisible subtitle overlaps its default body cue hit area.
      // Use a saved cue position outside that overlap to exercise the real drag/reload path.
      await refresh({ packaging: { ...savedView.packaging, layouts: { [template]: { cues: { point: { x: 50, y: 65, scale: 1 } } } } } });
      await ready();
    }
    const initialRevision = savedView.editRevision;
    await page.evaluate(() => {
      window.originalFrame = document.querySelector('iframe');
      window.originalDocument = window.originalFrame.contentDocument;
      window.originalVideo = document.querySelector('video');
      window.samples = { frames: 0, missingPoints: 0, blankVideoFrames: 0 };
      const sample = () => {
        const win = document.querySelector('iframe')?.contentWindow;
        const point = win?.document.querySelector('[data-point-id="cue:point"]');
        const css = point && win.getComputedStyle(point);
        window.samples.frames++;
        if (!css || css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) < 0.1) window.samples.missingPoints++;
        const canvas = document.querySelector('[data-media-frame] > canvas');
        if (!canvas || canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[2] < 150) window.samples.blankVideoFrames++;
        window.sampleRaf = requestAnimationFrame(sample);
      };
      window.sampleRaf = requestAnimationFrame(sample);
    });
    const before = await point.boundingBox();
    const requestCount = requests.length;
    await drag(point, 30, 35);
    await page.waitForFunction(revision => window.view.editRevision === revision + 1, initialRevision);
    await ready(); await settle();
    assert.equal(edits.length, 1, '一次拖动只保存一次');
    const state = await frameState();
    console.log(JSON.stringify({ template, afterDrag: state, previewRequestsBefore: requestCount, previewRequestsAfter: requests.length }));
    assert.equal(state.sameFrame && state.sameDocument, true, '调整卖点位置并保存后必须保留包装文档，不能卸载/重新加载造成闪屏');
    assert.equal(requests.length, requestCount, '纯版式修改不重新请求包装 HTML');
    assert.equal(state.sameVideo, true, '保留底片播放器');
    const after = await point.boundingBox();
    assert.ok(after.x - before.x > 25 && after.y - before.y > 30, `保存后保持拖动的新位置：${JSON.stringify({ template, before, after, layout: savedView.packaging.layouts })}`);
    const firstConfig = structuredClone(savedView.packaging);

    // An unchanged polling response during a gesture must not overwrite the local drag.
    await drag(point, -15, 20, async () => {
      const dragging = await point.boundingBox();
      await refresh({});
      await assertPosition(point, dragging, '同内容轮询不打断拖动');
    });
    await page.waitForFunction(revision => window.view.editRevision === revision + 3, initialRevision);
    await ready(); await settle();
    const secondConfig = structuredClone(savedView.packaging);
    const secondPosition = await point.boundingBox();
    assert.equal(edits.length, 2, '连续拖动使用最新修订保存');

    // Undo/redo/reset arrive as authoritative arrangement snapshots, as in the review workspace.
    await refresh({ packaging: firstConfig });
    await assertPosition(point, after, '撤销还原位置');
    await refresh({ packaging: secondConfig });
    await assertPosition(point, secondPosition, '重做恢复位置');
    await refresh({ packaging: { ...secondConfig, layouts: {} } });
    await assertPosition(point, defaultPosition, '恢复默认版式');
    await refresh({ packaging: secondConfig });

    failNextSave = true;
    await drag(point, 20, -20);
    await page.getByRole('alert').getByText('包装修改未保存，请重试').waitFor();
    await ready(); await settle();
    await assertPosition(point, secondPosition, '保存失败回到已保存位置');
    assert.equal(requests.length, requestCount, '撤销、重做、复位与失败回滚均不重载');
    assert.deepEqual(await frameState(), { sameFrame: true, sameDocument: true, sameVideo: true });
    const samples = await page.evaluate(() => { cancelAnimationFrame(window.sampleRaf); return window.samples; });
    assert.ok(samples.frames > 10);
    assert.equal(samples.missingPoints, 0, '每帧采样：调整及保存期间卖点不能消失');
    assert.equal(samples.blankVideoFrames, 0, '每帧采样：底片不能闪黑');

    for (const [handleTitle, dx, dy, field] of [['拖拽缩放', 20, 15, 'scale'], ['拖拽旋转', 20, 10, 'rotate']]) {
      const revision = savedView.editRevision;
      const previous = savedView.packaging.layouts[template].cues.point[field] ?? 0;
      await point.click({ force: true });
      await drag(overlay.getByTitle(handleTitle, { exact: true }), dx, dy);
      await page.waitForFunction(revision => window.view.editRevision > revision, revision);
      await ready(); await settle();
      assert.notEqual(savedView.packaging.layouts[template].cues.point[field], previous, `${handleTitle} 必须保存真实变化`);
      assert.deepEqual(await frameState(), { sameFrame: true, sameDocument: true, sameVideo: true });
    }
    assert.equal(requests.length, requestCount, '缩放和旋转同样不重载');

    // A real text edit still regenerates the document and returns to the same playhead.
    const revision = savedView.editRevision;
    await point.dblclick({ force: true });
    await page.getByPlaceholder('卖点文字不能为空').fill('四种宽度任选');
    await page.getByPlaceholder('卖点文字不能为空').press('Enter');
    await page.waitForFunction(revision => window.view.editRevision > revision, revision);
    await point.getByText('四种宽度任选', { exact: true }).waitFor();
    await ready();
    assert.equal(requests.length, requestCount + 1, '改文案后重新生成实际包装内容');
    assert.equal((await frameState()).sameVideo, true);
    const savedPosition = await point.boundingBox();
    await page.reload(); await ready();
    await assertPosition(point, savedPosition, '刷新后保持已保存位置');

    // The same live-layout sync also handles the cover title, including returning to automatic fit.
    await page.evaluate(() => window.seek(0.4 - 20 / 24));
    await page.waitForFunction(() => Math.abs(document.querySelector('iframe').contentWindow.__timelines.overlay.time() - 0.4) < 0.001);
    await settle();
    const title = overlay.locator('[data-point-id="cover:title"]');
    const titleBefore = await title.boundingBox();
    const coverRequests = requests.length;
    const coverRevision = savedView.editRevision;
    // f4's subtitle overlaps the title's bounding-box center; grab the upper title text.
    await drag(title, 15, 20, undefined, 0.2);
    await page.waitForFunction(revision => window.view.editRevision > revision, coverRevision);
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow.__editMode.active);
    await settle();
    const titleAfter = await title.boundingBox();
    assert.ok(titleAfter.y - titleBefore.y > 15, `封面标题保存拖动位置：${JSON.stringify({ template, before: titleBefore, after: titleAfter, layout: savedView.packaging.layouts[template] })}`);
    const coverConfig = structuredClone(savedView.packaging);
    delete coverConfig.layouts[template].cover;
    await refresh({ packaging: coverConfig });
    await assertPosition(title, titleBefore, '封面标题恢复默认排版');
    assert.equal(requests.length, coverRequests, '封面版式保存和复位不重载');
    console.log(`PASS: ${template} drag/scale/rotate, polling, undo/redo/reset, failed save, text refresh, reload persistence, cover layouts; ${samples.frames} sampled frames, zero disappearing points/blank video frames`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
