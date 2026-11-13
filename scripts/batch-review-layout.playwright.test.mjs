// Run: node scripts/batch-review-layout.playwright.test.mjs
// Real batch entry, shell, review and CSS Modules in a loopback-only browser fixture. No app DB or providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium, webkit } from 'playwright';
const require = createRequire(import.meta.url);
const localByDefault = require('next/dist/compiled/postcss-modules-local-by-default');
const scope = require('next/dist/compiled/postcss-modules-scope');
const root = process.cwd();
const modules = new Map();
const cssEntries = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  if (filename.endsWith('/components/mixcut/MixcutPanel.tsx') || filename.endsWith('\\components\\mixcut\\MixcutPanel.tsx')) {
    entry.source = 'module.exports = function SingleModeFixture() { return null; };';
    return entry.id;
  }
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    cssEntries.push({ filename, raw, entry });
    return entry.id;
  }
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText : raw;
  const resolve = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2)) : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js', '.mjs'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (request === 'next/link') {
      const key = 'fixture:next/link';
      if (!modules.has(key)) modules.set(key, { id: modules.size, source: 'module.exports = function Link(p) { return require("react").createElement("a", p, p.children); };', deps: { react: bundle(require.resolve('react')) } });
      entry.deps[request] = modules.get(key).id;
    } else entry.deps[request] = bundle(resolved || resolve.resolve(request));
  }
  return entry.id;
}
const workspaceId = bundle(path.join(root, 'components/mixcut/MixcutWorkspace.tsx'));
bundle(path.join(root, 'components/mixcut/mixcut-shell.module.css'));
const teamCssId = bundle(path.join(root, 'components/team/workspace.module.css'));
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const compiledCss = [];
for (const { filename, raw, entry } of cssEntries) {
  const prefix = 'fixture_' + createHash('sha256').update(path.relative(root, filename)).digest('hex').slice(0, 8);
  const result = await postcss([localByDefault({ mode: 'local' }), scope({ generateScopedName: name => `${prefix}__${name}` })]).process(raw, { from: filename });
  const exports = {};
  result.root.walkRules(':export', rule => { rule.walkDecls(decl => { exports[decl.prop] = decl.value; }); rule.remove(); });
  entry.source = 'module.exports = ' + JSON.stringify(exports);
  compiledCss.push(result.root.toString());
}
// Every file receives a different namespace; identity class mocks would hide the reported mainCol regression.
const mainCss = cssEntries.filter(item => /(?:batch-steps|mixcut-shell)\.module\.css$/.test(item.filename));
assert.equal(mainCss.length, 2);
assert.notEqual(mainCss[0].entry.source.match(/"mainCol":"([^"]+)/)?.[1], mainCss[1].entry.source.match(/"mainCol":"([^"]+)/)?.[1]);
const cssInput = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);')
  + '\n@source "../components/batch-production";\n@source "../components/mixcut";\n@source "../components/ui";\n@source "../components/audio";\n@source "../components/timeline";';
