// Real components, isolated HTTP fixture; no user data or provider calls.
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


const importId=bundle(path.join(root,'components/live-mixcut/formula/FormulaVideoImportPanel.tsx'));
const issueId=bundle(path.join(root,'components/live-mixcut/formula/FormulaIssuePanel.tsx'));
const require=createRequire(import.meta.url);const reactId=bundle(require.resolve('react'));const domId=bundle(require.resolve('react-dom/client'));
const script=`const process={env:{NODE_ENV:'production'}};const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId});const mode=new URLSearchParams(location.search).get('mode');load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(load(mode!=='import'&&mode?${issueId}:${importId}).default,mode!=='import'&&mode?{projectId:'p',batchId:'b',item:{planId:'plan-1',scriptNumber:'45',copyIndex:1,phase:mode==='audio'?'安排声音':'选片',detail:'S29：缺少原片',status:'needs_attention'},onChanged:async()=>{},onNavigate:step=>document.body.dataset.step=step}:{projectId:'p',batchId:'b',inputRevision:1,readOnly:false,onChanged:async()=>{}}));`;
const binding={id:'binding',assetId:'asset',sourceName:'P1_展示.mp4',sourcePath:'P1_展示.mp4',logicalCode:'P1',contentFingerprint:'fp',available:true,excludedReason:null};
const item={bindingId:binding.id,sourceName:binding.sourceName,logicalCode:'P1',excluded:false,available:true,profile:null,stale:false,inputFingerprint:'fp',source:{...binding,filename:binding.sourceName,table:null}};
let profile=null;let run=null;const requests=[];
const notes=()=>({revision:1,items:[{...item,profile}],run,aiProviders:[{id:'text',name:'文字',model:'text'}],videoProviders:[{id:'vision',name:'视觉',model:'vision'}]});
const slots=[{slotId:'s1',clipId:0,logicalCode:'S29'},{slotId:'s2',clipId:1,logicalCode:'P1'}];
const selection={planId:'plan-1',scriptNumber:'45',copyIndex:1,slots,editable:true,outputVersion:null,candidates:[{assetId:'asset',logicalCode:'P1',sourceName:'P1_展示.mp4'}],current:{id:'select-1',result:{slots:[{...slots[0],candidate:null,replacementCheck:{message:'缺少原片'}},{...slots[1],candidate:{assetId:'asset'}}]},overrides:[{slotId:'s2',sourceLogicalCode:'P1',assetId:'asset'}]}};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Type','application/json');
 if(url.pathname.includes('/formula/material-notes')){
  if(req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);requests.push(input);
   profile={id:'v1',origin:'ai',provenance:{visualObservation:input.mode==='video'},content:{description:'实际画面展示产品',category:'',actions:[],sellingPoints:[],speech:'unknown',evidence:[]}};
   run={id:'run',state:'completed',succeeded:1,total:1,skipped:0,errors:[]};
  }res.end(JSON.stringify(notes()));
 }else if(url.pathname.includes('/formula/materials'))res.end(JSON.stringify({revision:1,bindings:[binding],codes:[]}));
 else if(url.pathname.endsWith('/selection')){
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.end(JSON.stringify({...selection,current:{...selection.current,result:null}}));}
  else res.end(JSON.stringify(selection));
 }else if(url.pathname.endsWith('/manual-audio')){
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.end(JSON.stringify({selectionStageId:'new-audio'}));}
  else res.end(JSON.stringify({editable:true,reason:null,bodyText:'先看尺寸。\n实际使用很舒服。',blocks:[],sources:[{slotId:'s2',label:'镜头 2（P1）',text:'这张沙发坐着很舒服。'}],windows:[{slotIds:['s1'],label:'镜头 1（S29）'}],pictures:[],packagingEnabled:true,saved:null,expected:{expectedStageId:'select-1',expectedMappingStageId:'mapping-1',expectedOutputVersionId:null,expectedEditRevision:0}}));
 }else if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}
 else if(url.pathname.includes('/assets/')){res.statusCode=204;res.end();}
 else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',err=>errors.push(err.message));
 const origin=`http://127.0.0.1:${server.address().port}`;await page.goto(origin);
 const models=page.getByRole('combobox',{name:'素材整理模型',exact:true});await expect(models).toHaveValue('');await expect(page.getByRole('radio',{name:'根据文件名整理',exact:true})).toBeChecked();
 await models.selectOption('text');assert.equal(requests.length,0);
 await page.getByRole('radio',{name:'分析视频画面',exact:true}).check();await expect(models).toHaveValue('');await expect(models.locator('option')).toHaveCount(2);await models.selectOption('vision');assert.equal(requests.length,0);
 await page.getByRole('button',{name:/开始整理/}).click();await expect(page.getByText('AI 画面分析 · 基于实际抽帧',{exact:true})).toBeVisible();assert.equal(requests[0].mode,'video');assert.equal(requests[0].providerId,'vision');
 await page.reload();assert.equal(requests.length,1);await expect(models).toHaveValue('');
 await page.goto(origin+'/?mode=issue');await expect(page.getByText('脚本 45 · 第 1 份 · 选片',{exact:true})).toBeVisible();await expect(page.getByText('公式顺序：S29 → P1',{exact:true})).toBeVisible();
 const replacement=page.getByRole('combobox',{name:'第 1 个镜头替代原片',exact:true});await replacement.selectOption(JSON.stringify(['P1','asset']));await expect(page.getByLabel('第 1 个镜头替代预览')).toHaveAttribute('src',/\/asset\/preview/);
 await page.getByRole('button',{name:'使用所选素材继续这条',exact:true}).click();await expect(page.getByText(/已为这条成片保存替换并继续制作/)).toBeVisible();
 assert.deepEqual(requests[1].overrides,[{slotId:'s2',sourceLogicalCode:'P1',assetId:'asset'},{slotId:'s1',sourceLogicalCode:'P1',assetId:'asset'}]);assert.equal(requests[1].expectedStageId,'select-1');
 await page.goto(origin+'/?mode=audio');await expect(page.getByText('这张沙发坐着很舒服。',{exact:true})).toBeVisible();
 await expect(page.getByLabel('镜头 2（P1）原声试听')).toHaveAttribute('src',/\/asset\/preview/);
 const saveAudio=page.getByRole('button',{name:'保存声音分配并继续这条',exact:true});await expect(saveAudio).toBeDisabled();
 await page.getByRole('combobox',{name:'第 1 段配音位置',exact:true}).selectOption('["s1"]');
 await page.getByRole('combobox',{name:'第 2 段用途',exact:true}).selectOption('source');
 await page.getByRole('combobox',{name:'第 2 段对应原声',exact:true}).selectOption('s2');
 await expect(saveAudio).toBeDisabled();await page.getByRole('checkbox',{name:/我已试听原片/}).check();await saveAudio.click();
 await expect(page.getByText('已保存这条成片的声音分配并继续制作，其他成片不变。',{exact:true})).toBeVisible();
 assert.equal(requests[2].blocks.map(b=>b.text).join(''),'先看尺寸。\n实际使用很舒服。');
 assert.equal(requests[2].expectedMappingStageId,'mapping-1');assert.equal(requests[2].confirmed,true);
 assert.equal(requests[2].blocks[1].slotId,'s2');assert.deepEqual(requests[2].blocks[0].slotIds,['s1']);
 assert.deepEqual(errors,[]);console.log('PASS 双分析模式显式启动、视觉模型过滤、刷新不自动调用、具体脚本问题及显式替代续做');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
