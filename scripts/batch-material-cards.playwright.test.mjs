// Isolated real cards and styles: long names, preview/selection/actions, responsive layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium, webkit } from 'playwright';

const root=process.cwd(),modules=new Map(),styles=[];
function bundle(filename){
  if(modules.has(filename))return modules.get(filename).id;
  const entry={id:modules.size,source:'',deps:{}};modules.set(filename,entry);
  const raw=fs.readFileSync(filename,'utf8');
  if(filename.endsWith('.css')){
    const classes={},globals=[];
    const css=raw.replace(/:global\(([^)]+)\)/g,(_,selector)=>`__GLOBAL_${globals.push(selector)-1}__`)
      .replace(/\.([a-zA-Z_][\w-]*)/g,(_,name)=>'.'+(classes[name]??=`m${entry.id}_${name}`))
      .replace(/__GLOBAL_(\d+)__/g,(_,index)=>globals[index]);
    styles.push(css);entry.source='module.exports='+JSON.stringify(classes);return entry.id;
  }
  entry.source=/\.tsx?$/.test(filename)?ts.transpileModule(raw,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText:raw;
  const require=createRequire(filename);
  for(const [,request]of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)){
    const local=request.startsWith('@/')?path.join(root,request.slice(2)):request.startsWith('.')?path.resolve(path.dirname(filename),request):null;
    const resolved=local&&['','.ts','.tsx','.js'].map(ext=>local+ext).find(file=>fs.statSync(file,{throwIfNoEntry:false})?.isFile());
    entry.deps[request]=bundle(resolved||require.resolve(request));
  }return entry.id;
}
const card=bundle(path.join(root,'components/batch-production/BatchInputSelectionCards.tsx'));
const grid=bundle(path.join(root,'components/batch-production/batch-steps.module.css'));
const require=createRequire(import.meta.url),react=bundle(require.resolve('react')),dom=bundle(require.resolve('react-dom/client'));
const globalSource=fs.readFileSync('app/globals.css','utf8').replace('@theme {','@theme static {').replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "../components/batch-production/BatchInputSelectionCards.tsx";');
const globalCss=(await postcss([tailwind()]).process(globalSource,{from:path.join(root,'app/globals.css')})).css;
const script=`const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${react}),Card=load(${card}).BatchAssetSelectionCard,css=load(${grid});window.actions=[];
function App(){const[selected,setSelected]=React.useState(false),[lut,setLut]=React.useState(null);
 return React.createElement('main',{style:{marginLeft:'min(200px,15vw)',padding:20}},React.createElement('h1',null,'准备素材'),React.createElement('div',{className:css.materialGrid},Array.from({length:7},(_,i)=>React.createElement(Card,{key:i,
 asset:{id:'asset-'+i,status:i===5?'offline':'online',currentAnalysisId:i===1||i===6?'analysis':null,analysisLevel:i===1?'content':'none',
 media:{displayName:'0'+(i+1)+'-分镜-PS866-B-模特图-沙发-黑茶色-自然舒展-环绕主体运镜-V01.mp4',width:1244,height:1660,durationSec:5},thumbnailUrl:'/poster.svg',previewUrl:'/preview.mp4',
 sources:[{id:'source-'+i,sourceKind:i===5?'linked':'module4',health:i===5?'offline':'healthy',displayName:'产品原片'}]},
 selected:i===1&&selected,onSelectedChange:value=>{setSelected(value);window.actions.push('select')},onPreview:()=>window.actions.push('preview-'+i),
 luts:[{id:'warm',displayName:'暖色',status:'active'}],lutId:lut,onLutChange:value=>{setLut(value);window.actions.push(value)},
 onRequestProxy:()=>window.actions.push('proxy'),onAnalyzeContent:()=>window.actions.push('analyze'),onRelocateLinkedSource:()=>window.actions.push('relocate'),
 analysisTask:i===2?{status:'running',progressJson:{phase:'content_analyzing'}}:i===3?{status:'failed',attempts:[{errorMessage:'网络暂不可用'}]}:undefined,onRetryAnalyze:()=>window.actions.push('retry')
 }))));}
load(${dom}).createRoot(document.getElementById('root')).render(React.createElement(App));`;
const server=http.createServer((req,res)=>{
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(script);}
  else if(req.url==='/poster.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><rect width="300" height="400" fill="#d6ccc1"/><rect y="280" width="300" height="120" fill="#a58f78"/><rect x="35" y="180" width="230" height="120" rx="24" fill="#393b37"/><path d="M50 230h200M150 190v90" stroke="#666860" stroke-width="4"/><circle cx="255" cy="80" r="28" fill="#efe5d1"/></svg>');}
  else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><head><style>${globalCss}${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const evidence=path.resolve('outputs/04-测试与验收/2026-11-09-preview-fixes');fs.mkdirSync(evidence,{recursive:true});
try{
 for(const [engine,browserType]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await browserType.launch({headless:true});
  try{
   const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   for(const [width,height]of [[1536,864],[1280,720],[1024,720]])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height});await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded',timeout:30000});
    await page.getByTestId('batch-material-card').first().waitFor({timeout:30000});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const cards=page.getByTestId('batch-material-card');assert.equal(await cards.count(),7);
    for(const c of await cards.all()){
      const box=await c.boundingBox();assert.ok(box.width>=260&&box.x+box.width<=width+1,'素材卡保持可阅读宽度，不溢出窗口');
      for(const button of await c.getByRole('button').all())assert.ok(await button.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'按钮文字不能被裁切');
      const preview=await c.locator('button').first().boundingBox();assert.ok(Math.abs(preview.width/preview.height-4/3)<.01,'缩略图区域比例统一');
    }
    assert.ok(await cards.nth(0).getByRole('checkbox').isDisabled(),'未分析素材不能误选');
    await cards.nth(0).getByRole('button',{name:/^预览素材/}).click();
    await cards.nth(0).getByRole('button',{name:'开始 AI 画面分析'}).click();
    await cards.nth(1).getByRole('checkbox').check();await cards.nth(1).getByRole('combobox').selectOption('warm');
    await cards.nth(3).getByRole('button',{name:'重试',exact:true}).click();
    await cards.nth(5).locator('summary').click();await cards.nth(5).getByRole('button',{name:'重新定位'}).click();
    assert.deepEqual(await page.evaluate(()=>window.actions),['preview-0','analyze','select','warm','retry','relocate']);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(evidence,`batch-cards-${engine}-${theme}-${width}.png`),fullPage:true});
   }assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }
 console.log('batch material cards: 2 browsers × 3 sizes × 2 themes; preview, selection, analysis, retry, source relocation and LUT passed');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