const globalCss = (await postcss([tailwind()]).process(cssInput, { from: path.join(root, 'app/globals.css') })).css;
const pixel = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="108" height="144"><rect width="108" height="144" fill="#5e74a8"/><circle cx="54" cy="62" r="24" fill="#cbd6e9"/></svg>');
const textStyle = { fontFamily: 'Arial', fontSizePx: 48, x: 0.5, y: 0.84, scale: 1, italic: false, color: '#ffffff', align: 'center', boxWidthPx: 800, lineHeight: 1.2, stroke: { enabled: true, color: '#000000', widthPx: 2 }, shadow: { enabled: true, color: '#000000', opacity: 0.4, blurPx: 4, distancePx: 2, angleDeg: 90 } };
const assets = Array.from({ length: 12 }, (_, index) => ({ assetId: 'asset-' + index, displayName: '产品素材 ' + (index + 1), role: 'body', durationSec: 8, previewUrl: '/media.mp4', thumbnailUrl: pixel, useCountByPlanId: {}, coverUsedByPlanIds: [] }));
const cards = Array.from({ length: 6 }, (_, index) => ({ planId: 'film-' + index, seq: index + 1, scriptTitle: '产品演示 ' + (index + 1), status: 'reviewable', reviewable: true, approvable: true, approved: false, coverStatus: 'ready', warnings: [], blockers: [], sourceWarnings: [], sourceConflictAssetIds: [], sourceConflictGroups: [], narrationTask: null, coverTask: null, fullRenderTask: null, subtitleOverride: false }));
const batch = { id: 'batch', name: '批量审片布局验收', status: 'completed', controlState: 'running', currentVersionId: 'version' };
const workspace = { batch, cards, counts: { total: 6, reviewable: 6, approvable: 6, approved: 0, processing: 0, needsAttention: 0, failed: 0 }, exclusions: [], allocationReport: null, phase: 'review', exportDirName: '' };
function arrangement(planId) { return {
  planId, outputVersionId: 'output-' + planId, editRevision: 0, editable: true,
  clips: [{ clipId: 'clip-' + planId, assetId: 'asset-0', sourceStartUs: 0, sourceEndUs: 8000000, timelineStartUs: 0, timelineEndUs: 8000000, playbackRate: 1, framing: { scale: 1, offsetX: 0, offsetY: 0 } }],
  visualDurationUs: 8000000, poolAssets: assets, coverAssetId: 'asset-0', coverTimeUs: 0, coverFraming: { scale: 1, offsetX: 0, offsetY: 0 }, coverTitle: null, coverTitleOverride: false,
  subtitleCues: [{ id: 'cue-' + planId, startUs: 0, endUs: 8000000, text: '完整字幕与音轨' }], subtitleStyle: textStyle, subtitleStyleOverride: false,
  narration: { durationUs: 8000000, gainDb: 0 }, music: { trackId: null, gainDb: -12, fadeInSec: 0.5, fadeOutSec: 1 }, packaging: { enabled: true, template: 'overlay-poster', pointCues: [], varsOverrides: {} },
  warnings: [], blockers: [], sourceWarnings: [], sourceConflictAssetIds: [], sourceConflictGroups: [],
}; }
const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {}; function load(id) { if(cache[id])return cache[id].exports; const m=cache[id]={exports:{}}; const [fn,deps]=modules[id]; fn(r=>load(deps[r]),m,m.exports);return m.exports; }
const React=load(${reactId}), h=React.createElement, Workspace=load(${workspaceId}).default, team=load(${teamCssId});
const serverMode=new URL(location).searchParams.get('deployment')==='server';
document.documentElement.dataset.deploymentMode=serverMode?'server':'local';
load(${domId}).createRoot(document.body).render(h(React.Fragment,null,
 serverMode?h('aside',{'data-testid':'workspace-sidebar',className:team.sidebar},'林视'):h('header',{className:'toolbar h-12'},'林视 · 本地工作台'),
 h('main',{className:serverMode?'flex-1 flex min-h-0 w-full min-w-0 flex-col':'flex-1 w-full max-w-[980px] mx-auto px-6 py-10'},
 h('div',{className:'flex min-h-0 w-full min-w-0 flex-1 flex-col'},h('div',{className:'flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3'},
 h('div',{'data-project-chrome':true,className:'page-toolbar'},'项目 · 产品布局验收'),h('div',{'data-project-chrome':true,className:'seg'},'场景图 / 分镜 / 脚本 / 视频 / 混剪'),
 h('div',{className:'flex min-h-0 w-full min-w-0 flex-1 flex-col'},h('div',{className:'flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3'},
 h(Workspace,{projectId:'project',projectName:'布局验收项目',projectInfo:{name:'布局验收项目'},onProjectInfoChange:()=>{}}))))))));
