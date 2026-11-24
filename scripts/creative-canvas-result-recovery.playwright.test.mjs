// Real editor + nodes in an isolated browser; no app data or paid calls.
// Run: node scripts/creative-canvas-result-recovery.playwright.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { chromium, webkit } from '@playwright/test';
import { directSeedanceCapability } from '../lib/creative-canvas/adapters/seedance-capabilities.ts';
import { SEEDANCE_25 } from '../lib/video-providers/seedance-contract.ts';

const root = process.cwd(), modules = new Map();
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText : raw;
  const require = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2))
      : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext)
      .find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}
const require = createRequire(import.meta.url);
const editor = bundle(path.join(root, 'components/creative-canvas/editor-store.ts'));
const toasts = bundle(path.join(root, 'components/creative-canvas/canvas-toasts.tsx'));
const nodes = bundle(path.join(root, 'components/creative-canvas/nodes.tsx'));
const context = bundle(path.join(root, 'components/creative-canvas/node-context.ts'));
const flow = bundle(require.resolve('@xyflow/react'));
const react = bundle(require.resolve('react')), dom = bundle(require.resolve('react-dom/client'));
const capability = directSeedanceCapability(SEEDANCE_25);
const script = [
  "const process={env:{NODE_ENV:'production'}};",
  'const modules={' + [...modules.values()].map(m => m.id + ':[function(require,module,exports){' + m.source + '\n},' + JSON.stringify(m.deps) + ']').join(',') + '};',
  'const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const[fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}',
  'const React=load(' + react + '),h=React.createElement,{useCanvasEditor,buildCanvasGraph}=load(' + editor + '),{CanvasToastProvider}=load(' + toasts + ');',
  'const {ReactFlow,ReactFlowProvider,useReactFlow}=load(' + flow + '),{CanvasNodeContext}=load(' + context + '),{GenerationNode,MaterialNode}=load(' + nodes + ');',
  'const nodeTypes={"image-generation":GenerationNode,"video-generation":GenerationNode,material:MaterialNode};',
  'const capabilities=' + JSON.stringify([capability]) + ';',
  "function Editor(){const controller=useCanvasEditor('recovery');window.editor=controller;window.fit=useReactFlow().fitView;",
  'const graph=buildCanvasGraph(controller.nodes,controller.edges);',
  'const value={controller,graph,capabilities,renamingNodeId:null,finishRenaming:()=>{},resolveSourceAssetId:id=>controller.nodes.find(n=>n.id===id)?.data.assetId??controller.runtime.get(id)?.currentAssetId??null};',
  'return h(CanvasNodeContext.Provider,{value},h(ReactFlow,{nodes:controller.nodes,edges:controller.edges,nodeTypes,onNodesChange:controller.onNodesChange,fitView:true,onlyRenderVisibleElements:false}));}',
  "const app=load(" + dom + ").createRoot(document.getElementById('root'));",
  'window.showEditor=()=>app.render(h(CanvasToastProvider,null,h(ReactFlowProvider,null,h(Editor))));',
  "window.leaveEditor=()=>{window.editor=null;app.render(h('div',null,'其他菜单'));};",
  'window.showEditor();',
].join('\n');
const source = fs.readFileSync('app/globals.css', 'utf8').replace('@theme {', '@theme static {')
  .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../components/creative-canvas/*.tsx";');
const css = (await postcss([tailwind()]).process(source, { from: path.join(root, 'app/globals.css') })).css
  + fs.readFileSync('node_modules/@xyflow/react/dist/style.css', 'utf8');
const generator = { id: 'video', kind: 'video-generation', position: { x: 0, y: 0 }, data: {
  title: '视频生成', modelKey: capability.key, generationMode: 'text-to-video', prompt: 'test',
  parameters: { generationStage: 'draft', resolution: '480p' }, references: [], referenceLabelCounter: 0,
} };
let canvas, runs;
const presented = new Set();
function reset() {
  runs = [];
  presented.clear();
  canvas = {
    id: 'recovery', name: '结果恢复', graphRevision: 1,
    graph: { schemaVersion: 1, nodes: [structuredClone(generator)], edges: [] },
    nodeStates: [{ nodeId: 'video', nodeEpoch: 1, deleted: false, currentAssetId: null, activeTaskId: null }],
    tasks: [], nodeCandidates: [],
  };
}
reset();
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-result-browser-'));
const videoFile = path.join(fixtureDir, 'fixture.mp4');
const photo = path.join(root, 'public/brand/login-background.jpg');
execFileSync(ffmpeg, ['-y', '-loop', '1', '-i', photo, '-t', '1', '-vf', 'scale=120:160:force_original_aspect_ratio=increase,crop=120:160', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile], { stdio: 'ignore', timeout: 30_000 });
const videoBytes = fs.readFileSync(videoFile);
const tailImage = await sharp(photo).resize(640, 360).png().toBuffer();
const server = http.createServer(async (req, res) => {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/api/canvas/recovery/runs') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    runs.push(body);
    const state = canvas.nodeStates.find(s => s.nodeId === body.targetNodeId);
    state.activeTaskId = 'formal-task';
    canvas.tasks = [{ id: 'formal-task', nodeId: body.targetNodeId, phase: 'polling', variantIndex: 0 }];
    json({ tasks: canvas.tasks });
  } else if (req.url === '/api/canvas/recovery') {
    if (req.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.expectedGraphRevision !== canvas.graphRevision) { res.writeHead(409); json({ error: 'conflict' }); return; }
      canvas.graph = body.graph;
      canvas.graphRevision++;
      for (const node of canvas.graph.nodes) {
        if (!canvas.nodeStates.some(s => s.nodeId === node.id)) canvas.nodeStates.push({ nodeId: node.id, nodeEpoch: 1, deleted: false, currentAssetId: null, activeTaskId: null });
        if (node.kind === 'material' && node.data.assetId) presented.add(node.data.assetId);
      }
      for (const candidate of canvas.nodeCandidates) {
        candidate.materialized = presented.has(candidate.assetId);
        candidate.tailMaterialized = presented.has(candidate.tailAssetId);
      }
    }
    json({ canvas });
  } else if (req.url?.endsWith('/draft')) {
    const assetId = req.url.split('/').at(-2);
    json({ source: assetId === 'completed-while-away' ? {
      assetId, taskId: 'draft-task', capabilityKey: capability.key, generationMode: 'text-to-video',
      parameters: { durationSec: 15 }, expiresAt: new Date(Date.now() + 86400_000).toISOString(), expired: false,
    } : null, metadata: { stage: assetId === 'completed-while-away' ? 'draft' : 'final-from-draft' } });
  } else if (['/api/canvas/assets/tail-frame', '/api/canvas/assets/new-image'].includes(req.url)) {
    res.setHeader('Content-Type', 'image/png'); res.end(tailImage);
  } else if (req.url?.startsWith('/api/canvas/assets/')) {
    res.setHeader('Content-Type', 'video/mp4'); res.end(videoBytes);
  } else if (req.url === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script);
  } else if (req.url?.startsWith('/fonts/')) {
    const filename = path.join(root, 'public', req.url.split('?')[0]);
    if (fs.existsSync(filename)) res.end(fs.readFileSync(filename)); else { res.writeHead(404); res.end(); }
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><style>' + css + 'html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const evidenceDir = path.resolve(process.env.CANVAS_RESULT_EVIDENCE_DIR || 'outputs/04-测试与验收/2026-11-16-canvas-draft-fixes');
fs.mkdirSync(evidenceDir, { recursive: true });
async function until(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
try {
  for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) =>
    !process.env.CANVAS_BROWSER_ENGINES || process.env.CANVAS_BROWSER_ENGINES.split(',').includes(name))) {
    const browser = await browserType.launch({ headless: true, timeout: 20_000 });
    try {
      reset();
      const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
      page.setDefaultTimeout(10_000);
      const errors = [], layoutNotifications = [];
      page.on('pageerror', error => {
        // WebKit may defer one ResizeObserver batch during the forced viewport sweep.
        // Geometry still has to settle and pass every assertion below.
        if (error.message === 'ResizeObserver loop completed with undelivered notifications.') layoutNotifications.push(error.message);
        else errors.push(error.message);
      });
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      await page.evaluate(() => window.leaveEditor());
      await page.getByText('其他菜单').waitFor();
      canvas.nodeStates[0].currentAssetId = 'completed-while-away';
      canvas.nodeCandidates.push({ nodeId: 'video', taskId: 'draft-task', assetId: 'completed-while-away', variantIndex: 0, materialized: false, createdAt: new Date().toISOString() });
      await page.evaluate(() => window.showEditor());
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      assert.equal(await page.evaluate(() => window.editor.nodes.filter(n => n.data.assetId === 'completed-while-away').length), 1,
        '切换菜单期间完成的视频，返回后必须出现结果节点');
      const action = page.getByRole('button', { name: '生成正式版', exact: true });
      await action.waitFor();
      assert.equal(await page.getByTestId('draft-source').count(), 1, '样片操作只在结果节点出现一次');
      const sampleId = await page.evaluate(() => window.editor.nodes.find(n => n.data.assetId === 'completed-while-away').id);
      await action.evaluate(button => { button.click(); button.click(); });
      await until(() => runs.length === 1, '一次点击必须直接提交');
      assert.equal(runs[0].targetNodeId, sampleId);
      assert.equal(runs[0].draftAssetId, 'completed-while-away');
      assert.equal(await page.evaluate(() => window.editor.nodes.filter(n => n.type === 'video-generation').length), 1, '不新增生成节点');
      await page.getByRole('button', { name: '正式版生成中…', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '正式版生成中…', exact: true }).isDisabled(), true);

      await page.evaluate(() => window.leaveEditor());
      await page.getByText('其他菜单').waitFor();
      canvas.tasks[0].phase = 'succeeded';
      const sampleState = canvas.nodeStates.find(s => s.nodeId === sampleId);
      sampleState.activeTaskId = null;
      sampleState.currentAssetId = 'formal-result';
      canvas.nodeCandidates.push({ nodeId: sampleId, taskId: 'formal-task', assetId: 'formal-result', variantIndex: 0, materialized: false, createdAt: new Date().toISOString() });
      await page.evaluate(() => window.showEditor());
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      const result = await page.evaluate(() => window.editor.nodes.find(n => n.data.assetId === 'formal-result'));
      assert.equal(result?.type, 'material');
      assert.equal(result?.data.mediaKind, 'video');
      assert.ok(result.position.x > (await page.evaluate(id => window.editor.nodes.find(n => n.id === id).position.x, sampleId)));
      // Leave within the 600ms debounce: SPA cleanup must finish the pending save.
      await page.evaluate(() => window.leaveEditor());
      await page.getByText('其他菜单').waitFor();
      await until(() => presented.has('formal-result'), '快速离开后结果仍须保存');
      await page.evaluate(() => window.showEditor());
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      assert.equal(await page.evaluate(() => window.editor.nodes.filter(n => n.data.assetId === 'formal-result').length), 1, '返回不重复创建结果');
      assert.equal(runs.length, 1, '返回不重新生成');
      await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.videoWidth > 0));
      for (const [width, height] of [[1536, 864], [1280, 720], [1024, 720]]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height });
        await page.evaluate(async theme => { document.documentElement.dataset.theme = theme; await window.fit({ padding: 0.1, duration: 0 }); }, theme);
        // Metadata can arrive before WebKit commits the video's intrinsic layout.
        await page.waitForFunction(() => {
          const videos = [...document.querySelectorAll('video')];
          return videos.length === 2 && videos.every(v => {
            const box = v.getBoundingClientRect();
            return box.width >= 100 && v.videoWidth > 0 && Math.abs(box.width / box.height - v.videoWidth / v.videoHeight) < 0.01;
          });
        });
        const measured = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          videos: [...document.querySelectorAll('video')].map(v => { const b = v.getBoundingClientRect(); return { width: b.width, ratio: b.width / b.height }; }),
        }));
        await page.screenshot({ path: path.join(evidenceDir, engine + '-' + width + '-' + theme + '.png') });
        assert.equal(measured.overflow, false, '页面不能横向溢出');
        assert.ok(measured.videos.every(v => v.width >= 100 && Math.abs(v.ratio - 0.75) < 0.015), '预览保持比例和可读尺寸: ' + engine + ' ' + width + ' ' + theme + ' ' + JSON.stringify(measured));
      }
      // Intentional deletion stays deleted across remounts.
      await page.evaluate(id => { window.editor.onNodesChange([{ type: 'select', id, selected: true }]); window.editor.deleteSelection(); }, result.id);
      await until(() => !canvas.graph.nodes.some(n => n.data.assetId === 'formal-result'), '删除须保存');
      await page.evaluate(() => window.leaveEditor());
      await page.getByText('其他菜单').waitFor();
      await page.evaluate(() => window.showEditor());
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      assert.equal(await page.evaluate(() => window.editor.nodes.some(n => n.data.assetId === 'formal-result')), false, '已主动删除的结果不能复活');
      const dismissNotice = page.getByRole('button', { name: '关闭生成成功提醒' });
      assert.equal(await dismissNotice.count(), 0, '重新打开已保存的结果不重复提醒');
      const imageNodeId = await page.evaluate(async () => {
        const id = await window.editor.addNode('image-generation', { x: 0, y: 800 });
        window.editor.updateNodeData(id, { title: '客厅主视觉' });
        window.editor.updateNodeData('video', { title: '客厅光影短片' });
        return id;
      });
      const publish = (assetId, nodeId, seconds, tailAssetId) => {
        const end = Date.now();
        canvas.nodeCandidates.push({ nodeId, taskId: assetId, assetId, tailAssetId, variantIndex: 0, materialized: false,
          createdAt: new Date(end - seconds * 1000).toISOString(), completedAt: new Date(end).toISOString() });
      };
      publish('new-video-1', 'video', 230, 'tail-frame');
      publish('new-image', imageNodeId, 48);
      const notice = page.getByRole('region', { name: '已完成任务' });
      const videoRow = notice.getByRole('listitem').filter({ hasText: '客厅光影短片' });
      const imageRow = notice.getByRole('listitem').filter({ hasText: '客厅主视觉' });
      await videoRow.getByText('视频 · 耗时 230S', { exact: true }).waitFor();
      await imageRow.getByText('图片 · 耗时 48S', { exact: true }).waitFor();
      assert.equal(await notice.getByRole('listitem').count(), 2, '尾帧不单独计为任务');
      await page.waitForFunction(() => {
        const card = document.querySelector('[aria-label="已完成任务"]');
        return card?.querySelector('img')?.naturalWidth > 0 && card.querySelector('video')?.readyState >= 2;
      });
      if (engine === 'chromium') {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await notice.screenshot({ path: path.join(evidenceDir, '画布生成任务详情.png'), animations: 'disabled' });
      }
      await videoRow.getByRole('button').click();
      await page.getByRole('dialog', { name: '视频全屏预览' }).waitFor();
      await page.keyboard.press('Escape');
      await imageRow.getByRole('button').click();
      await page.getByRole('dialog', { name: '图片全屏预览' }).waitFor();
      await page.keyboard.press('Escape');
      publish('new-video-3', 'video', 6);
      await notice.getByText('3 项任务').waitFor();
      await until(() => presented.has('new-video-3'), '新结果须自动保存');
      await dismissNotice.click();
      await page.evaluate(() => window.fit({ padding: 0.1, duration: 0 }));
      const imageButton = page.locator('button:has(img[src$="/tail-frame"])');
      const preview = page.getByRole('dialog', { name: '图片全屏预览' });
      await imageButton.click();
      await preview.waitFor();
      assert.deepEqual(await preview.boundingBox(), { x: 0, y: 0, ...page.viewportSize() });
      assert.equal(await preview.locator('img').evaluate(img => img.naturalWidth), 640);
      await page.keyboard.press('Escape');
      await preview.waitFor({ state: 'detached' });
      await imageButton.click();
      await preview.getByRole('button', { name: '关闭全屏预览' }).click();
      await preview.waitFor({ state: 'detached' });
      await page.reload();
      await page.waitForFunction(() => window.editor?.loadState === 'ready');
      assert.equal(await dismissNotice.count(), 0, '刷新不重报已展示的视频或尾帧');
      assert.deepEqual(errors, []);
      console.log(engine + ': recovery, one-click final, navigation save, deletion, result notifications, fullscreen preview, 3 sizes × 2 themes passed (layout notifications: ' + layoutNotifications.length + ')');
    } finally { await browser.close(); }
  }
  console.log('creative-canvas-result-recovery.playwright.test.mjs passed');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
