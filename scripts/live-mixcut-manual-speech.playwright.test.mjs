// Run: node scripts/live-mixcut-manual-speech.playwright.test.mjs
// Real React panel; isolated HTTP fixture, no user data or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium, expect } from '@playwright/test';
const root = process.cwd();
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
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}


const panelId = bundle(path.join(root, 'components/live-mixcut/formula/FormulaManualSpeechPanel.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId});load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(load(${panelId}).default,{projectId:'p',batchId:'b',planId:'plan-1',disabled:false,onChanged:async()=>{}}));`;
const items = ['S14','P1','VO1','P2'].map(code => ({ assetId:code, contentFingerprint:'fp-'+code, names:[code+'_原片.mp4'], available:true,saved:null,automatic:null,
  review:{logicalCodes:[code],needsAttention:code!=='VO1',message:code==='VO1'?'原声识别已完成，可试听核对。':'识别失败，请试听此原片。'} }));
let editable = true;
const requests=[];
const server = http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.includes('/formula/manual-speech')) {
    requests.push({method:req.method,planId:url.searchParams.get('planId')});
    if(req.method==='PUT') {
      let raw='';for await(const chunk of req) raw+=chunk;
      const input=JSON.parse(raw);const item=items.find(item=>item.assetId===input.assetId);
      item.saved={...input,revision:1};
    }
    const scoped=url.searchParams.get('planId')==='plan-1';
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({inputRevision:1,editable,context:scoped?{planId:'plan-1',scriptNumber:'1',copyIndex:1}:undefined,
      items:scoped?items:[...items,{...items[0],assetId:'G10',names:['G10_不相关.mp4']}]}));
  } else if(url.pathname.includes('/preview')) {res.statusCode=204;res.end();}
  else if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}
  else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');}
});
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByText('脚本 1 · 第 1 份',{exact:true})).toBeVisible();
  await expect(page.getByText('当前核对：S14',{exact:true})).toBeVisible();
  await expect(page.getByLabel('人工台词原片预览')).toHaveAttribute('src',/\/S14\/preview/);
  await expect(page.getByLabel('人工核对的原片')).toHaveCount(0);
  const list=page.getByLabel('本条脚本的原片');
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(page.getByText(/G10_不相关/)).toHaveCount(0);
  await list.getByRole('button',{name:/P1 ·/}).click();
  await expect(page.getByText('当前核对：P1',{exact:true})).toBeVisible();
  await expect(page.getByLabel('人工台词原片预览')).toHaveAttribute('src',/\/P1\/preview/);
  await page.getByRole('radio',{name:'我已确认整段原片没有人声',exact:true}).check();
  await list.getByRole('button',{name:/P2 ·/}).click();
  await expect(page.getByText('当前核对：P1',{exact:true})).toBeVisible();
  await expect(page.getByText(/当前台词尚未保存/)).toBeVisible();
  await page.getByRole('checkbox',{name:'我已试听，确认整段原片没有人声',exact:true}).check();
  await page.getByRole('button',{name:'确认并保存原声记录',exact:true}).click();
  await expect(page.getByText(/人工原声记录已保存/)).toBeVisible();
  await expect(page.getByText('当前核对：P1',{exact:true})).toBeVisible();
  await expect(list.getByRole('button',{name:/P1 · 人工记录已保存/})).toBeVisible();
  await page.getByRole('button',{name:'查看本条脚本全部 4 条原片',exact:true}).click();
  await expect(list.getByRole('button')).toHaveCount(4);
  editable=false;await page.reload();
  await expect(page.getByText(/现在可以试听。本次输入已锁定/)).toBeVisible();
  await expect(page.getByRole('radio',{name:'自动识别',exact:true})).toBeDisabled();
  assert(requests.length>=3 && requests.every(req=>req.planId==='plan-1'));
  assert.equal(requests.filter(req=>req.method==='PUT').length,1);assert.deepEqual(errors,[]);
  console.log('PASS 脚本范围、失败原片自动定位、编号文件名、预览切换、未保存保护、保存范围和冻结提示');
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