`;
new vm.Script(script);
const api = (url) => {
  if (url.pathname.endsWith('/readiness')) return { available: true };
  if (url.pathname.endsWith('/prepare')) return { project: { id: 'project', name: '布局验收项目', productCode: 'P001' }, assets: [], scripts: [], warnings: [] };
  if (url.pathname.endsWith('/workspace')) return workspace;
  if (url.pathname.endsWith('/arrangement')) return arrangement(url.pathname.split('/').at(-2));
  if (url.pathname === '/api/batch-production/batches') return { projectId: 'project', batches: [batch] };
  if (url.pathname === '/api/batch-production/batches/batch') return { batch, version: { id: 'version', inputState: 'frozen', defaultsJson: {} }, outputPlans: cards.map(card => ({ id: card.planId, seq: card.seq })), scriptSnapshots: [], assetPool: [] };
  if (url.pathname.endsWith('/tasks')) return { tasks: [] };
  if (url.pathname.endsWith('/luts')) return { luts: [] };
  if (url.pathname.endsWith('/bgm')) return { tracks: [] };
  if (url.pathname.endsWith('/usage')) return { count: 0, totalBytes: 0 };
  if (url.pathname === '/api/final-edit/capabilities') return { revealInFolder: false };
  return [];
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); }
  else if (url.pathname.endsWith('/packaging-preview')) { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:0;background:transparent"></body></html>'); }
  else if (url.pathname === '/media.mp4' || /\/assets\/[^/]+\/preview$/.test(url.pathname)) { res.setHeader('Content-Type', 'video/mp4'); res.end(fs.readFileSync(path.join(out, 'layout-fixture.mp4'))); }
  else if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(api(url))); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<html class="h-full" data-deployment-mode="${url.searchParams.get('deployment') || 'local'}"><head><meta charset="utf-8"><style>${globalCss}\n${compiledCss.join('\n')}*{box-sizing:border-box}body{margin:0}</style></head><body class="min-h-full flex flex-col bg-surface text-ink"><script src="/fixture.js"></script></body></html>`); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const out = path.resolve('outputs/04-测试与验收/2026-11-12-批量审片布局');
