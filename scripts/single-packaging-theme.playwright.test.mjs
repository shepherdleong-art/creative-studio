// Exercise the actual legacy GET HTML builder, with isolated group data, over a known media color.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import sharp from 'sharp';
import { chromium } from 'playwright';
import * as packaging from '../lib/media-core/packaging-runtime.ts';
import * as fonts from '../lib/media-core/packaging-font.ts';
import { PACKAGING_EDIT_BRIDGE_JS } from '../lib/media-core/packaging-edit-bridge.ts';

const vars={title:'测试标题',subtitle:'测试副标题',point1:'框架稳固',point2:'舒适',point3:'耐用'};
const group={projectId:'project',coverTitle:{primary:{text:vars.title},secondary:{text:vars.subtitle}},subtitleCues:[],totalDurationUs:21857000,
  variants:[{id:'variant',outputPreset:'3x4',cover:{sourceUrl:''}}],
  packaging:{varsOverrides:{},pointCues:[{id:'point',text:'框架稳固',startSec:1.72,endSec:2.93}],pointCuesMode:'timed',pointCuesKey:'key'}};
const dependencies={
  '@/lib/media-core/packaging-edit-bridge':{PACKAGING_EDIT_BRIDGE_JS},
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},
  '@/lib/db':{getDb:()=>({prepare:()=>({get:()=>({name:'测试项目',productCode:'TEST'})})})},
  '@/lib/data-root':{dataRoot:()=>process.cwd()},
  '@/lib/final-edit/errors':{FinalEditError:Error},
  '@/lib/final-edit/http':{finalEditErrorResponse:error=>{throw error}},
  '@/lib/final-edit/cover-frame':{},'@/lib/final-edit/packaging-color':{},'@/lib/final-edit/packaging-palette':{},
  '@/lib/final-edit/packaging-vars':{buildPackagingVars:()=>vars,DEFAULT_PACKAGING_TEMPLATE:'overlay-poster'},
  '@/lib/final-edit/packaging-cues':{computePointCuesKey:()=> 'key',loadGroupNarrationText:()=>'',ensurePackagingPointCues:async()=>({pointCues:group.packaging.pointCues,mode:'timed',pointCuesKey:'key'})},
  '@/lib/final-edit/packaging':{...packaging,loadProjectPackagingData:()=>({})},
  '@/lib/final-edit/packaging-font':fonts,
  '@/lib/final-edit/runtime':{getFinalEditWorkspace:()=>({load:()=>group})},
  '@/lib/media-core/render-contract':{FINAL_EDIT_INTRO_DURATION_US:833333},
  '@/lib/team-service/route-wrapper':{withTeamRoute:(_path,_method,handler)=>handler},
};
let source=fs.readFileSync('app/api/final-edit-groups/[id]/packaging-preview/route.ts','utf8');
// Explicit old-code mode proves the regression catches opaque compositing; it must fail.
const legacy=process.argv.includes('--legacy');
if(legacy)source=source.replace(':root{color-scheme:light}','');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const routeModule={exports:{}};const require=createRequire(import.meta.url);
new Function('require','module','exports',compiled)(name=>dependencies[name]??require(name),routeModule,routeModule.exports);
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){
   res.setHeader('Content-Type','text/html');
   res.end(`<html style="color-scheme:${url.searchParams.get('theme')}"><body style="margin:0"><div style="width:360px;height:480px;background:rgb(0,180,60)"><iframe src="/overlay?template=${url.searchParams.get('template')}" style="width:100%;height:100%;border:0;${legacy?'':'color-scheme:light'}"></iframe></div></body></html>`);
  }else if(url.pathname==='/overlay'){
   const response=await routeModule.exports.GET(new Request('http://localhost/preview?format=html&sync=1&edit=1&variantId=variant&template='+url.searchParams.get('template')),{params:Promise.resolve({id:'group'})});
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await response.text());
  }else{
   const relative=decodeURIComponent(url.pathname).replace('/api/packaging/templates/','');
   let file=path.resolve('packaging/templates',relative);
   if(!file.startsWith(path.resolve('packaging/templates')+path.sep)){res.writeHead(404).end();return;}
   if(!fs.existsSync(file)&&relative.includes('/fonts/'))file=path.join('packaging/fonts',relative.split('/fonts/')[1]);
   if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile()){res.writeHead(404).end();return;}
   res.setHeader('Content-Type',({'.js':'text/javascript','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
  }
 }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:360,height:480}});page.setDefaultTimeout(15000);
 for(const template of ['overlay-poster','overlay-journal','overlay-minimal','overlay-variety'])for(const theme of ['light','dark']){
  await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&template=${template}`);
  const frame=page.frames().find(f=>f.url().includes('/overlay?'));
  await frame.waitForFunction(()=>!!window.__timelines?.overlay);await frame.evaluate(()=>document.fonts.ready);
  await frame.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
  await frame.evaluate(()=>{window.__timelines.overlay.pause();window.__timelines.overlay.seek(2.42)});
  const shot=await page.screenshot();
  const data=await sharp(shot).extract({left:180,top:240,width:1,height:1}).removeAlpha().raw().toBuffer();
  assert.deepEqual([...data],[0,180,60],`${template}/${theme}: 包装层不得遮住实际视频画面`);
  const evidence=path.resolve('outputs/04-测试与验收/2026-11-09-preview-fixes');fs.mkdirSync(evidence,{recursive:true});
  if(!legacy)fs.writeFileSync(path.join(evidence,`single-route-${template}-${theme}.png`),shot);
 }
 console.log('Actual single-edit packaging GET: all four templates remain transparent in both themes');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
