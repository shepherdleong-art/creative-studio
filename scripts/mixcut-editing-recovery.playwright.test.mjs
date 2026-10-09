// Run: node scripts/batch-review-snapping.playwright.test.mjs
// Real timeline + CSS in an isolated browser fixture; no app service or user DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

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
const previewId = bundle(path.join(root, 'components/mixcut/PreviewStep.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const fixture = `const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function textStyle(fontSizePx, y) {
  return {
    fontFamily: 'Arial',
    fontSizePx,
    italic: false,
    x: 0.5,
    y,
    scale: 1,
    color: '#ffffff',
    align: 'center',
    boxWidthPx: 800,
    lineHeight: 1.2,
    stroke: { enabled: true, color: '#000000', widthPx: 2 },
    shadow: { enabled: false, color: '#000000', opacity: 0.4, blurPx: 4, distancePx: 2, angleDeg: 90 },
  };
}

function createFormalGroup() {
  const styles = {
    coverPrimary: textStyle(72, 0.35),
    coverSecondary: textStyle(44, 0.48),
    subtitle: textStyle(48, 0.84),
  };
  return {
    id: 'group-e2e',
    projectId: 'e2e-project',
    scriptDraftId: 'draft-e2e',
    shotSetId: 'shot-set-e2e',
    status: 'ready',
    phase: 'ready',
    revision: 4,
    script: {
      sourceDraftId: 'draft-e2e',
      title: 'E2E 文案',
      importedNarrationText: '第一句。第二句。',
      editedNarrationText: '第一句。第二句。',
      syncState: 'synced',
      sourceScriptUpdatedAt: '2026-07-24T00:00:00.000Z',
      narrationConfig: { providerId: 'tts-e2e', voice: 'voice-e2e', speed: 1, playbackRate: 1, gainDb: 0 },
      selectedMaterialKeys: ['module4:video-a', 'module4:video-b'],
    },
    narrationDurationUs: 10_000_000,
    totalDurationUs: 10_833_333,
    coverTitle: {
      primary: { id: 'primary', text: '正式页面测试', textSource: 'script' },
      secondary: { id: 'secondary', text: 'Mixcut Phase 4', textSource: 'script' },
    },
    subtitleCues: [
      { id: 'cue-a', segmentId: 'segment-a', text: '第一句', startUs: 0, endUs: 5_000_000, textSource: 'script', timingSource: 'aligned' },
      { id: 'cue-b', segmentId: 'segment-b', text: '第二句', startUs: 5_000_000, endUs: 10_000_000, textSource: 'script', timingSource: 'aligned' },
    ],
    textStyles: { '3x4': structuredClone(styles), '9x16': structuredClone(styles), '16x9': structuredClone(styles) },
    variants: [{
      id: 'variant-e2e',
      indexNum: 1,
      outputPreset: '3x4',
      timeline: {
        fps: 24,
        introFrames: 20,
        bodyFrames: 240,
        clips: [
          { id: 'clip-a', videoJobId: 'video-a', sourceFingerprint: 'fingerprint-a', sourceInFrame: 0, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 120, boundSegmentId: 'segment-a', framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false },
          { id: 'clip-b', videoJobId: 'video-b', sourceFingerprint: 'fingerprint-b', sourceInFrame: 0, sourceOutFrame: 120, timelineInFrame: 120, timelineOutFrame: 240, boundSegmentId: 'segment-b', framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false },
        ],
      },
      bgm: { trackId: null, gainDb: -12, loop: true, fadeInSec: 0.5, fadeOutSec: 0.8 },
      cover: { coverKey: 'video:video-a:1000000', kind: 'video_keyframe', sourceKey: 'module4:video-a', frameTimeUs: 1_000_000, sourceUrl: '/api/final-edit-groups/group-e2e/cover-frame?sourceKey=module4%3Avideo-a&timeUs=1000000&preset=3x4', framing: { scale: 1, offsetX: 0, offsetY: 0 } },
      issues: [],
      maxOverlap: 1,
      revision: 7,
      lastRenderedRevision: null,
      renderStatus: null,
      previewUrl: null,
    }],
    // 素材时长比片段用量长（8s 素材只用了前 5s），给 Trim 截取条留出可拖拽的余量；
    // clip 的 sourceInFrame/sourceOutFrame 若正好等于素材全长，选择框会撑满整条、拖不动。
    assets: [
      { assetKey: 'module4:video-a', source: 'module4', videoJobId: 'video-a', shotSetId: 'shot-set-e2e', shotId: 'shot-a', filename: 'a.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-a', analysisStatus: 'succeeded', summary: '素材 A', autoUseDisabled: false, usageCount: 1 },
      { assetKey: 'module4:video-b', source: 'module4', videoJobId: 'video-b', shotSetId: 'shot-set-e2e', shotId: 'shot-b', filename: 'b.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-b', analysisStatus: 'succeeded', summary: '素材 B', autoUseDisabled: false, usageCount: 1 },
    ],
    bgmTracks: [{
      id: 'bgm-e2e',
      filename: 'e2e.mp3',
      relativePath: 'bgm/e2e.mp3',
      durationUs: 20_000_000,
    }],
    coverCandidates: [{ coverKey: 'cover-e2e', sourceUrl: transparentPixel, kind: 'storyboard_image' }],
    jobs: [{ id: 'job-e2e', variantId: null, kind: 'prepare', status: 'succeeded', phase: 'ready', progress: 1, estimatedCost: null, costCurrency: 'CNY', errorCode: null, errorMessage: null, startedAt: '2026-07-24T00:00:00.000Z', finishedAt: '2026-07-24T00:00:10.000Z', createdAt: '2026-07-24T00:00:00.000Z' }],
  };
}

`;
const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if(cache[id]) return cache[id].exports; const m=cache[id]={exports:{}}; const [fn,deps]=modules[id]; fn(r=>load(deps[r]),m,m.exports); return m.exports; }
const React=load(${reactId}), Preview=load(${previewId}).PreviewStep;
${fixture}
window.group = createFormalGroup(); window.group.assets[1].analysisStatus = 'failed'; window.requests=[];
window.revisions = { 7: structuredClone(window.group.variants[0]) };
window.fetch = async (url, options = {}) => {
 const body = options.body ? JSON.parse(options.body) : {};
 window.requests.push({url, ...body});
 if(url.includes('/reanalyze')) {
  if(window.failAnalysis) return new Response(JSON.stringify({message:'模拟 400'}), {status:400});
  window.group.assets[1].analysisStatus='succeeded';
  return new Response(JSON.stringify(window.group));
 }
 if(options.method === 'PATCH' && url.includes('/final-edit-variants/')) {
  let v = structuredClone(window.group.variants[0]); const rev = v.revision+1;
  if(body.type==='delete_clip') v.timeline.clips=v.timeline.clips.filter(c=>c.id!==body.clipId);
  if(body.type==='restore_revision') v=structuredClone(window.revisions[body.revision]);
  v.revision=rev; window.group.variants[0]=v; window.revisions[rev]=structuredClone(v);
  return new Response(JSON.stringify({view:v}));
 }
 if(url.includes('/final-edit-groups/')) return new Response(JSON.stringify(window.group));
 return new Response(JSON.stringify([]));
};
function App(){const [group,setGroup]=React.useState(window.group); return React.createElement(Preview,{group,active:true,onGroupChange:g=>{window.group=g;setGroup(g)},onExport:()=>{},onRepCollapse:()=>{},onRgtCollapse:()=>{},onResizeStart:()=>()=>{}});}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = http.createServer((req, res) => {
 if(req.url === '/fixture.js') {res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(script)}
 else if(req.url === '/') res.end(`<html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;--ink:#222;--paper:#fff;--line:#ddd;--sub:#555;--seg:#eee}#root{display:flex;flex-wrap:wrap}.mainCol{width:900px;min-height:650px}.replaceCol{width:310px}${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
 else {res.statusCode=404;res.end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1200}});
 const errors=[];page.on('pageerror',e=>{errors.push(e.message); console.error(e.message)});page.setDefaultTimeout(5000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByTitle('选择素材「b.mp4」', {exact:true}).click();
 await page.locator('[data-clip-id="clip-a"]').click();
 assert.equal(await page.getByRole('button',{name:'替换当前片段',exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.failAnalysis=true);
 await page.getByRole('button',{name:'重新分析素材 b.mp4',exact:true}).click();
 await page.getByText(/素材分析失败，可再次重试/).waitFor();
 await page.evaluate(()=>window.failAnalysis=false);
 await page.getByRole('button',{name:'重新分析素材 b.mp4',exact:true}).click();
 await page.getByText('素材分析完成，可以添加或替换片段').waitFor();
 assert.equal(await page.getByRole('button',{name:'替换当前片段',exact:true}).isEnabled(),true);
 await page.getByLabel('时间轴缩放').fill('240');
 await page.getByLabel('播放位置').fill('6');
 await page.locator('[data-testid="mixcut-timeline-scroll"]').evaluate(el=>{el.scrollLeft=800});
 const playheadX=()=>page.getByRole('button',{name:'拖动播放头'}).evaluate(el=>el.getBoundingClientRect().left);
 const anchorX=await playheadX();
 await page.getByLabel('时间轴缩放').fill('120');
 assert.ok(Math.abs(await playheadX()-anchorX)<=1, '单条缩放也应固定播放头位置');
 await page.getByLabel('时间轴缩放').focus();
 await page.keyboard.press('+');
 assert.equal(await page.getByLabel('时间轴缩放').inputValue(),'140');
 assert.ok(Math.abs(await playheadX()-anchorX)<=1, '滑条聚焦后快捷键缩放仍保持锚点');
 await page.keyboard.press('-');
 assert.equal(await page.getByLabel('时间轴缩放').inputValue(),'120');
 await page.getByLabel('时间轴缩放').fill('60');
 await page.getByLabel('时间轴缩放').evaluate(el=>el.blur());

 await page.locator('[data-clip-id="clip-a"]').click();
 await page.keyboard.press('Delete');
 await page.waitForFunction(()=>!window.group.variants[0].timeline.clips.some(c=>c.id==='clip-a'));
 await expect(page.getByTitle('撤销 (⌘/Ctrl+Z)')).toBeEnabled();
 await page.keyboard.press('Control+z');
 await page.waitForFunction(()=>window.group.variants[0].timeline.clips.some(c=>c.id==='clip-a'));
 await expect(page.getByTitle('重做 (⌘/Ctrl+Shift+Z)')).toBeEnabled();
 await page.keyboard.press('Control+Shift+z');
 await page.waitForFunction(()=>!window.group.variants[0].timeline.clips.some(c=>c.id==='clip-a'));
 await expect(page.getByTitle('撤销 (⌘/Ctrl+Z)')).toBeEnabled();
 await page.keyboard.press('Control+z');
 await page.locator('[data-clip-id="clip-a"]').waitFor();
 await page.keyboard.press('b');
 assert.equal(await page.getByRole('button',{name:'分割工具',exact:true}).getAttribute('aria-pressed'),'true');
 await page.keyboard.press('v');
 await page.keyboard.press('+');
 assert.equal(await page.getByLabel('时间轴缩放').inputValue(),'80');
 await page.keyboard.press('n');
 assert.equal(await page.getByTitle('视频磁吸 (N)，Alt 临时关闭').getAttribute('aria-pressed'),'false');
 await page.locator('[data-clip-id="clip-a"]').click();
 const slider=page.getByLabel('播放位置');const before=Number(await slider.inputValue());
 await page.keyboard.press('Shift+ArrowRight');
 assert.ok(Math.abs(Number(await slider.inputValue())-before-10/24)<0.001);
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Control+b');
 assert.ok((await page.evaluate(()=>window.requests)).some(r=>r.type==='split_clip'));
 // Text input and dialogs must retain their own keyboard handling.
 const count=await page.evaluate(()=>window.requests.length);
 await page.evaluate(()=>{const input=document.createElement('input');input.id='typing';document.body.append(input);input.focus()});
 await page.keyboard.press('Backspace');await page.keyboard.press('Control+b');
 assert.equal(await page.evaluate(()=>window.requests.length),count);
 await page.getByRole('button',{name:'快捷键',exact:true}).click();
 await page.keyboard.press('Delete');
 assert.equal(await page.evaluate(()=>window.requests.length),count);
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog',{name:'时间轴快捷键'}).count(),0);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/mixcut-editing-recovery.png', fullPage:false});
 console.log('single reanalysis recovery, shortcuts, undo/redo, frame stepping and focus guards passed');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