fs.mkdirSync(out, { recursive: true });
const media = path.join(out, 'layout-fixture.mp4');
const generated = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x586c93:s=108x192:r=24:d=8', '-vf', 'drawgrid=w=27:h=48:t=1:c=white@0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
const smoke = process.env.BATCH_REVIEW_LAYOUT_SMOKE === '1';
const measurements = [];
try {
 const engines = process.env.BATCH_REVIEW_LAYOUT_ENGINE === 'webkit' ? [['webkit', webkit]] : smoke ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]];
 for (const [engineName, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  try {
   for (const deployment of smoke ? ['server'] : ['server', 'local']) for (const viewport of smoke ? [{ width: 1024, height: 720 }] : [{ width: 1024, height: 720 }, { width: 1280, height: 720 }, { width: 1536, height: 864 }]) for (const theme of smoke ? ['light'] : ['light', 'dark']) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    let completed = false;
    page.on('pageerror', error => { errors.push(error.message); console.error('fixture page error:', error.message); });
    try {
     await page.goto(`http://127.0.0.1:${server.address().port}/?deployment=${deployment}`);
     await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
     await page.waitForTimeout(250);
     assert.deepEqual(errors, [], 'fixture failed to mount');
     await page.getByRole('tab', { name: '批量生产', exact: true }).click();
     const check = page.getByRole('button', { name: '检查成片', exact: true });
     await check.waitFor();
     // Portrait is the tightest case; the original selector remains available before focus.
     await page.getByRole('group', { name: '全局画幅' }).getByRole('button', { name: '9:16', exact: true }).click();
     await check.click();
     await page.getByTestId('batch-unified-review-screen').waitFor();
     await page.locator('[data-output-preset]').waitFor({ state: 'attached' });
     await page.getByRole('button', { name: '字幕', exact: true }).click();
     await page.getByLabel('字号数值', { exact: true }).waitFor();
     await page.getByRole('button', { name: /正文素材库/ }).click();
     await page.waitForTimeout(400);
     const probe = await page.evaluate(() => {
      const stage = document.querySelector('[data-output-preset]');
      const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
      const ancestors = []; for(let e=stage.parentElement;e;e=e.parentElement) if(e.scrollHeight>e.clientHeight+1 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)) ancestors.push({tag:e.tagName,cls:e.className,client:e.clientHeight,scroll:e.scrollHeight});
      const scroll=document.querySelector('[class*="timelineScroll"]'), row=document.querySelector('[class*="filmRow"]'), ruler=document.querySelector('[class*="rulerRow"]');
      return { viewport:{width:innerWidth,height:innerHeight},page:{scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth},stage:rect(stage),ancestors,timeline:{scroll:rect(scroll),row:rect(row),ruler:rect(ruler),clientHeight:scroll.clientHeight},shell:rect(document.querySelector('[data-testid="mixcut-shell"]')),workbench:{...rect(document.querySelector('[class*="reviewWorkbench"]')),rows:getComputedStyle(document.querySelector('[class*="reviewWorkbench"]')).gridTemplateRows},player:[...document.querySelectorAll('[class*="compact"], [aria-label="统一时间轴"]')].map(e=>({cls:e.className,box:rect(e),height:getComputedStyle(e).height,minHeight:getComputedStyle(e).minHeight,flex:getComputedStyle(e).flex})),main:[...document.querySelectorAll('main')].map(e=>({height:e.clientHeight,scroll:e.scrollHeight,overflow:getComputedStyle(e).overflowY})) };
     });
     const label = `${engineName}-${deployment}-${viewport.width}x${viewport.height}-${theme}`;
     measurements.push({ label, ...probe });
     await page.screenshot({ path: path.join(out, label + '.png') });
     assert.deepEqual(errors, [], `${label}: browser errors`);
     assert.ok(probe.page.scrollHeight <= viewport.height + 1, `${label}: page scrolls vertically ${JSON.stringify(probe)}`);
     assert.ok(probe.page.scrollWidth <= viewport.width + 1, `${label}: page scrolls horizontally`);
     assert.deepEqual(probe.ancestors, [], `${label}: preview has outer vertical scroll containers`);
     assert.ok(probe.stage.width >= 100 && probe.stage.height >= 200 && Math.abs(probe.stage.width / probe.stage.height - 9/16) < .01, `${label}: full portrait preview is too small or distorted ${JSON.stringify(probe)}`);
     assert.ok(probe.stage.y >= 0 && probe.stage.bottom <= viewport.height && probe.stage.right <= viewport.width, `${label}: preview leaves viewport`);
     assert.ok(probe.timeline.row.bottom <= probe.timeline.scroll.y + probe.timeline.clientHeight + 1, `${label}: first complete film row is clipped ${JSON.stringify(probe.timeline)}`);
     assert.equal(await page.locator('[data-mixcut-mode-bar]').isVisible(), false, 'focus hides mode bar');
     assert.equal(await page.locator('[data-project-chrome]').first().isVisible(), false, 'focus hides project navigation');
     // The existing inspector remains a single independently scrolling form, with stroke/shadow controls intact.
     const inspectorScroll = page.locator('[class*="inspectorScroll"]');
     assert.ok(await inspectorScroll.evaluate(e => e.scrollHeight > e.clientHeight + 1));
     await page.getByLabel('角度数值', { exact: true }).scrollIntoViewIfNeeded();
     assert.ok(await inspectorScroll.evaluate(e => e.scrollTop > 0));
     await inspectorScroll.evaluate(e => { e.scrollTop = 0; });
     const poolScroll = page.locator('[class*="poolGrid"]');
     assert.ok(await poolScroll.evaluate(e => e.scrollHeight > e.clientHeight + 1));
     await poolScroll.evaluate(e => { e.scrollTop = e.scrollHeight; });
     assert.ok(await poolScroll.evaluate(e => e.scrollTop > 0));
     await poolScroll.evaluate(e => { e.scrollTop = 0; });
     // Offscreen player options must stay reachable through their own horizontal overflow.
     const options = page.locator('[class*="compactOptions"]');
     await options.getByRole('button', { name: '全屏', exact: true }).scrollIntoViewIfNeeded();
     const optionVisible = await options.getByRole('button', { name: '全屏', exact: true }).evaluate(e => {
      const a=e.getBoundingClientRect(), b=e.parentElement.getBoundingClientRect(); return a.right<=b.right+1 && a.left>=b.left-1;
     });
     assert.ok(optionVisible, `${label}: fullscreen control cannot be reached`);
     await options.evaluate(e => { e.scrollLeft = 0; });
     // All three separators continue to adjust real panel geometry.
     for (const name of ['调整素材池宽度', '调整属性检查器宽度', '调整上下区域比例']) {
      const separator = page.getByRole('separator', { name });
      const before = Number(await separator.getAttribute('aria-valuenow'));
      await separator.focus();
      await separator.press(name === '调整上下区域比例' ? 'ArrowUp' : 'ArrowLeft');
      const after = Number(await separator.getAttribute('aria-valuenow'));
      assert.notEqual(after, before, `${label}: ${name} no longer adjusts`);
      await separator.press('Enter');
      const start = await separator.boundingBox();
      const pointerBefore = Number(await separator.getAttribute('aria-valuenow'));
      await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
      await page.mouse.down();
      await page.mouse.move(start.x+start.width/2+(name==='调整素材池宽度'?-12:name==='调整属性检查器宽度'?-12:0),start.y+start.height/2+(name==='调整上下区域比例'?-12:0),{steps:3});
      await page.mouse.up();
      assert.notEqual(Number(await separator.getAttribute('aria-valuenow')),pointerBefore,`${label}: ${name} pointer drag no longer adjusts`);
      await separator.press('Enter');
     }
     if (viewport.width === 1024 && theme === 'light') {
      await page.route(/\/reallocate\?/, route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'隔离验收：无法换画面，请重试'})}));
      await page.getByRole('button', {name:'换一批画面',exact:true}).first().click();
      await page.locator('summary [role="alert"]').getByText('隔离验收：无法换画面，请重试',{exact:true}).waitFor();
      await page.locator('summary').click();
      await page.getByRole('button', {name:'关闭提示',exact:true}).click();
      await page.locator('summary').click();
     }
     await page.getByLabel('字号数值', {exact:true}).fill('61');
     await page.getByRole('button', { name: '返回', exact: true }).click();
     assert.equal(await page.locator('[data-mixcut-mode-bar]').isVisible(), true, 'return restores mode bar');
     assert.equal(await page.locator('[data-project-chrome]').first().isVisible(), true, 'return restores project navigation');
     assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden', 'return unlocks page');
     await page.waitForTimeout(100);
     const restoredChrome = await page.locator('[data-project-chrome], [data-mixcut-mode-bar]').evaluateAll(elements => elements.map(e => {
      const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,visible:r.top>=0 && r.bottom<=innerHeight};
     }));
     assert.ok(restoredChrome.every(e=>e.visible), `${label}: returning must put project navigation and mode bar inside viewport ${JSON.stringify(restoredChrome)}`);
     assert.equal(await page.getByLabel('字号数值', {exact:true}).inputValue(), '61', 'return preserves inspector draft');
     await page.getByRole('button', {name:'专注编辑',exact:true}).click();
     assert.equal(await page.locator('[data-mixcut-mode-bar]').isVisible(), false, 'focus can be restored without changing steps');
     assert.equal(await page.getByLabel('字号数值', {exact:true}).inputValue(), '61', 'refocus preserves draft');
     await page.getByRole('button', {name:'脚本与口播',exact:true}).click();
     await page.getByRole('button', {name:'检查成片',exact:true}).click();
     assert.equal(await page.locator('[data-mixcut-mode-bar]').isVisible(), false, 'reentering review focuses automatically');
     completed = true;
     console.log(label + ' passed');
    } finally { if (!completed) await page.screenshot({ path: path.join(out, `${engineName}-${deployment}-${viewport.width}x${viewport.height}-${theme}-failure.png`) }); await page.close(); }
   }
  } finally { await browser.close(); }
 }
 console.log(`batch review layout passed (${measurements.length} viewport/theme/deployment/engine cases)`);
} finally {
 fs.writeFileSync(path.join(out, 'layout-measurements.json'), JSON.stringify(measurements, null, 2));
 server.closeAllConnections();
 await new Promise(resolve => server.close(resolve));
}
