// Run: node scripts/batch-script-selection.playwright.test.mjs
// Real script cards + CSS in a bounded scroll container; no app service or user DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

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
const componentId=bundle(path.join(root,'components/batch-production/BatchStepScripts.tsx'));
const layoutStyles=bundle(path.join(root,'components/batch-production/batch-steps.module.css'));
const coverId=bundle(path.join(root,'lib/media-core/cover-domain.ts'));
const require=createRequire(import.meta.url);
const reactId=bundle(require.resolve('react')), domId=bundle(require.resolve('react-dom/client'));
const script=`
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}), Scripts=load(${componentId}).default, style=load(${coverId}).defaultTextStyle('subtitle',1080,1440);
const layout=new URLSearchParams(location.search).has('layout');
window.requests=[];window.batchCalls=[];
window.fetch=async(url,init)=>{if(init?.method==='DELETE'){const body=JSON.parse(init.body);window.requests.push(body);return {ok:!window.failDelete,status:window.failDelete?409:200,json:async()=>window.failDelete?{message:'模拟删除失败'}:{deletedIds:body.scriptIds}};}return {ok:true,json:async()=>[]};};
function App(){const [scripts,setScripts]=React.useState(Array.from({length:layout?6:40},(_,i)=>({id:'s'+i,title:'脚本'+i,bodyText:'实木收纳床',coverTitle:{primary:'实木床',secondary:''},manual:i%2===0,targetDurationSec:15,sourceVersion:'1'}))),[selected,setSelected]=React.useState({s0:3});
const props={batchSelected:true,prep:{project:{id:'p',name:'测试'},assets:[],scripts},selectedScripts:selected,plannedCount:Object.values(selected).reduce((a,b)=>a+b,0),outputPreset:{id:'3x4',label:'3:4'},frozen:new URLSearchParams(location.search).has('frozen'),frozenScriptSnapshots:[],busy:null,outputPlans:[],batchStatus:'draft',ttsConfigured:layout,ttsProviders:layout?[{id:'tts',name:'测试配音',model:'fixture',configured:true,voices:Array.from({length:12},(_,i)=>({id:'v'+i,label:'测试音色 '+i}))}]:[],bgmParams:{gainDb:-16,fadeInSec:0,fadeOutSec:0},bgmLibrary:[],bgmRescanning:false,bgmSelection:{mode:'auto',trackIds:[]},coverTitle:{mode:'none',presetId:null,styles:null,stylesByScript:{},framing:null},subtitleStyle:{style,stylesByScript:{}},inputChangedWarning:false,progress:null};
for(const name of ['onBgmParamsChange','onRescanBgm','onBgmSelectionChange','onNarrationConfigTouched','onCoverTitleChange','onSubtitleStyleChange','onConfirmSnapshot','onStartBatch','onScriptCreated','onScriptUpdated'])props[name]=()=>{};
props.onToggleScript=(id,value)=>setSelected(current=>{const next={...current};if(value)next[id]??=1;else delete next[id];return next;});
props.onCopyCountChange=(id,n)=>setSelected(current=>({...current,[id]:n}));
props.onSetScriptsSelected=(ids,value)=>{window.batchCalls.push({ids,value});setSelected(current=>{const next={...current};for(const id of ids){if(value)next[id]??=1;else delete next[id];}return next;});};
props.onScriptsDeleted=ids=>{setScripts(current=>current.filter(s=>!ids.includes(s.id)));setSelected(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!ids.includes(id))));};
return React.createElement('div',{style:layout?{display:'flex',height:'calc(100dvh - 80px)',margin:'40px 16px 40px 280px'}:{}},React.createElement('main',{className:layout?load(${layoutStyles}).mainCol:undefined},React.createElement(Scripts,props)));}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const globalSource=fs.readFileSync(path.join(root,'app/globals.css'),'utf8')
 .replace('@theme {','@theme static {')
 .replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "../components/batch-production";\n@source "../components/ui";');
const globalCss=(await postcss([tailwind()]).process(globalSource,{from:path.join(root,'app/globals.css')})).css;
styles.unshift(globalCss);
const server=http.createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(script);}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html><head><style>'+styles.join('\n')+'</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const origin=`http://127.0.0.1:${server.address().port}`;
 const evidence=path.join(root,'outputs/batch-script-layout');fs.mkdirSync(evidence,{recursive:true});
 for(const [engine,browserType] of [['chromium',chromium],['webkit',webkit]]){
  const layoutBrowser=await browserType.launch({headless:true});
  try{
   const layoutPage=await layoutBrowser.newPage();layoutPage.on('pageerror',e=>errors.push(e.message));
   for(const [width,height] of [[1536,864],[1280,720],[1024,720]])for(const theme of ['light','dark']){
    await layoutPage.setViewportSize({width,height});await layoutPage.goto(origin+'/?layout');
    await layoutPage.getByRole('heading',{name:'脚本',exact:true}).waitFor();
    await layoutPage.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const initialHeight=await layoutPage.getByRole('region',{name:'脚本列表',exact:true}).evaluate(el=>el.clientHeight);
    for(const selected of [1,6]){
     if(selected===6)await layoutPage.getByRole('button',{name:'全选脚本',exact:true}).click();
     assert.equal(await layoutPage.getByTestId('batch-script-editor').count(),1,'全选不展开所有配音表单');
     const overflow=await layoutPage.locator('section[aria-label]').evaluateAll(sections=>sections.flatMap(section=>{
      const box=section.getBoundingClientRect();return [...section.querySelectorAll('button,input,select,[role="button"]')].flatMap(el=>{
       const r=el.getBoundingClientRect();const list=el.closest('[aria-label="脚本列表"]');const lb=list?.getBoundingClientRect();if(lb&&(r.bottom<=lb.top||r.top>=lb.bottom))return [];return r.width&&r.height&&((!list&&(r.bottom>box.bottom+1||r.top<box.top-1))||r.right>box.right+1||r.left<box.left-1)?[{section:section.getAttribute('aria-label'),control:el.getAttribute('aria-label')||el.textContent?.trim(),overflow:Math.round(r.bottom-box.bottom)}]:[];
      });
     }));
     assert.deepEqual(overflow,[],engine+' '+width+' '+theme+' '+selected+' scripts: controls must remain inside their own section');
    }
    assert.equal(await layoutPage.getByRole('region',{name:'脚本列表',exact:true}).evaluate(el=>el.clientHeight),initialHeight,'全选不增加脚本区高度');
    await layoutPage.getByRole('button',{name:'展开脚本 脚本5',exact:true}).click();
    assert.equal(await layoutPage.getByTestId('batch-script-editor').count(),1);
    assert.equal(await layoutPage.getByRole('checkbox',{name:/选择脚本/}).evaluateAll(els=>els.filter(e=>e.checked).length),6,'展开另一条不改变勾选');
    await layoutPage.getByRole('button',{name:'收起脚本 脚本5',exact:true}).click();
    assert.equal(await layoutPage.getByTestId('batch-script-editor').count(),0,'可以收起全部编辑器');
    await layoutPage.getByRole('button',{name:'展开脚本 脚本0',exact:true}).click();
    await layoutPage.getByRole('button',{name:'查看全部 12 个音色',exact:true}).first().click();
    await layoutPage.getByRole('region',{name:'脚本列表',exact:true}).evaluate(el=>{el.scrollTop=0;});
    await layoutPage.screenshot({path:path.join(evidence,engine+'-scripts-'+theme+'-'+width+'.png')});
    await layoutPage.getByLabel('字幕样式调整目标',{exact:true}).selectOption('s1');
    await layoutPage.getByRole('region',{name:'字幕样式',exact:true}).scrollIntoViewIfNeeded();
    await layoutPage.screenshot({path:path.join(evidence,engine+'-'+theme+'-'+width+'.png')});
    await layoutPage.getByRole('button',{name:'确认整体输入',exact:true}).scrollIntoViewIfNeeded();
    assert.ok(await layoutPage.getByRole('button',{name:'确认整体输入',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'bottom action remains reachable');
    assert.ok(await layoutPage.locator('main').evaluate(el=>el.scrollHeight>el.clientHeight&&el.scrollWidth<=el.clientWidth+1),'main scrolls vertically without horizontal overflow');
   }
  }finally{await layoutBrowser.close();}
 }
 await page.goto(origin);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const name of ['全选脚本','删除已选（1）','导入自定义脚本']){
   const style=await page.getByRole('button',{name,exact:true}).evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,kind:s.borderTopStyle,color:s.borderTopColor,bg:s.backgroundColor,text:s.color,radius:s.borderRadius};});
   assert.equal(style.border,'1px',theme+' '+name+' has visible boundary');assert.equal(style.kind,'solid');assert.notEqual(style.color,'rgba(0, 0, 0, 0)');assert.notEqual(style.bg,'rgba(0, 0, 0, 0)');assert.notEqual(style.text,style.bg);assert.notEqual(style.radius,'0px');
  }
  fs.mkdirSync(path.join(root,'outputs/review-packaging-acceptance'),{recursive:true});
  await page.getByRole('button',{name:'全选脚本',exact:true}).locator('..').screenshot({path:path.join(root,'outputs/review-packaging-acceptance/script-actions-'+theme+'.png')});
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.getByRole('button',{name:'全选脚本',exact:true}).click();
 assert.equal(await page.getByTestId('batch-script-editor').count(),1,'40 条全选仍只展开当前编辑器');
 assert.ok(await page.getByRole('region',{name:'脚本列表',exact:true}).evaluate(el=>el.clientHeight<=640&&el.scrollHeight>el.clientHeight),'40 条脚本在有界区域内滚动');
 assert.equal(await page.getByRole('checkbox',{name:/选择脚本/}).evaluateAll(els=>els.filter(e=>e.checked).length),40);
 assert.equal(await page.getByLabel('脚本0 生成份数',{exact:true}).inputValue(),'3','全选保留既有份数');
 assert.equal(await page.evaluate(()=>window.batchCalls.length),1,'40 条只发一次批量选择');
 await page.getByRole('button',{name:'取消全选',exact:true}).click();assert.equal(await page.getByRole('checkbox',{name:/选择脚本/}).evaluateAll(els=>els.filter(e=>e.checked).length),0);
 await page.getByRole('button',{name:'全选脚本',exact:true}).click();
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'删除已选（40）',exact:true}).click();assert.equal(await page.evaluate(()=>window.requests.length),0,'取消不发删除请求');
 await page.evaluate(()=>window.failDelete=true);page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除已选（40）',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟删除失败'}).waitFor();assert.equal(await page.getByRole('checkbox',{name:/选择脚本/}).count(),40,'失败保留列表和勾选');
 await page.evaluate(()=>window.failDelete=false);page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除已选（40）',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('input[aria-label^="选择脚本"]'));
 assert.equal(await page.evaluate(()=>window.requests.at(-1).scriptIds.length),40);assert.equal(await page.evaluate(()=>window.requests.length),2,'一次批量删除只有一个请求');
 await page.goto(origin+'/?frozen');assert.equal(await page.getByRole('button',{name:'全选脚本',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/删除已选/}).count(),0,'冻结批次无编辑入口');
 assert.deepEqual(errors,[]);console.log('40-script select all / clear / bulk delete / cancel / failure / frozen browser regression passed');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
