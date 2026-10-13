// Run: node scripts/review-packaging-source.playwright.test.mjs
// Shortcuts only: node scripts/review-packaging-source.playwright.test.mjs --shortcuts-only
// Merged cover only: node scripts/review-packaging-source.playwright.test.mjs --cover-only
// Real timeline + CSS in an isolated browser fixture; no app service or user DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { packagingPreviewHtml } from '../lib/media-core/packaging-preview.ts';

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

const overlayId = bundle(path.join(root, 'components/batch-production/BatchPackagingOverlay.tsx'));
const menuId = bundle(path.join(root, 'components/batch-production/BatchPackagingEditor.tsx'));
const trimId = bundle(path.join(root, 'components/mixcut/TrimEditor.tsx'));
const timelineId = bundle(path.join(root, 'components/batch-production/review/BatchReviewTimelineDock.tsx'));
const monitorId = bundle(path.join(root, 'components/batch-production/review/BatchSourceMonitor.tsx'));
const previewId = bundle(path.join(root, 'components/final-edit/FinalEditPreview.tsx'));
const mixcutId = bundle(path.join(root, 'components/mixcut/MixcutTimeline.tsx'));
const inspectorId = bundle(path.join(root, 'components/batch-production/review/BatchReviewInspectorDock.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-source-monitor-'));
const media = path.join(tmp, 'source.mp4');
const generated = spawnSync(require('ffmpeg-static'), ['-y','-f','lavfi','-i','testsrc2=size=320x240:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',media], { windowsHide:true });
assert.equal(generated.status, 0, generated.stderr?.toString());
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}),Timeline=load(${timelineId}).default,Monitor=load(${monitorId}).default,Preview=load(${previewId}).FinalEditPreview,Mixcut=load(${mixcutId}).MixcutTimeline;
const asset={assetId:'asset',displayName:'完整素材测试',durationSec:8,previewUrl:'/source.mp4'}, secondAsset={...asset,assetId:'second',displayName:'第二条封面素材'};
const clip={clipId:'clip',assetId:'asset',sourceStartUs:1000000,sourceEndUs:3000000,timelineStartUs:0,timelineEndUs:2000000,playbackRate:1};
if(new URLSearchParams(location.search).has('precise')){clip.sourceStartUs=333333;clip.sourceEndUs=3981607;clip.playbackRate=1.824137;}
const view={planId:'one',outputVersionId:'version',editRevision:0,editable:!new URLSearchParams(location.search).has('locked'),clips:[clip],visualDurationUs:6000000,poolAssets:[asset,secondAsset],coverAssetId:'asset',coverTimeUs:0,coverFraming:{scale:1,offsetX:0,offsetY:0},coverTitle:null,subtitleCues:[],narration:{durationUs:6000000},music:{trackId:null},musicLibrary:[],packaging:{enabled:true,template:'overlay-poster',varsOverrides:{},pointCues:[{id:'p_one',text:'实木稳固',startSec:1.833333,endSec:3.833333}]}};
window.edits=[];window.sourceCloseCount=0;window.mainKeyCalls=0;
function App(){
 const [current,setCurrent]=React.useState(view),[source,setSource]=React.useState(null),[selection,setSelection]=React.useState(null);
 const [coverOpen,setCoverOpen]=React.useState(false),[tab,setTab]=React.useState('packaging');
 const film={planId:'one',seq:1,scriptTitle:'包装轨道测试',status:'reviewable',approved:false,approvable:true,visible:true,durationSec:6,warnings:[],blockers:[],arrangement:current};
 const save=async(plan,edit)=>{if(window.failSave)throw new Error('模拟保存失败');window.edits.push({plan,...edit});if(edit.type==='set_packaging')setCurrent(v=>({...v,packaging:edit.config,editRevision:v.editRevision+1}));if(edit.type==='set_cover')setCurrent(v=>({...v,packaging:edit.packaging,coverAssetId:edit.assetId,coverTimeUs:edit.timeUs,coverFraming:edit.framing,editRevision:v.editRevision+1}));return true;};
 const props={films:[film],projectId:'test',batchId:'test',selection,selectedPlanId:'one',focusedAssetId:null,playheadSec:0,tool:'select',snapEnabled:false,canUndo:false,canRedo:false,poolAssets:[asset],selectedPlanIds:[],rowFilter:'all',batchControlState:'running',phaseEBusy:null};
 for(const name of ['onSelectFocusedAsset','onSeek','onToolChange','onToggleSnap','onUndo','onRedo','onToggleEye','onTogglePlanSelect','onSelectAll','onReview','onRowFilterChange','onShowAll','onReallocate','onRetryNarration','onRetryRender','onRefreshFilm','onOpenCoverEditor','onSelectFilm'])props[name]=()=>{};
 props.onSelectTarget=setSelection;props.onMediaEdit=save;props.onOpenSource=(planId,clipId)=>setSource({view:current,clipId,asset});
 if(new URLSearchParams(location.search).get('mode')==='cover'){
   props.onOpenCoverEditor=()=>{setTab('cover');setCoverOpen(true)};
   return React.createElement(React.Fragment,null,React.createElement('div',{style:{height:440}},React.createElement(load(${inspectorId}).default,{projectId:'test',batchId:'test',outputPreset:'3x4',film,selection,inspectorTab:tab,onTabChange:setTab,poolAssets:[asset,secondAsset],onMediaEdit:save,onJumpToCover:()=>{},onRefreshFilm:async()=>{},coverEditorOpen:coverOpen,onOpenCoverEditor:()=>setCoverOpen(true),onCloseCoverEditor:()=>setCoverOpen(false)})),React.createElement(Timeline,props));
 }
 return React.createElement(React.Fragment,null,source&&React.createElement('div',{style:{height:460,width:800}},React.createElement(Monitor,{session:source,projectId:'test',onApply:save,onClose:()=>{window.sourceCloseCount++;setSource(null)}})),React.createElement(Timeline,props));
}
const group={id:'group',narrationDurationUs:6000000,script:{narrationConfig:{gainDb:0,playbackRate:1}},subtitleCues:[],coverTitle:{enabled:false,primary:{text:''},secondary:{text:''}},textStyles:{'3x4':{},'9x16':{},'16x9':{}}};
const variant={id:'v',outputPreset:new URLSearchParams(location.search).get('ratio')||'3x4',cover:{sourceUrl:''},timeline:{clips:[{id:'one',videoJobId:'single',sourceInFrame:0,sourceOutFrame:144,timelineInFrame:0,timelineOutFrame:144,playbackRate:1}],bodyFrames:144},bgm:{trackId:null,gainDb:0,fadeInSec:0,fadeOutSec:0}};
function Single(){const [t,setT]=React.useState(1.2);return React.createElement('div',{style:{height:650,width:800,display:'flex',flexDirection:'column'}},React.createElement(Preview,{group,variant,assets:[{videoJobId:'single',previewUrl:'/source.mp4',durationUs:8000000}],selectedAsset:null,playheadSec:t,textTarget:null,onPlayheadChange:setT,onTextPositionChange:()=>{}}));}
function SingleTimeline(){const props={variant,cues:[],assets:[],selectedClipId:'',selectedCueId:'',playheadSec:0,disabled:false,narrationPlaybackRate:1,narrationDurationSec:6,pointCues:[],coverSec:20/24,selectedPointId:'',packagingEnabled:true,packagingTemplate:'overlay-poster',activeCueText:''};for(const name of ['onSeek','onSelectClip','onSelectCue','onVariantCommand','onGroupCommand','onTrimClip','onEditCueText','onNarrationPlaybackRatePreview','onNarrationPlaybackRateCommit','onSelectPoint','onPointsChange'])props[name]=()=>{};return React.createElement(Mixcut,props);}
function Overlay(){const [v,setV]=React.useState({...view,packaging:{...view.packaging,varsOverrides:{title:'原标题'}}});return React.createElement('div',{style:{width:400,height:400,position:'relative'}},React.createElement(load(${overlayId}).default,{key:v.editRevision,view:v,src:'/overlay',timeSec:.4,editable:true,onSave:async(plan,edit)=>{window.edits.push(edit);setV(x=>({...x,packaging:edit.config,editRevision:x.editRevision+1}));return true;}}));}
function Menu(){const [v,setV]=React.useState(view);return React.createElement(load(${menuId}).default,{view:v,onJumpToCover:()=>{window.jumpCount=(window.jumpCount||0)+1},onSave:async(config,reextract)=>{window.edits.push({config,reextract});setV(x=>({...x,packaging:config,editRevision:x.editRevision+1}));return true;}});}
function Trim(){return React.createElement('div',{style:{width:760}},React.createElement(load(${trimId}).TrimEditor,{clip:{sourceInFrame:70,sourceOutFrame:118},clipIndex:0,asset:{durationUs:5100000},disabled:false,onCommit:async(a,b)=>{window.trimSaved=[a,b];return true;},onClose:()=>{}}));}
const mode=new URLSearchParams(location.search).get('mode');
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(mode==='overlay'?Overlay:mode==='menu'?Menu:mode==='trim'?Trim:mode==='single'?Single:mode==='tracks'?SingleTimeline:App));
`;
const globalCss=(await postcss([tailwind()]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
const css = `${globalCss}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}video{max-height:100%;max-width:100%}.h-full{height:100%}.w-full{width:100%}.min-h-0{min-height:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.shrink-0{flex-shrink:0}.object-contain{object-fit:contain}.previewColumn{flex:1}${styles.join('\n')}`;
const draftRequests=[];
const server=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api/packaging/system-fonts')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({fonts:[]}));return;}
 if(req.url.includes('/packaging-preview')&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;
   const draft=JSON.parse(body);draftRequests.push(draft);
   const vars={title:'舒适沙发',subtitle:'洁净省心',point1:'舒适支撑',point2:'好打理',point3:'稳固',...draft.config.varsOverrides};
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({vars,html:packagingPreviewHtml({config:draft.config,vars,totalSec:6.833,coverSec:20/24,edit:true})}));return;
 }
 if(req.url.startsWith('/api/packaging/templates/')){
   const relative=decodeURIComponent(req.url.split('?')[0]).replace('/api/packaging/templates/','');
   let file=path.resolve(root,'packaging/templates',relative);
   if(!file.startsWith(path.join(root,'packaging/templates')+path.sep)){res.writeHead(404).end();return;}
   if(!fs.existsSync(file)&&relative.includes('/fonts/'))file=path.join(root,'packaging/fonts',relative.split('/fonts/')[1]);
   if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile()){res.writeHead(404).end();return;}
   res.setHeader('Content-Type',({'.js':'text/javascript','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf'})[path.extname(file).toLowerCase()]||'application/octet-stream');res.end(fs.readFileSync(file));return;
 }
 if(req.url==='/overlay'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html><body><button ondblclick="parent.postMessage({type:\'packaging:text\',id:\'cover:title\',rect:{left:10,top:10,width:100,height:30}},location.origin)">封面标题</button><script>window.__timelines={overlay:{pause(){},seek(){}}}</script></body></html>');}
 else if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(script);}
 else if(req.url.startsWith('/api/batch-production/assets/')||req.url==='/source.mp4'){
   const stat=fs.statSync(media);const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
   const start=match?Number(match[1]):0,end=match&&match[2]?Math.min(stat.size-1,Number(match[2])):stat.size-1;
   res.writeHead(match?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(match?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})});fs.createReadStream(media,{start,end}).pipe(res);
 }else if(req.url.startsWith('/api/')){res.statusCode=404;res.end();}
 else res.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser:',e.message)});
 const origin=`http://127.0.0.1:${server.address().port}`;
 if(!process.argv.includes('--shortcuts-only')&&!process.argv.includes('--cover-only')){
 await page.goto(origin+'/?mode=trim');
 await page.locator('.trimStrip').waitFor();
 const strip=await page.locator('.trimStrip').boundingBox();
 const filmEnd=await page.locator('.trimFrame').last().boundingBox();
 assert.ok(Math.abs(filmEnd.x+filmEnd.width-strip.x-strip.width)<2,'完整素材必须铺满截取条，尾部不能留出无法选择的黑区');
 const trimSelection=await page.locator('.trimSel').boundingBox();
 await page.mouse.move(trimSelection.x+trimSelection.width/2,trimSelection.y+30);await page.mouse.down();await page.mouse.move(strip.x+strip.width+100,trimSelection.y+30,{steps:6});await page.mouse.up();
 const atTail=await page.locator('.trimSel').boundingBox();assert.ok(Math.abs(atTail.x+atTail.width-strip.x-strip.width)<2,'拖动选框能抵达素材条最右侧');
 await page.getByRole('button',{name:'完成',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.trimSaved),[74,122],'选框能准确截取素材尾部的两秒');
 await page.goto(origin+'/?mode=overlay');
 await page.frameLocator('iframe').getByRole('button',{name:'封面标题'}).dblclick();
 await page.getByPlaceholder('留空则该元素不显示').fill('中央预览改标题');await page.getByPlaceholder('留空则该元素不显示').press('Enter');
 await page.waitForFunction(()=>window.edits.length===1);assert.equal(await page.evaluate(()=>window.edits[0].config.varsOverrides.title),'中央预览改标题');assert.equal(await page.evaluate(()=>window.edits[0].expectedEditRevision),0);
 await page.goto(origin+'/?mode=menu');
 await page.getByRole('switch',{name:'启用视频包装'}).waitFor();
 assert.equal(await page.getByRole('radio').count(),4);assert.equal(await page.locator('input:not([type=file]),select').count(),0,'包装菜单不再包含重复文字表单');
 await page.getByRole('radio',{name:'B 手账拼贴'}).click();assert.equal(await page.evaluate(()=>window.edits.at(-1).config.template),'overlay-journal');
 await page.getByRole('button',{name:'跳到封面',exact:true}).click();assert.equal(await page.evaluate(()=>window.jumpCount),1);
 await page.getByRole('button',{name:'重新提取卖点',exact:true}).click();assert.equal(await page.evaluate(()=>window.edits.at(-1).reextract),true);
 await page.goto(origin);
 const point=page.locator('[data-point-cue="p_one"]');await point.waitFor();
 const p=await point.boundingBox(),v=await page.locator('.clipBlock').boundingBox();assert.ok(p.y<v.y,'卖点在视频上方');
 await point.dblclick({position:{x:20,y:10}});await page.getByLabel('卖点文字').fill('双击修改卖点');await page.getByLabel('卖点文字').press('Enter');
 await page.waitForFunction(()=>window.edits.length===1);assert.equal(await page.evaluate(()=>window.edits[0].config.pointCues[0].text),'双击修改卖点');
 const drag=async(locator,dx,cancel=false)=>{const b=await locator.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2,{steps:5});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();};
 await drag(point,60);await page.waitForFunction(()=>window.edits.length===2);const moved=await page.evaluate(()=>window.edits[1].config.pointCues[0]);assert.ok(moved.startSec>2.5);assert.ok(Math.abs(moved.endSec-moved.startSec-2)<0.001);
 await drag(point.locator('.pointHandleRight'),30);await page.waitForFunction(()=>window.edits.length===3);assert.ok((await page.evaluate(()=>window.edits[2].config.pointCues[0].endSec))>moved.endSec);
 await drag(point,30,true);assert.equal(await page.evaluate(()=>window.edits.length),3);
 await point.focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>window.edits.length===4);assert.deepEqual(await page.evaluate(()=>window.edits[3].config.pointCues),[]);
 await page.getByRole('button',{name:'＋卖点',exact:true}).click();await page.waitForFunction(()=>window.edits.length===5);assert.ok((await page.evaluate(()=>window.edits[4].config.pointCues[0].startSec))>=20/24-0.000001);
 await page.locator('.clipBlock').dblclick({position:{x:40,y:24}});await page.locator('[data-source-monitor]').waitFor();
 const video=page.locator('[data-source-monitor] video');await page.waitForFunction(()=>document.querySelector('[data-source-monitor] video')?.readyState>=2);
 assert.ok((await video.evaluate(v=>v.duration))>7.9,'完整源视频而非时间轴两秒选段');
 const selection=page.getByRole('slider',{name:'移动截取选框'});
 assert.equal(await page.getByLabel('源视频入点',{exact:true}).count(),0,'取消独立出入点表单');
 const before=await selection.boundingBox();await drag(selection,80);
 assert.ok((await selection.boundingBox()).x>before.x,'与单条共用的胶片选框可拖动');
 assert.ok(Math.abs((await selection.boundingBox()).width-before.width)<1,'拖动保持选段长度');
 assert.ok((await video.evaluate(v=>v.currentTime))>1,'拖动同步预览入点画面');
 await selection.focus();await page.keyboard.press('End');
 assert.ok(Math.abs((await video.evaluate(v=>v.currentTime))-6)<0.002,'可截取素材最后两秒');
 await page.keyboard.press('ArrowLeft');assert.ok(Math.abs((await video.evaluate(v=>v.currentTime))-(6-1/24))<0.002);
 await page.keyboard.press('End');
 await video.evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('[data-source-monitor] video').currentTime>6.15);await video.evaluate(v=>v.pause());
 fs.mkdirSync(path.join(root,'outputs/review-packaging-acceptance'),{recursive:true});await page.locator('[data-source-monitor]').screenshot({path:path.join(root,'outputs/review-packaging-acceptance/shared-trim.png')});
 await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();assert.equal(await page.evaluate(()=>window.sourceCloseCount),0);
 await page.evaluate(()=>window.failSave=false);await selection.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.sourceCloseCount===1);
 const applied=await page.evaluate(()=>window.edits.at(-1));assert.equal(applied.type,'trim');assert.equal(applied.sourceStartUs,6000000);assert.equal(applied.sourceEndUs,8000000);assert.equal(applied.expectedOutputVersionId,'version');
 await page.locator('.clipBlock').dblclick({position:{x:40,y:24}});await page.getByRole('slider',{name:'移动截取选框'}).focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>window.sourceCloseCount===2);
 assert.equal(await page.evaluate(()=>window.edits.length),6,'取消截取不提交');
 assert.ok((await video.count())===0);
 await page.goto(origin+'/?precise');await page.locator('.clipBlock').dblclick({position:{x:40,y:24}});
 await page.waitForFunction(()=>document.querySelector('[data-source-monitor] video')?.readyState>=2);
 await page.getByRole('slider',{name:'移动截取选框'}).focus();await page.keyboard.press('End');
 assert.ok((await page.locator('[data-source-monitor] video').boundingBox()).height>230,'800px 预览区域中视频保留足够高度');
 await page.getByRole('button',{name:'完成',exact:true}).click();await page.waitForFunction(()=>window.sourceCloseCount===1);
 const preciseEdit=await page.evaluate(()=>window.edits.at(-1));assert.equal(preciseEdit.sourceEndUs-preciseEdit.sourceStartUs,3648274);assert.ok(preciseEdit.sourceEndUs<=8000000,'尾部截取不越素材时长');
 await page.goto(origin+'/?mode=tracks');await page.locator('[data-track=video]').waitFor();assert.deepEqual(await page.locator('[data-track]').evaluateAll(els=>els.map(el=>el.dataset.track)),['subtitle','point','video','narration','bgm']);await page.goto(origin+'/?mode=single');await page.getByLabel('全屏预览').click();await page.waitForFunction(()=>!!document.fullscreenElement);
 const stage=await page.locator('.previewStage').boundingBox();assert.ok(stage.height>750,`全屏画面必须适配窗口，而非锁在500px: ${stage.height}`);assert.ok(Math.abs(stage.width/stage.height-0.75)<0.005);
 fs.mkdirSync(path.join(root,'outputs/review-packaging-acceptance'),{recursive:true});await page.screenshot({path:path.join(root,'outputs/review-packaging-acceptance/fullscreen.png')});
 await page.getByLabel('退出全屏').click();await page.waitForFunction(()=>!document.fullscreenElement);
 for(const [ratio,expected] of [['9x16',9/16],['16x9',16/9]]){await page.goto(origin+'/?mode=single&ratio='+ratio);await page.getByLabel('全屏预览').click();await page.waitForFunction(()=>!!document.fullscreenElement);const box=await page.locator('.previewStage').boundingBox();assert.ok(Math.abs(box.width/box.height-expected)<0.005);assert.ok(box.width>1400||box.height>750);await page.getByLabel('退出全屏').click();}
 }
 fs.mkdirSync(path.join(root,'outputs/review-packaging-acceptance'),{recursive:true});
 if(process.argv.includes('--cover-only')){
   page.setDefaultTimeout(15000);
   await page.goto(origin+'/?mode=cover');
   await page.getByTitle('点击精调封面',{exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'精调封面'});
   const coverFrame=()=>page.frameLocator('iframe[title="包装版式编辑"]');
   const waitPreview=async()=>{
     await page.locator('iframe[title="包装版式编辑"]').waitFor();
     await page.waitForFunction(()=>!!document.querySelector('iframe[title="包装版式编辑"]')?.contentWindow?.__timelines?.overlay);
     await coverFrame().locator('body').evaluate(async()=>{await document.fonts.ready});
   };
   const editTitle=async(text)=>{
     await waitPreview();
     await coverFrame().locator('[data-point-id="cover:title"]').dblclick();
     await page.getByPlaceholder('留空则该元素不显示').fill(text);
     await page.getByPlaceholder('留空则该元素不显示').press('Enter');
     await page.waitForFunction(text=>document.querySelector('iframe[title="包装版式编辑"]')?.contentDocument?.querySelector('[data-point-id="cover:title"]')?.textContent===text,text);
   };
   await dialog.waitFor();await waitPreview();
   assert.equal(await dialog.getByRole('radio').count(),4,'精调抽屉包含包装模板');
   assert.equal(await dialog.getByLabel('缩放',{exact:true}).count(),1,'精调抽屉同时包含画面构图');
   assert.equal(await dialog.getByLabel('主标题文字',{exact:true}).count(),0,'开启包装时不显示无效的旧标题表单');
   await dialog.getByRole('button',{name:'模板原生字体',exact:true}).first().click();
   await dialog.getByLabel('搜索字体名称').fill('测试字体');
   const fontPanel=await dialog.locator('.pkFontPop').boundingBox(),dialogBox=await dialog.boundingBox();
   assert.ok(fontPanel.x>=dialogBox.x&&fontPanel.x+fontPanel.width<=dialogBox.x+dialogBox.width,'抽屉中的字体面板不超出右栏');
   await page.keyboard.press('Escape');
   assert.equal(await dialog.locator('.pkFontPop').count(),0,'Esc 先关闭字体菜单');
   assert.equal(await dialog.count(),1,'关闭字体菜单不会关闭封面草稿');
   await editTitle('取消的封面标题');
   await dialog.getByRole('button',{name:'移动画面',exact:true}).click();
   const scale=dialog.getByLabel('缩放',{exact:true});
   await scale.focus();await scale.press('Home');await scale.press('ArrowRight');
   const figure=dialog.getByLabel('封面实时预览',{exact:true});
   const frameBox=await figure.boundingBox();
   await page.mouse.move(frameBox.x+frameBox.width/2,frameBox.y+frameBox.height/2);await page.mouse.down();
   await page.mouse.move(frameBox.x+frameBox.width/2+35,frameBox.y+frameBox.height/2+20,{steps:5});await page.mouse.up();
   assert.ok(Math.abs(Number(await dialog.getByLabel('水平位置',{exact:true}).inputValue()))>0.01,'可直接拖动封面底图');
   await dialog.getByTitle('选择素材「第二条封面素材」',{exact:true}).click();
   await dialog.getByLabel('封面截帧时间').focus();await page.keyboard.press('ArrowRight');
   assert.equal(await page.evaluate(()=>window.edits.length),0,'编辑包装与画面均只改草稿');
   await dialog.getByRole('button',{name:'取消',exact:true}).click();
   assert.equal(await dialog.count(),0);
   assert.equal(await page.evaluate(()=>window.edits.length),0,'取消不保存任何配置');
   await page.getByRole('button',{name:'封面',exact:true}).click();await waitPreview();
   assert.equal(await coverFrame().locator('[data-point-id="cover:title"]').textContent(),'舒适沙发','右侧封面打开同一编辑器，取消内容未残留');
   assert.equal(await scale.inputValue(),'1');
   await editTitle('舒适又省心');
   // 真正拖动模板文字，确认包装版式与构图可一起保存。
   const titleBox=await coverFrame().locator('[data-point-id="cover:title"]').boundingBox();
   await page.mouse.move(titleBox.x+titleBox.width/2,titleBox.y+titleBox.height/2);await page.mouse.down();
   await page.mouse.move(titleBox.x+titleBox.width/2+18,titleBox.y+titleBox.height/2+22,{steps:5});await page.mouse.up();
   await page.waitForFunction(()=>!!document.querySelector('iframe[title="包装版式编辑"]')?.contentWindow?.__timelines?.overlay);
   await dialog.getByTitle('选择素材「第二条封面素材」',{exact:true}).click();
   await dialog.getByLabel('封面截帧时间').press('ArrowRight');
   await scale.press('ArrowRight');await scale.press('ArrowRight');
   for(const theme of ['light','dark']){
     await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
     await waitPreview();await dialog.screenshot({path:path.join(root,`outputs/review-packaging-acceptance/merged-cover-${theme}.png`)});
   }
   const geometry=async()=>coverFrame().locator('[data-point-id="cover:title"]').evaluate(el=>{const rect=el.getBoundingClientRect(),root=document.querySelector('#root').getBoundingClientRect();return {x:rect.x/root.width,y:rect.y/root.height,w:rect.width/root.width,h:rect.height/root.height};});
   const beforeResize=await geometry();
   await page.setViewportSize({width:1024,height:720});
   await coverFrame().locator('body').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const afterResize=await geometry();
   for(const field of Object.keys(beforeResize))assert.ok(Math.abs(beforeResize[field]-afterResize[field])<.008,'抽屉缩小后包装文字比例保持稳定: '+field);
   const narrowCanvas=await dialog.locator('.coverCanvasWrap').boundingBox(),footer=await dialog.locator('footer').boundingBox();
   assert.ok(narrowCanvas.y+narrowCanvas.height<footer.y,'窄窗口中完整封面不被底部应用栏遮挡');
   await dialog.screenshot({path:path.join(root,'outputs/review-packaging-acceptance/merged-cover-narrow.png')});
   await page.setViewportSize({width:1440,height:900});
   await dialog.getByRole('button',{name:'应用封面',exact:true}).click();
   await page.waitForFunction(()=>window.edits.length===1);
   assert.equal(await dialog.count(),0);
   const edit=await page.evaluate(()=>window.edits[0]);
   assert.equal(edit.type,'set_cover');assert.equal(edit.assetId,'second');assert.equal(edit.timeUs,41667);
   assert.equal(edit.framing.scale,1.1);assert.equal(edit.packaging.varsOverrides.title,'舒适又省心');
   assert.ok(edit.packaging.layouts?.['overlay-poster']?.cover?.title,'文字拖动的版式一起保存');
   assert.equal(edit.title,undefined,'未改旧标题时不覆盖其自动默认文案');
   assert.equal(edit.expectedEditRevision,0);assert.equal(edit.expectedOutputVersionId,'version');
   assert.deepEqual(edit.packaging.pointCues,viewPointCues(),'封面调整不改变正片卖点时序');
   await page.getByRole('button',{name:'封面',exact:true}).click();await waitPreview();
   assert.equal(await scale.inputValue(),'1.1');
   assert.equal(await coverFrame().locator('[data-point-id="cover:title"]').textContent(),'舒适又省心');
   await editTitle('失败后保留的草稿');await page.evaluate(()=>window.failSave=true);
   await dialog.getByRole('button',{name:'应用封面',exact:true}).click();
   await dialog.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();
   assert.equal(await page.evaluate(()=>window.edits.length),1);
   assert.equal(await coverFrame().locator('[data-point-id="cover:title"]').textContent(),'失败后保留的草稿');
   await page.evaluate(()=>window.failSave=false);
   await dialog.getByRole('button',{name:'应用封面',exact:true}).click();
   await page.waitForFunction(()=>window.edits.length===2);
   assert.equal(await page.evaluate(()=>window.edits[1].expectedEditRevision),1);
   assert.ok(draftRequests.length>0);
   await page.goto(origin+'/?mode=cover&locked');
   await page.getByRole('button',{name:'封面',exact:true}).click();
   assert.ok(await dialog.getByRole('button',{name:'暂不可编辑',exact:true}).isDisabled());
   await dialog.getByRole('button',{name:'取消',exact:true}).click();
   assert.equal(await dialog.count(),0,'不可编辑的成片仍可正常关闭抽屉');
 }
 for(const mode of process.argv.includes('--cover-only')?[]:['tracks','batch']){
   await page.goto(origin+'/?mode='+mode);
   const trigger=page.getByRole('button',{name:'快捷键说明',exact:true});
   await trigger.click();
   const dialog=page.getByRole('dialog',{name:'时间轴快捷键'});
   await dialog.waitFor();
   assert.equal(await dialog.locator('kbd').count(),12);
   const box=await dialog.boundingBox();
   assert.ok(Math.abs(box.x+box.width/2-720)<2,'快捷键弹窗在视口居中，不占时间轴布局');
   await page.keyboard.press('Tab');
   assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)),'Tab 焦点留在模态说明内');
   for(const theme of ['light','dark']){
     await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
     await dialog.screenshot({path:path.join(root,`outputs/review-packaging-acceptance/shortcuts-${mode}-${theme}.png`)});
   }
   await page.keyboard.press('Escape');
   assert.equal(await dialog.count(),0);
   assert.ok(await trigger.evaluate(el=>el===document.activeElement),'关闭后焦点回到入口');
   await trigger.click();await page.mouse.click(8,8);assert.equal(await dialog.count(),0,'点击遮罩关闭');
 }
 assert.deepEqual(errors,[]);console.log(process.argv.includes('--cover-only')?'Merged cover: both entries, real template text/layout editing, framing drag, source/time, cancel, combined save and failed-save draft recovery passed':process.argv.includes('--shortcuts-only')?'Shared shortcuts dialog: single/batch, light/dark, modal focus, Escape and backdrop dismissal passed':'packaging track gestures, full source playback, shared fixed-duration trim, preview/frame shortcuts, saved range, responsive fullscreen and shared shortcuts dialog passed');
}catch(error){console.error(error);throw error;}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}

function viewPointCues(){return [{id:'p_one',text:'实木稳固',startSec:1.833333,endSec:3.833333}];}
