// node scripts/batch-sticker-copy-dialog.playwright.test.mjs
// Real React dialog: simulate parent polling while it stays open; no database or service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const modules = new Map();
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
    const local = request.startsWith('@/') ? path.resolve(request.slice(2))
      : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}
const dialogId = bundle(path.resolve('components/batch-production/review/BatchStickerCopyDialog.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}),Dialog=load(${dialogId}).default;
const film=(planId,seq)=>({planId,seq,scriptTitle:planId,approved:false,arrangement:{editable:true,outputVersionId:planId+'-v1',editRevision:1,visualDurationUs:8000000,narration:{durationUs:8000000},packaging:{enabled:true,stickers:[]}}});
window.calls=[];window.closedCount=0;
function App(){
 const [films,setFilms]=React.useState([film('source',1),film('one',2),film('two',3),{...film('late',4),arrangement:null}]);
 window.update=(id,kind)=>setFilms(values=>kind==='missing'?values.filter(f=>f.planId!==id):values.map(f=>f.planId!==id?f:kind==='load'?film(id,f.seq):{...f,arrangement:{...f.arrangement,...(kind==='revision'?{editRevision:2}:kind==='version'?{outputVersionId:id+'-v2'}:{editable:false})}}));
 return React.createElement(Dialog,{source:films[0],films,initialSelectedPlanIds:['one','two'],onClose:()=>{window.closedCount++},onConfirm:async(source,targets)=>{window.calls.push({source,targets})}});
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));`;

const browser = await chromium.launch({ headless: true, executablePath: path.resolve('packaging/runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell') });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const reset = async () => {
    await page.goto('about:blank');
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.getByRole('dialog').waitFor();
  };
  for (const kind of ['revision', 'version', 'invalid', 'missing']) {
    await reset();
    await page.evaluate(kind => window.update('one', kind), kind);
    await page.getByRole('button', { name: /复制并生成变体/ }).click();
    assert.equal(await page.evaluate(() => window.calls.length), 0, `polling ${kind} must reject the entire selection, never accept a new revision or copy a subset`);
    await page.getByRole('alert').filter({ hasText: /目标成片.*变化/ }).waitFor();
    assert.equal(await page.evaluate(() => window.closedCount), 0);
  }
  await reset();
  await page.evaluate(() => window.update('late', 'load'));
  await page.locator('[data-plan-id="late"] input').check();
  await page.evaluate(() => window.update('source', 'revision'));
  await page.getByRole('button', { name: /复制并生成变体/ }).click();
  const [call] = await page.evaluate(() => window.calls);
  assert.equal(call.source.expectedEditRevision, 1, 'source remains frozen at dialog opening');
  assert.deepEqual(call.targets, ['one', 'two', 'late'].map(planId => ({ planId, expectedOutputVersionId: `${planId}-v1`, expectedEditRevision: 1 })));
  assert.deepEqual(errors, []);
  console.log('贴纸复制弹窗通过：轮询修订/版本/失效/移除均整体拒绝，延迟载入目标可选择，来源快照不升级。');
} finally {
  await browser.close();
}
