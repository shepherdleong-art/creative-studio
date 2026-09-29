// Run: node scripts/batch-review-short-clips.playwright.test.mjs
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
const film={planId:'one',seq:1,scriptTitle:'短片段测试',status:'reviewable',approved:false,approvable:true,visible:true,durationSec:8,warnings:[],blockers:[],arrangement:{editable:true,clips:[clip('short',2000000,250000),clip('second',2250000,250000),clip('long',4000000,2000000)],subtitleCues:[],narration:{durationUs:8000000},music:{trackId:null},musicLibrary:[]}};
const films=[film]; window.edits=[]; window.selection=null;
function App(){
 const [selection,setSelection]=React.useState(null),[plan,setPlan]=React.useState(null);
 const props={films,projectId:'test',batchId:'test',selection,selectedPlanId:plan,focusedAssetId:null,playheadSec:0,tool:'select',snapEnabled:false,canUndo:false,canRedo:false,poolAssets:[{assetId:'asset',displayName:'测试素材',durationSec:10}],selectedPlanIds:[],rowFilter:'all',batchControlState:'stopped',phaseEBusy:null};
 for(const name of ['onSelectFocusedAsset','onSeek','onToolChange','onToggleSnap','onUndo','onRedo','onToggleEye','onTogglePlanSelect','onSelectAll','onReview','onRowFilterChange','onShowAll','onReallocate','onRetryNarration','onRetryRender','onRefreshFilm','onOpenCoverEditor']) props[name]=()=>{};
 props.onSelectFilm=setPlan; props.onSelectTarget=s=>{window.selection=s;setSelection(s)};
 props.onMediaEdit=async(plan,edit)=>{window.edits.push({plan,...edit});return true};
 return React.createElement(Timeline,props);
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); }
  else if (req.url === '/') res.end(`<html><head><style>*{box-sizing:border-box}body{margin:0;--color-accent:#007aff;--color-surface:#fff;--color-hairline:#ddd;--color-surface-subtle:#eee}${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  else { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const short = page.locator('.clipBlock').nth(0);
  await short.waitFor();
  const box = await short.boundingBox();
  const areas = await short.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    const handles = [...el.querySelectorAll('.trimHandle')].map(h => h.getBoundingClientRect());
    return { width: bounds.width, handleWidths: handles.map(h => h.width),
      centerHit: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.className,
      bodyWidth: handles[1].left - handles[0].right };
  });
  assert.ok(areas.bodyWidth > 0, '短片段必须保留主体命中区');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => window.selection?.clipId), 'short', '窄片段中心必须可以选中，随后才能删除');
  await page.getByTitle('删除选中片段,保留空位 (Delete)').click();
  assert.deepEqual(await page.evaluate(() => window.edits.at(-1)), { plan: 'one', type: 'delete', clipId: 'short' });

  await page.reload();
  await page.getByLabel('时间轴缩放').fill('30');
  const second = page.locator('.clipBlock').nth(1);
  const firstBox = await short.boundingBox();
  const secondBox = await second.boundingBox();
  assert.ok(firstBox.x + firstBox.width <= secondBox.x + 0.1, '缩小时相邻短片段不得因最小显示宽度互相覆盖');
  for (const [element, id] of [[short, 'short'], [second, 'second']]) {
    const b = await element.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    assert.equal(await page.evaluate(() => window.selection?.clipId), id, '缩小时两段都可独立选中');
  }
  const drag = async (element, edge, delta, cancel = false) => {
    const h = await element.locator(edge === 'start' ? '.trimHandleLeft' : '.trimHandleRight').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + delta, h.y + h.height / 2, { steps: 5 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drag(short, 'start', -20);
  let edit = await page.evaluate(() => window.edits.at(-1));
  assert.equal(edit?.type, 'trim_variable');
  assert.equal(edit.clipId, 'short');
  assert.ok(edit.sourceStartUs < 1000000, '左端可向空位拉长');
  assert.equal(edit.sourceEndUs, 1250000, '左端修剪保留右端');
  await drag(second, 'end', 30);
  edit = await page.evaluate(() => window.edits.at(-1));
  assert.equal(edit.clipId, 'second');
  assert.ok(edit.sourceEndUs > 1250000, '右端可向空位拉长');
  assert.equal(edit.sourceStartUs, 1000000, '右端修剪保留左端');
  assert.equal(await page.evaluate(() => window.edits.length), 2, '每次拖动只保存一次');
  await drag(second, 'end', 30, true);
  assert.equal(await page.evaluate(() => window.edits.length), 2, 'Esc 取消不落编辑');

  await page.getByRole('button', { name: '放大片段', exact: true }).click();
  assert.equal(await page.getByLabel('时间轴缩放').inputValue(), '180');
  assert.ok((await second.boundingBox()).width >= 44, '放大后短片段有足够可见宽度');

  await page.reload();
  const h = await second.locator('.trimHandleRight').boundingBox();
  await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2);
  assert.equal(await page.evaluate(() => window.selection?.clipId), 'second', '仅点击边缘也必须选中正确片段');
  assert.equal(await page.evaluate(() => window.edits.length), 0, '仅点边缘不能误提交修剪');
  await page.getByTitle('删除选中片段,保留空位 (Delete)').click();
  assert.deepEqual(await page.evaluate(() => window.edits.at(-1)), { plan: 'one', type: 'delete', clipId: 'second' });
  await page.setViewportSize({ width: 700, height: 900 });
  const long = page.locator('.clipBlock').nth(2);
  const longBox = await long.boundingBox();
  await page.mouse.click(longBox.x + longBox.width / 2, longBox.y + longBox.height / 2);
  await page.getByRole('button', { name: '放大片段', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.timelineScroll').scrollLeft > 0);
  const focused = await long.boundingBox();
  assert.ok(focused.x >= 284 && focused.x + focused.width <= 700, '放大后目标应定位在可操作的轨道视区');
  console.log('short clip selection, deletion, trim, cancellation and zoom passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
