// Run: node scripts/batch-review-snapping.playwright.test.mjs
// Real timeline + CSS in an isolated browser fixture; no app service or user DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';

const root = process.cwd();
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
const timelineId = bundle(path.join(root, 'components/batch-production/review/BatchReviewTimelineDock.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if(cache[id]) return cache[id].exports; const m=cache[id]={exports:{}}; const [fn,deps]=modules[id]; fn(r=>load(deps[r]),m,m.exports); return m.exports; }
const React=load(${reactId}), Timeline=load(${timelineId}).default;
const clip=(id,start,duration)=>({clipId:id,assetId:'asset',sourceStartUs:1000000,sourceEndUs:1000000+duration,timelineStartUs:start,timelineEndUs:start+duration,playbackRate:1});
const film={planId:'one',seq:1,scriptTitle:'短片段测试',status:'reviewable',approved:false,approvable:true,visible:true,durationSec:80,warnings:[],blockers:[],arrangement:{editable:true,clips:[clip('moving',0,2000000),clip('next',3013579,2000000)],subtitleCues:[],narration:{durationUs:8000000},music:{trackId:null},musicLibrary:[]}};
const films=[film]; window.edits=[]; window.selection=null;
function App(){
 const [selection,setSelection]=React.useState(null),[plan,setPlan]=React.useState(null),[playhead,setPlayhead]=React.useState(0); window.setPlayhead=setPlayhead;
 const props={films,projectId:'test',batchId:'test',selection,selectedPlanId:plan,focusedAssetId:null,playheadSec:playhead,tool:'select',snapEnabled:true,canUndo:false,canRedo:false,poolAssets:[{assetId:'asset',displayName:'测试素材',durationSec:10}],selectedPlanIds:[],rowFilter:'all',batchControlState:'stopped',phaseEBusy:null};
 for(const name of ['onSelectFocusedAsset','onSeek','onToolChange','onToggleSnap','onUndo','onRedo','onToggleEye','onTogglePlanSelect','onSelectAll','onReview','onRowFilterChange','onShowAll','onReallocate','onRetryNarration','onRetryRender','onRefreshFilm','onOpenCoverEditor']) props[name]=()=>{};
 props.onSelectFilm=setPlan; props.onSelectTarget=s=>{window.selection=s;setSelection(s)};
 props.onMediaEdit=async(plan,edit)=>{window.edits.push({plan,...edit});return true};
 return React.createElement(Timeline,props);
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script); }
  else if (req.url === '/') res.end(`<html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;--color-accent:#007aff;--color-surface:#fff;--color-hairline:#ddd;--color-surface-subtle:#eee}${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  else { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const first = page.locator('.clipBlock').nth(0);
  await first.waitFor();
  // Zoom must keep the visible playhead at its current screen position.
  await page.evaluate(() => { window.setPlayhead(12); document.querySelector('.timelineScroll').scrollLeft = 300; });
  const playheadX = () => page.locator('.globalPlayhead').evaluate(el => el.getBoundingClientRect().left);
  const beforeX = await playheadX();
  await page.getByLabel('时间轴缩放').fill('120');
  assert.ok(Math.abs(await playheadX() - beforeX) <= 1, '缩放应固定播放头的屏幕位置');
  // Focus stays on the zoom slider after dragging it; + and - must still work.
  await page.getByLabel('时间轴缩放').focus();
  await page.keyboard.press('+');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '130', '+ 应放大时间轴');
  assert.ok(Math.abs(await playheadX() - beforeX) <= 1, '快捷键放大也应固定播放头');
  await page.keyboard.press('-');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '120');
  await page.keyboard.press('NumpadAdd');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '130');
  await page.keyboard.press('NumpadSubtract');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '120');
  await page.keyboard.press('Control+-');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '120', '浏览器缩放组合键不修改时间轴');
  await page.evaluate(() => { window.setPlayhead(0); document.querySelector('.timelineScroll').scrollLeft = 1800; });
  const centerSec = () => page.locator('.timelineScroll').evaluate(el => (el.scrollLeft + (el.clientWidth - 284) / 2) / Number(document.querySelector('[aria-label="时间轴缩放"]').value));
  const beforeCenter = await centerSec();
  await page.getByLabel('时间轴缩放').fill('180');
  assert.ok(Math.abs(await centerSec() - beforeCenter) < 0.02, '播放头离屏时围绕当前可视区中心缩放');
  await page.evaluate(() => { const input = document.createElement('input'); document.body.append(input); input.focus(); });
  await page.keyboard.press('-');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '180', '文本输入不能误触缩放');
  await page.getByRole('button', { name: '快捷键说明', exact: true }).click();
  await page.keyboard.press('-');
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '180', '快捷键弹窗内不缩放');
  await page.reload(); await first.waitFor();
  const drag = async (delta, cancel = false, alt = false) => {
    const box = await first.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 5 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };
  // 右端距下一段 5px：应精确闭合到非整帧的既有接缝。
  await drag((3.013579 - 2 - 5 / 60) * 60);
  let edit = await page.evaluate(() => window.edits.at(-1));
  assert.equal(edit?.startUs, 1013579, '片段右端必须吸附下一段左端，保存后不能留黑帧空隙');
  await page.reload(); await first.waitFor();
  await drag((3.013579 - 2 - 5 / 60) * 60, true);
  assert.equal(await page.evaluate(() => window.edits.length), 0, 'Esc 不保存');
  await drag((3.013579 - 2 - 5 / 60) * 60, false, true);
  edit = await page.evaluate(() => window.edits.at(-1));
  assert.ok(edit.startUs < 1013579, 'Alt 保留自由移动');
  for (const zoom of [30, 180]) {
    await page.reload(); await first.waitFor();
    await page.getByLabel('时间轴缩放').fill(String(zoom));
    await drag((3.013579 - 2) * zoom - 5);
    assert.equal((await page.evaluate(() => window.edits.at(-1))).startUs, 1013579, '缩放后仍按屏幕距离吸附');
  }
  await page.reload(); await first.waitFor();
  const next = page.locator('.clipBlock').nth(1);
  const box = await next.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - (3.013579 - 2) * 60 + 5, box.y + box.height / 2, {steps: 5});
  await page.mouse.up();
  assert.equal((await page.evaluate(() => window.edits.at(-1))).startUs, 2000000, '左端精确吸附上一段末尾，不二次取整');
  console.log('batch anchored zoom, zoom shortcuts, both-edge snapping, exact seams, Alt and Escape passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
