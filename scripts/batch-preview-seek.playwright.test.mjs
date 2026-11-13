// Run: node scripts/batch-preview-seek.playwright.test.mjs
// Real timeline ruler/playhead + H.264 preview, isolated from app services and user DB.
// Optional argument: chromium or webkit. Windows WebKit without rVFC reports a pixel-validation gap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';
import ffmpeg from 'ffmpeg-static';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
assert.ok(!process.argv[2] || ['chromium', 'webkit'].includes(process.argv[2]), 'Optional browser must be chromium or webkit');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preview-seek-'));
const modules = new Map(), styles = [];
function bundle(filename) {
    if (modules.has(filename))
        return modules.get(filename).id;
    const entry = { id: modules.size, source: '', deps: {} };
    modules.set(filename, entry);
    const raw = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.css')) {
        styles.push(raw);
        entry.source = 'module.exports=' + JSON.stringify(Object.fromEntries([...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => [m[1], m[1]])));
        return entry.id;
    }
    entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText : raw;
    const require = createRequire(filename);
    for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
        const local = request.startsWith('@/') ? path.join(root, request.slice(2)) : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
        const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        entry.deps[request] = bundle(resolved || require.resolve(request));
    }
    return entry.id;
}
const fixtureCss = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);') + '\n@source "../components/batch-production";\n@source "../components/ui";\n@source "../components/audio";\n@source "../components/timeline";';
const globalCss = (await postcss([tailwind()]).process(fixtureCss, { from: path.join(root, 'app/globals.css') })).css;
const previewId = bundle(path.join(root, 'components/batch-production/BatchTimelinePreview.tsx'));
const timelineId = bundle(path.join(root, 'components/batch-production/review/BatchReviewTimelineDock.tsx'));
const require = createRequire(import.meta.url), reactId = bundle(require.resolve('react')), domId = bundle(require.resolve('react-dom/client'));
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const[fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}),Preview=load(${previewId}).default,Timeline=load(${timelineId}).default;
const clips=[{clipId:'a',assetId:'a',sourceStartUs:0,sourceEndUs:8000000,timelineStartUs:0,timelineEndUs:8000000,playbackRate:1}];
const assets={a:{previewUrl:'/a.mp4',originalUrl:'/a.mp4'}};
const poolAssets=['a'].map(assetId=>({assetId,displayName:assetId,durationSec:8,previewUrl:'/'+assetId+'.mp4'}));
const film={planId:'one',seq:1,scriptTitle:'diagnosis',status:'reviewable',approved:false,approvable:true,visible:true,durationSec:8,warnings:[],blockers:[],arrangement:{editable:true,clips,subtitleCues:[],narration:{durationUs:8000000},music:{trackId:null},musicLibrary:[]}};
function App(){
 const[time,setTime]=React.useState(.5);window.__bodyTime=time;
 const props={projectId:'diagnosis',batchId:'diagnosis',films:[film],selectedPlanId:'one',selection:null,focusedAssetId:null,playheadSec:time,onSeek:setTime,tool:'select',snapEnabled:false,canUndo:false,canRedo:false,poolAssets,selectedPlanIds:[],rowFilter:'all',batchControlState:'stopped',phaseEBusy:null};
 for(const name of ['onSelectFilm','onSelectTarget','onSelectFocusedAsset','onToolChange','onToggleSnap','onUndo','onRedo','onToggleEye','onTogglePlanSelect','onSelectAll','onReview','onRowFilterChange','onShowAll','onReallocate','onRetryNarration','onRetryRender','onRefreshFilm','onOpenCoverEditor'])props[name]=()=>{};
 props.onMediaEdit=async()=>{throw Error('Diagnostic must never save edits')};
 return React.createElement(React.Fragment,null,React.createElement('div',{style:{height:360}},React.createElement(Preview,{clips,assetsById:assets,preserveGaps:true,coverUrl:null,subtitleCues:[],narrationUrl:null,narrationGainDb:0,bgm:null,outputPreset:'3x4',playheadSec:time+20/24,onSeek:sec=>setTime(sec-20/24),compact:true})),React.createElement('div',{style:{height:500}},React.createElement(Timeline,props)));
}load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;
let server, browser;
const requests = [], errors = [], failures = [];
// A separately decoded reference proves the final canvas contains the requested frame.
// WebKit media time is quantized by a few milliseconds; keep position tolerance below half a 24fps frame.
async function expectLatestFrame(page, target, verifyPixels) {
    await page.waitForFunction(target => {
        const video = document.querySelector('[data-media-frame] > video');
        return video && !video.seeking && video.readyState >= 2 && Math.abs(window.__bodyTime - target) < .03 && Math.abs(video.currentTime - Math.floor(target * 24) / 24) < .02;
    }, target, { timeout: 5000 }).catch(async (error) => {
        console.error(JSON.stringify({ stage: 'seek-position', target, ...await page.evaluate(() => ({ bodyTime: window.__bodyTime, videos: Array.from(document.querySelectorAll('[data-media-frame] > video')).map(video => ({ src: video.getAttribute('src'), time: video.currentTime, readyState: video.readyState, seeking: video.seeking, error: video.error?.code })) })) }));
        throw error;
    });
    if (!verifyPixels)
        return;
    await page.evaluate(async () => {
        const video = document.querySelector('[data-media-frame] > video'), reference = window.__reference;
        // Resolve only when the independent decoder submits this target frame.
        await new Promise((resolve, reject) => {
            let handle = 0;
            const timer = setTimeout(() => { reference.cancelVideoFrameCallback(handle); reject(Error('Reference decoder did not submit the target frame')); }, 5000);
            const waitForFrame = () => {
                handle = reference.requestVideoFrameCallback((_now, metadata) => {
                    if (Math.abs(metadata.mediaTime - video.currentTime) <= 1 / 24) {
                        clearTimeout(timer);
                        resolve();
                    }
                    else
                        waitForFrame();
                });
            };
            waitForFrame();
            reference.currentTime = video.currentTime;
        });
        const output = document.querySelector('[data-media-frame] > canvas');
        const expected = document.createElement('canvas');
        expected.width = output.width;
        expected.height = output.height;
        expected.getContext('2d').drawImage(reference, 0, 0, expected.width, expected.height);
        window.__expectedSamples = [];
        for (let y = 1; y < 12; y++)
            for (let x = 1; x < 12; x++) {
                const px = Math.floor(expected.width * x / 12), py = Math.floor(expected.height * y / 12);
                window.__expectedSamples.push({ x: px, y: py, rgba: Array.from(expected.getContext('2d').getImageData(px, py, 1, 1).data) });
            }
    });
    await page.waitForFunction(() => {
        const context = document.querySelector('[data-media-frame] > canvas').getContext('2d');
        return window.__expectedSamples.every(({ x, y, rgba }) => Array.from(context.getImageData(x, y, 1, 1).data).every((value, i) => Math.abs(value - rgba[i]) <= 2));
    }, null, { timeout: 5000 }).catch(async (error) => {
        console.error(JSON.stringify(await page.evaluate(() => {
            const video = document.querySelector('[data-media-frame] > video'), reference = window.__reference, context = document.querySelector('[data-media-frame] > canvas').getContext('2d');
            const direct = document.createElement('canvas');
            direct.width = direct.height = 1;
            direct.getContext('2d').drawImage(video, 0, 0, 1, 1);
            return { directVideoPixel: Array.from(direct.getContext('2d').getImageData(0, 0, 1, 1).data), rvfc: typeof video.requestVideoFrameCallback, stageBounds: video.parentElement.getBoundingClientRect().toJSON(), stage: 'latest-frame-pixels', bodyTime: window.__bodyTime, videoTime: video.currentTime, referenceTime: reference.currentTime, readyState: video.readyState, seeking: video.seeking, samples: window.__expectedSamples.slice(30, 36).map(({ x, y, rgba }) => ({ x, y, expected: rgba, actual: Array.from(context.getImageData(x, y, 1, 1).data) })) };
        })));
        throw error;
    });
}
try {
    const file = path.join(temp, 'fixture.mp4');
    const fixtureColors = ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan', 'white', 'orange'];
    const videoInput = fixtureColors.map((color, index) => 'color=c=' + color + ':s=384x512:r=24:d=1[v' + index + ']').join(';') + ';' + fixtureColors.map((_, index) => '[v' + index + ']').join('') + 'concat=n=8:v=1:a=0';
    const render = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', videoInput, '-c:v', 'libx264', '-g', '192', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(render.status, 0, render.error?.message || render.stderr);
    const bytes = fs.readFileSync(file);
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/fixture.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(script);
            return;
        }
        if (url.pathname.endsWith('.mp4')) {
            requests.push({ path: url.pathname, range: req.headers.range ?? null, at: Date.now() });
            const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ''), start = match ? Number(match[1]) : 0, end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
            res.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public,max-age=3600', 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
            res.end(bytes.subarray(start, end + 1));
            return;
        }
        if (url.pathname !== '/') {
            res.writeHead(404).end();
            return;
        }
        res.setHeader('Content-Type', 'text/html;charset=utf-8');
        res.end(`<html><head><style>*{box-sizing:border-box}body{margin:0;--color-accent:#007aff;--color-surface:#fff;--color-hairline:#ddd;--color-surface-subtle:#eee}${globalCss}\n${styles.join('\n')}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
        if (process.argv[2] && name !== process.argv[2])
            continue;
        requests.length = 0;
        errors.length = 0;
        browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
        const stageBounds = await page.locator('[data-media-frame]').boundingBox();
        console.log(JSON.stringify({ browser: name, stageBounds }));
        assert.ok(stageBounds && stageBounds.width >= 64 && stageBounds.height >= 64, name + ': visible preview stage must have a usable size');
        await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-media-frame] > video')).filter(v => v.currentSrc).every(v => v.readyState >= 2 && !v.seeking));
        const hasVideoFrameCallback = await page.locator('[data-media-frame] > video').first().evaluate(video => typeof video.requestVideoFrameCallback === 'function');
        const verifyPixels = name !== 'webkit' || hasVideoFrameCallback;
        if (!verifyPixels)
            console.log('GAP: this Windows Playwright WebKit port has no requestVideoFrameCallback; paused-seek canvas pixels cannot be reliably verified. Loading, seek position, media identity and network checks remain enabled.');
        if (verifyPixels) {
            await page.evaluate(async () => {
                const reference = document.createElement('video');
                reference.muted = true;
                reference.preload = 'auto';
                const loaded = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Reference H.264 did not load')), 10000); reference.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true }); reference.addEventListener('error', () => { clearTimeout(timer); reject(Error('Reference H.264 failed to decode')); }, { once: true }); });
                reference.style.cssText = 'position:fixed;right:0;top:0;width:96px;height:128px;pointer-events:none';
                document.body.append(reference);
                reference.src = '/reference.mp4';
                window.__reference = reference;
                reference.load();
                await loaded;
            });
        }
        await page.evaluate(() => { window.__videoInstances = Array.from(document.querySelectorAll('[data-media-frame] > video')); });
        await page.evaluate(() => {
            window.__events = [];
            window.__loading = [];
            window.__rafLoading = [];
            const snapshot = () => Array.from(document.querySelectorAll('[data-media-frame] > video')).filter(v => v.currentSrc).map(v => ({ src: new URL(v.currentSrc).pathname, ready: v.readyState, seeking: v.seeking, time: v.currentTime, buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]) }));
            document.querySelectorAll('[data-media-frame] > video').forEach((v, slot) => ['seeking', 'seeked', 'loadstart', 'loadeddata', 'waiting', 'stalled', 'error'].forEach(type => v.addEventListener(type, () => window.__events.push({ type, slot, at: performance.now(), videos: snapshot() }))));
            new MutationObserver(() => {
                const loading = Array.from(document.querySelectorAll('[role="status"]')).some(el => el.textContent.includes('正在准备视频预览'));
                if (loading !== window.__wasLoading) {
                    window.__loading.push({ loading, at: performance.now(), bodyTime: window.__bodyTime, videos: snapshot() });
                    window.__wasLoading = loading;
                }
            }).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true });
            const frame = () => {
                if (Array.from(document.querySelectorAll('[role="status"]')).some(el => el.textContent.includes('正在准备视频预览')))
                    window.__rafLoading.push({ at: performance.now(), bodyTime: window.__bodyTime });
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
            window.__initial = snapshot();
        });
        const requestCountBefore = requests.length, ruler = page.locator('.rulerTrack'), rulerBox = await ruler.boundingBox(), zoom = Number(await page.getByLabel('时间轴缩放').inputValue());
        for (const target of [1.7, 4.4, 2.1, 6.8, 1.3, 5.6, 3.2, 7.1]) {
            await page.mouse.click(rulerBox.x + target * zoom, rulerBox.y + rulerBox.height / 2);
            await expectLatestFrame(page, target, verifyPixels);
            await page.waitForTimeout(30);
        }
        const sameClip = await page.evaluate(() => ({ initial: window.__initial, events: window.__events, loading: window.__loading, rafLoading: window.__rafLoading })), sameClipRequests = requests.slice(requestCountBefore);
        console.log(JSON.stringify({ browser: name, phase: 'same_cached_clip', loadingAppearances: sameClip.loading.filter(x => x.loading).length, renderFramesWithLoading: sameClip.rafLoading.length, seekingEvents: sameClip.events.filter(x => x.type === 'seeking').length, newRequests: sameClipRequests, initial: sameClip.initial, errors }));
        await page.evaluate(() => { window.__events = []; window.__loading = []; window.__rafLoading = []; window.__wasLoading = false; });
        const dragRequestStart = requests.length;
        const handle = await page.locator('.globalPlayheadHandle').boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(rulerBox.x + 1.2 * zoom, handle.y + handle.height / 2, { steps: 20 });
        await page.mouse.move(rulerBox.x + 6.53 * zoom, handle.y + handle.height / 2, { steps: 20 });
        await page.mouse.up();
        await expectLatestFrame(page, 6.53, verifyPixels);
        await page.waitForTimeout(60);
        const drag = await page.evaluate(() => ({ events: window.__events, loading: window.__loading, rafLoading: window.__rafLoading })), dragRequests = requests.slice(dragRequestStart);
        console.log(JSON.stringify({ browser: name, phase: 'drag_playhead', loadingAppearances: drag.loading.filter(x => x.loading).length, renderFramesWithLoading: drag.rafLoading.length, seekingEvents: drag.events.filter(x => x.type === 'seeking').length, newRequests: dragRequests, errors }));
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => window.__videoInstances.every((video, index) => video === document.querySelectorAll('[data-media-frame] > video')[index])), true, name + ': seeks must reuse the same video elements');
        assert.deepEqual(sameClipRequests, [], name + ': cached ruler seeks must not request media again');
        assert.deepEqual(dragRequests, [], name + ': cached playhead dragging must not request media again');
        const flashes = sameClip.loading.filter(x => x.loading).length + drag.loading.filter(x => x.loading).length;
        if (flashes)
            failures.push({ browser: name, rulerFlashes: sameClip.loading.filter(x => x.loading).length, dragFlashes: drag.loading.filter(x => x.loading).length });
        await browser.close();
        browser = null;
    }
    assert.deepEqual(failures, [], 'Cached ruler seeks and playhead dragging must not show 正在准备视频预览…');
    console.log('PASS: cached ruler/playhead seeks keep media identity and position without loading flashes or media reloads; latest-frame pixels verified where requestVideoFrameCallback is supported');
}
finally {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    fs.rmSync(temp, { recursive: true, force: true });
}
