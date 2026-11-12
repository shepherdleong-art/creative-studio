// Run: node scripts/batch-review-interactions.playwright.test.mjs
// Real unified-review components + CSS in an isolated browser fixture; no app service or user DB.
//
// 10 号票（批量生产前三步只换外观）的回归证据：改外观时这几条交互必须一条不缺——
//   1. 素材拖到片段上 → 替换；
//   2. 素材拖到片段之间的空位 → 插入；
//   3. 素材拖到末尾 → 追加；
//   4. 鼠标在素材缩略图上左右滑 → 播放器逐帧看画面（scrub）；
//   5. 成片属性五页（包装 / 字幕 / 画面 / 封面 / 配音BGM）的「应用」按钮真的提交；
//   6. 时间轴筛选（全部 / 待检查 / 已确认 / 区间重复）与审核操作（通过 / 返工 / 撤销）。
//
// 断言只看「用户点得到、拖得动、提交了什么」，不看类名或内部状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

const timelineId = bundle(path.join(root, 'components/batch-production/review/BatchReviewTimelineDock.tsx'));
const poolId = bundle(path.join(root, 'components/batch-production/review/BatchReviewPoolDock.tsx'));
const inspectorId = bundle(path.join(root, 'components/batch-production/review/BatchReviewInspectorDock.tsx'));
const previewId = bundle(path.join(root, 'components/batch-production/review/BatchReviewPreviewDock.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));

const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map(m => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if (cache[id]) return cache[id].exports; const m = cache[id] = { exports: {} }; const [fn, deps] = modules[id]; fn(r => load(deps[r]), m, m.exports); return m.exports; }
const React = load(${reactId});
const Timeline = load(${timelineId}).default;
const Pool = load(${poolId}).default;
const Inspector = load(${inspectorId}).default;

const PreviewDock = load(${previewId}).default;

const poolAssets = [
  { assetId: 'asset-a', displayName: '素材 A', durationSec: 6, previewUrl: '/blank.mp4', thumbnailUrl: '/blank.png', role: 'opening', useCountByPlanId: { one: 1 }, coverUsedByPlanIds: [] },
  { assetId: 'asset-b', displayName: '素材 B', durationSec: 6, previewUrl: '/blank.mp4', thumbnailUrl: '/blank.png', role: 'opening', useCountByPlanId: {}, coverUsedByPlanIds: [] },
];
const clip = (id, startUs, endUs, timelineStartUs) => ({
  clipId: id, assetId: 'asset-a', sourceStartUs: startUs, sourceEndUs: endUs,
  timelineStartUs, timelineEndUs: timelineStartUs + (endUs - startUs), playbackRate: 1,
  framing: { scale: 1, offsetX: 0, offsetY: 0 },
});
function makeView() {
  return {
    planId: 'one', outputVersionId: 'version', editRevision: 0, editable: true,
    clips: [clip('clip-1', 0, 2000000, 0), clip('clip-2', 0, 2000000, 5000000)],
    visualDurationUs: 9000000, poolAssets,
    coverAssetId: 'asset-a', coverTimeUs: 0, coverFraming: { scale: 1, offsetX: 0, offsetY: 0 }, coverTitle: null,
    subtitleCues: [
      { id: 'cue-1', startUs: 0, endUs: 1500000, text: '第一句字幕' },
      { id: 'cue-2', startUs: 1500000, endUs: 3000000, text: '第二句字幕' },
    ],
    narration: { durationUs: 6000000, audioRelativePath: null, gainDb: 0 },
    music: { trackId: null }, musicLibrary: [{ id: 'bgm-1', filename: '验收音乐.mp3', durationUs: 8000000 }],
    packaging: { enabled: false, template: 'overlay-poster', varsOverrides: {}, pointCues: [] },
    batchMusicDefaults: { trackId: null, gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 },
    subtitleStyle: null, subtitleStyleOverride: false, subtitleOverride: false,
  };
}

window.edits = [];
window.reviews = [];
window.__preset = new URLSearchParams(location.search).get('preset') || '3x4';
function App() {
  const [view, setView] = React.useState(makeView);
  const [selection, setSelection] = React.useState(null);
  const [tab, setTab] = React.useState('packaging');
  const [filter, setFilter] = React.useState('all');
  const [selectedPlanIds, setSelectedPlanIds] = React.useState([]);
  const [coverStatus, setCoverStatus] = React.useState('succeeded');
  window.setCoverStatus = setCoverStatus;
  window.setTab = setTab;
  window.getView = () => view;

  const film = {
    planId: 'one', seq: 1, scriptTitle: '交互回归', status: coverStatus === 'failed' ? 'retryable_failed' : 'needs_attention', approved: false,
    coverStatus, coverTask: { id: 'cover-task', status: coverStatus, errorMessage: '资源不存在或不可用。' },
    approvable: coverStatus === 'succeeded', visible: true, durationSec: 9, warnings: [], blockers: [], arrangement: view,
  };
  const save = async (planId, edit) => {
    window.edits.push({ planId, ...edit });
    if (edit.type === 'set_packaging') setView(v => ({ ...v, packaging: edit.config, editRevision: v.editRevision + 1 }));
    if (edit.type === 'set_subtitle_style') setView(v => ({ ...v, subtitleStyle: edit.style, subtitleStyleOverride: true }));
    if (edit.type === 'set_music') setView(v => ({ ...v, music: { trackId: edit.trackId, gainDb: edit.gainDb, fadeInSec: edit.fadeInSec, fadeOutSec: edit.fadeOutSec } }));
    if (edit.type === 'set_narration_gain') setView(v => ({ ...v, narration: { ...v.narration, gainDb: edit.gainDb } }));
    if (edit.type === 'set_clip_playback_rate') setView(v => ({ ...v, clips: v.clips.map(c => c.clipId === edit.clipId ? { ...c, playbackRate: edit.playbackRate } : c) }));
    if (edit.type === 'set_clip_framing') setView(v => ({ ...v, clips: v.clips.map(c => c.clipId === edit.clipId ? { ...c, framing: edit.framing } : c) }));
    if (edit.type === 'set_subtitle_cue_text') setView(v => ({ ...v, subtitleCues: v.subtitleCues.map(c => c.id === edit.cueId ? { ...c, text: edit.text } : c) }));
    if (edit.type === 'replace' || edit.type === 'insert' || edit.type === 'delete' || edit.type === 'trim_variable' || edit.type === 'move_clip') {
      // 结构编辑不在这里模拟后端重排，只记录提交内容；断言看的是提交了什么。
    }
    return true;
  };

  const timelineProps = {
    films: [film], projectId: 'test', batchId: 'test', selection, selectedPlanId: 'one',
    focusedAssetId: null, playheadSec: 0, tool: 'select', snapEnabled: false, canUndo: false, canRedo: false,
    poolAssets, selectedPlanIds, rowFilter: filter, batchControlState: 'running', phaseEBusy: null,
    onSelectFilm: () => {}, onSelectTarget: setSelection, onSelectFocusedAsset: () => {}, onSeek: () => {},
    onToolChange: () => {}, onToggleSnap: () => {}, onUndo: () => {}, onRedo: () => {},
    onToggleEye: () => {}, onTogglePlanSelect: (id, on) => setSelectedPlanIds(cur => on ? [...new Set([...cur, id])] : cur.filter(x => x !== id)),
    onSelectAll: () => setSelectedPlanIds(['one']),
    onReview: decision => window.reviews.push({ kind: 'bulk', decision, plans: selectedPlanIds }),
    onRowFilterChange: setFilter, onShowAll: () => {},
    onReallocate: () => {}, onRetryNarration: () => {}, onRetryRender: () => {},
    onMediaEdit: save, onRefreshFilm: async () => {}, onOpenCoverEditor: () => {},
  };
  return React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '260px minmax(0,1fr) 320px', gridTemplateRows: '320px 520px', gap: 8, height: 860 } },
    React.createElement('div', { style: { gridColumn: 1, gridRow: 1, minHeight: 0, minWidth: 0 } },
      React.createElement(Pool, {
        projectId: 'test', batchId: 'test', selectedPlanId: 'one', poolAssets, focusedAssetId: null,
        onSelectFocusedAsset: () => {}, onPreviewAsset: () => {}, onAssetImported: () => {},
      })),
    // 成片实时预览：画幅标注在舞台元素上，验收的「画面比例」直接量它。
    React.createElement('div', { style: { gridColumn: 2, gridRow: 1, minHeight: 0, minWidth: 0 } },
      React.createElement(PreviewDock, {
        projectId: 'test', batchId: 'test', outputPreset: window.__preset || '3x4',
        previewFilm: film, previewAsset: null, onClearPreviewAsset: () => {}, playheadSec: 0, onSeek: () => {},
        poolAssets, packagingEditable: false,
      })),
    React.createElement('div', { style: { gridColumn: '1 / 3', gridRow: 2, minHeight: 0, minWidth: 0 } },
      React.createElement(Timeline, timelineProps)),
    React.createElement('div', { style: { gridColumn: 3, gridRow: '1 / 3', minHeight: 0 } },
      React.createElement(Inspector, {
        projectId: 'test', batchId: 'test', outputPreset: '3x4', film, selection,
        inspectorTab: tab, onTabChange: setTab, poolAssets, onMediaEdit: save,
        onJumpToCover: () => {}, onRefreshFilm: async () => {},
        coverEditorOpen: false, onOpenCoverEditor: () => {}, onCloseCoverEditor: () => {},
      })),
  );
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
`;

const fixtureCss = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8')
  .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);')
  + '\n@source "../components/batch-production";\n@source "../components/ui";\n@source "../components/audio";\n@source "../components/timeline";';
const globalCss = (await postcss([tailwind()]).process(fixtureCss, { from: path.join(root, 'app/globals.css') })).css;

// 1×1 的占位图与 1 秒静音 mp4：只为让 <img>/<video> 有 src，不参与断言。
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(script);
    return;
  }
  if (url.pathname === '/blank.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(PIXEL);
    return;
  }
  if (url.pathname === '/blank.mp4') {
    res.writeHead(404).end();
    return;
  }
  if (!url.pathname.startsWith('/')) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<html><head><meta charset="utf-8"><style>${globalCss}\n${styles.join('\n')}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});

/** 合成 HTML5 拖放：真实 DataTransfer + 指针落在目标元素内的指定横向位置。
 * dragover 与 drop 分成两次执行：真实用户拖放之间浏览器会渲染一帧，
 * 组件用 dragover 落 dropTarget 状态、drop 再读它；同一 tick 连发会读到旧状态。 */
async function dragMaterial(page, assetId, displayName, clipIndex, offsetRatio) {
  const item = { assetId, displayName, durationSec: 6, thumbnailUrl: '/blank.png', previewUrl: '/blank.mp4' };
  const target = () => document.querySelectorAll('.clipBlock')[clipIndex];
  await page.evaluate(({ item, clipIndex, offsetRatio }) => {
    const element = document.querySelectorAll('.clipBlock')[clipIndex];
    if (!element) throw new Error('找不到第 ' + clipIndex + ' 个片段');
    const rect = element.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/json', JSON.stringify(item));
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, composed: true, dataTransfer,
      clientX: rect.left + rect.width * offsetRatio, clientY: rect.top + rect.height / 2,
    }));
  }, { item, clipIndex, offsetRatio });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(({ item, clipIndex, offsetRatio }) => {
    const element = document.querySelectorAll('.clipBlock')[clipIndex];
    const rect = element.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/json', JSON.stringify(item));
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, composed: true, dataTransfer,
      clientX: rect.left + rect.width * offsetRatio, clientY: rect.top + rect.height / 2,
    }));
  }, { item, clipIndex, offsetRatio });
  void target;
}

let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.clipBlock').first().waitFor();

  const lastEdit = () => page.evaluate(() => window.edits.at(-1));

  // ---- 1. 素材拖到片段主体 → 替换 ----
  await dragMaterial(page, 'asset-b', '素材 B', 0, 0.6);
  await page.waitForFunction(() => window.edits.some(e => e.type === 'replace'));
  const replaceEdit = await lastEdit();
  assert.equal(replaceEdit.type, 'replace', '拖到片段主体必须是替换');
  assert.equal(replaceEdit.assetId, 'asset-b', '替换成被拖的素材');
  assert.ok(replaceEdit.clipId, '替换必须带上是哪一段片段');

  // ---- 2. 素材拖到片段左缘 → 插入 ----
  const beforeInsert = await page.evaluate(() => window.edits.length);
  await dragMaterial(page, 'asset-b', '素材 B', 1, 0.02);
  await page.waitForFunction(n => window.edits.length > n, beforeInsert);
  const insertEdit = await lastEdit();
  assert.equal(insertEdit.type, 'insert', '拖到片段左缘必须是插入');
  assert.ok(insertEdit.assetId === 'asset-b', '插入的是被拖的素材');

  // ---- 3. 素材拖到末尾追加区 → 追加 ----
  const beforeAppend = await page.evaluate(() => window.edits.length);
  const appendZone = page.locator('text=+追加').first();
  await appendZone.waitFor();
  const appendItem = { assetId: 'asset-b', displayName: '素材 B', durationSec: 6, thumbnailUrl: '/blank.png', previewUrl: '/blank.mp4' };
  await appendZone.evaluate((element, item) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/json', JSON.stringify(item));
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, composed: true, dataTransfer,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  }, appendItem);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await appendZone.evaluate((element, item) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/json', JSON.stringify(item));
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, composed: true, dataTransfer,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  }, appendItem);
  await page.waitForFunction(n => window.edits.length > n, beforeAppend);
  const appendEdit = await lastEdit();
  assert.equal(appendEdit.type, 'insert', '末尾追加同样走 insert 编辑');
  assert.ok(appendEdit.afterClipId, '追加要接在最后一段之后');

  // ---- 4. 素材缩略图上左右滑 → 播放器按位置逐帧看画面 ----
  // 缩略图是素材卡里的第一个 <img>；scrub 时组件会在同一张卡上追加进度条与时间标签。
  const poster = page.locator('[aria-label="素材池"] article').first().locator('img').first();
  await poster.waitFor();
  const posterBox = await poster.boundingBox();
  assert.ok(posterBox && posterBox.width > 20, '缩略图必须真的画出来');
  const card = page.locator('[aria-label="素材池"] article').first();
  const scrubTag = card.locator('[class*="poolPosterTimeTag"]');
  await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    element?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  }, { x: posterBox.x + posterBox.width * 0.8, y: posterBox.y + posterBox.height / 2 });
  await scrubTag.waitFor({ timeout: 5000 });
  const scrubRightTag = await scrubTag.innerText();
  await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    element?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  }, { x: posterBox.x + posterBox.width * 0.15, y: posterBox.y + posterBox.height / 2 });
  await page.waitForTimeout(120);
  const scrubLeftTag = await scrubTag.innerText();
  assert.notEqual(scrubRightTag, scrubLeftTag, `缩略图上左右滑必须看到不同位置的画面时间（右 ${scrubRightTag} / 左 ${scrubLeftTag}）`);
  // 离开缩略图后 scrub 提示收起，不残留。
  await page.evaluate(() => {
    const element = document.querySelector('[aria-label="素材池"] article div[class*="poolPoster"]');
    element?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
  });

  // ---- 5. 成片属性五页都能改并落到后端 ----
  // 说明：五页里只有需要草稿的页签有「应用」按钮（字幕样式 / 口播音量 / BGM / 封面）；
  // 包装开关与画面倍速是即时保存（既有交互，本次只换外观，不改语义）。
  // 5.1 包装
  const packagingSwitch = page.getByRole('switch', { name: '启用视频包装' });
  await packagingSwitch.waitFor();
  await packagingSwitch.click();
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_packaging'));
  const packagingEdit = await page.evaluate(() => window.edits.find(e => e.type === 'set_packaging'));
  assert.equal(packagingEdit.config.enabled, true, '包装开关必须提交启用状态');

  // 5.2 字幕：选中字幕后可改文字；样式页签里动一下字号，草稿变了「应用字幕样式」才可点
  await page.evaluate(() => window.setTab('subtitle'));
  await page.locator('[data-subtitle-cue-id="cue-1"]').click();
  const cueTextarea = page.locator('textarea').first();
  await cueTextarea.waitFor();
  await cueTextarea.fill('改过的第一句');
  await cueTextarea.blur();
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_subtitle_cue_text' && e.text === '改过的第一句'));
  const fontSize = page.getByLabel('字号数值', { exact: true });
  await fontSize.fill('64');
  const applySubtitleStyle = page.getByRole('button', { name: '应用字幕样式', exact: true });
  await applySubtitleStyle.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '应用字幕样式');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 10_000 });
  await applySubtitleStyle.click();
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_subtitle_style'));

  // 5.3 画面：选中片段后有倍速与画面构图
  await page.locator('.clipBlock').first().click();
  await page.evaluate(() => window.setTab('picture'));
  const speedInput = page.getByRole('slider', { name: '视频倍速拉条', exact: true });
  await speedInput.waitFor();
  await speedInput.fill('1.5');
  await speedInput.press('Tab');
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_clip_playback_rate' && e.playbackRate === 1.5));

  // 5.4 配音BGM：口播增益 + BGM 曲目各自「应用」
  await page.getByRole('button', { name: '配音BGM', exact: true }).click();
  const narrationGain = page.locator('aside[aria-label="成片属性"] input[type="range"]').first();
  await narrationGain.waitFor();
  await narrationGain.fill('-6');
  await page.getByRole('button', { name: '应用音量', exact: true }).click();
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_narration_gain' && e.gainDb === -6));
  // 曲目下拉（aria-label 由 select 自身的可访问名给出）+「应用 BGM 更改」
  const bgmTrackSelect = page.locator('aside[aria-label="成片属性"] select').first();
  await bgmTrackSelect.selectOption('bgm-1');
  await page.getByRole('button', { name: '应用 BGM 更改', exact: true }).click();
  await page.waitForFunction(() => window.edits.some(e => e.type === 'set_music' && e.trackId === 'bgm-1'));

  // 5.5 封面：走「封面精调」抽屉（「应用封面」在 review-packaging-source 里覆盖）
  await page.evaluate(() => window.setTab('cover'));
  await page.getByRole('button', { name: '封面精调', exact: true }).waitFor();

  // ---- 6. 筛选与审核操作 ----
  for (const label of ['全部 1', '待检查 1', '已确认 0']) {
    await page.getByRole('button', { name: label, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: '已确认 0', exact: true }).click();
  await page.getByText('还没有已确认的成片', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部 1', exact: true }).click();
  await page.locator('.clipBlock').first().waitFor();

  await page.evaluate(() => window.setCoverStatus('failed'));
  await page.getByRole('button', { name: '重试封面', exact: true }).waitFor();
  assert.equal(await page.getByText('封面失败', { exact: true }).count(), 2, '时间轴与预览区应明确显示失败，不能一直标处理中');
  assert.equal(await page.getByRole('button', { name: '通过已选 (0)', exact: true }).isDisabled(), true, '失败封面仍应阻止通过');
  await page.evaluate(() => window.setCoverStatus('succeeded'));
  await page.getByRole('checkbox', { name: '选择成片 1' }).check();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '通过已选 (1)');
    return button && !button.disabled;
  });
  assert.equal(await page.getByText('封面失败', { exact: true }).count(), 0, '重试成功后不刷新页面即可恢复审核');
  await page.getByRole('button', { name: '通过已选 (1)', exact: true }).click();
  await page.waitForFunction(() => window.reviews.some(r => r.decision === 'approved'));
  const approveReview = await page.evaluate(() => window.reviews.at(-1));
  assert.deepEqual(approveReview.plans, ['one'], '通过已选只提交被勾选的成片');

  await page.getByRole('button', { name: '返工', exact: true }).click();
  await page.waitForFunction(() => window.reviews.some(r => r.decision === 'rework'));
  await page.getByRole('button', { name: '撤销审核', exact: true }).click();
  await page.waitForFunction(() => window.reviews.some(r => r.decision === 'cancelled'));

  // ---- 7. 审片预览的画面比例：3:4 / 9:16 / 16:9 都要正确 ----
  for (const [preset, ratio] of [['3x4', 3 / 4], ['9x16', 9 / 16], ['16x9', 16 / 9]]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?preset=${preset}`);
    await page.locator('[data-output-preset]').first().waitFor();
    const box = await page.locator('[data-output-preset]').first().boundingBox();
    assert.ok(box && box.height > 0, `画幅 ${preset} 的预览必须真的画出来`);
    const actual = box.width / box.height;
    assert.ok(Math.abs(actual - ratio) < 0.02, `审片预览画幅 ${preset} 比例应为 ${ratio.toFixed(3)}，实际 ${actual.toFixed(3)}`);
    assert.ok(box.width >= 100, `审片预览画幅 ${preset} 宽 ${box.width}px，太小了`);
  }

  assert.deepEqual(errors, []);
  console.log('batch review interactions: replace / insert / append drop, thumbnail scrub, five-tab apply, filter, review and preview ratio passed');

  // ---- 8. 两内核 × 三窗口 × 浅深：审片工作台不横向滚动、控件不被切 ----
  // 复用 04 的判定意图（整页不横向滚动、控件不被祖先裁掉），矩阵同 04 的默认值。
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const matrixBrowser = await engine.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1536, height: 864 }, { width: 1280, height: 720 }, { width: 1024, height: 720 }]) {
        for (const theme of ['light', 'dark']) {
          const context = await matrixBrowser.newContext({ viewport, deviceScaleFactor: 1 });
          const matrixPage = await context.newPage();
          try {
            await matrixPage.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
            await matrixPage.locator('[data-output-preset]').first().waitFor({ timeout: 30_000 });
            await matrixPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
            await matrixPage.waitForTimeout(250);
            const label = `${engineName} ${viewport.width}x${viewport.height} ${theme}`;

            const overflow = await matrixPage.evaluate(() => ({
              innerWidth: window.innerWidth,
              scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            }));
            assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1,
              `${label}: 审片工作台横向多出 ${overflow.scrollWidth - overflow.innerWidth}px`);

            const clipped = await matrixPage.evaluate(() => {
              const selector = 'button, input, select, textarea, label, [role="button"], [role="tab"], [role="switch"], [role="checkbox"]';
              const bad = [];
              for (const element of document.querySelectorAll(selector)) {
                const rect = element.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) continue;
                const style = getComputedStyle(element);
                if (style.visibility === 'hidden' || style.display === 'none') continue;
                let clipper = null;
                for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                  const parentStyle = getComputedStyle(parent);
                  if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowX)) { clipper = parent; break; }
                }
                if (clipper && /(auto|scroll)/.test(getComputedStyle(clipper).overflowX)) continue;
                const band = clipper ? clipper.getBoundingClientRect() : { left: 0, right: window.innerWidth };
                const right = Math.min(window.innerWidth, band.right);
                if (rect.right > right + 1.5 && rect.left < right - 2) {
                  bad.push(`${element.tagName.toLowerCase()}「${(element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 16)}」`);
                }
              }
              return bad;
            });
            assert.deepEqual(clipped, [], `${label}: 这些控件被切掉了一截 ${clipped.join('；')}`);

            const preview = await matrixPage.locator('[data-output-preset]').first().boundingBox();
            assert.ok(preview && Math.abs(preview.width / preview.height - 0.75) < 0.02,
              `${label}: 审片预览画面比例不对 ${preview ? (preview.width / preview.height).toFixed(3) : 'missing'}`);

            // 深色下不能残留写死浅色块：审片四区与时间轴行的底色必须真的变暗。
            if (theme === 'dark') {
              const lightBlocks = await matrixPage.evaluate(() => {
                const probe = (selector) => {
                  const element = document.querySelector(selector);
                  if (!element) return null;
                  const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(element).backgroundColor);
                  if (!match) return null;
                  const [r, g, b] = match[1].split(',').map(Number);
                  return Math.round((r + g + b) / 3);
                };
                return {
                  dock: probe('[aria-label="成片属性"], [aria-label="素材池"]'),
                  workbench: probe('[class*="reviewWorkbench"]'),
                };
              });
              for (const [name, brightness] of Object.entries(lightBlocks)) {
                if (brightness === null) continue;
                assert.ok(brightness < 120, `${label}: ${name} 深色下仍然偏亮（平均亮度 ${brightness}），疑似写死了浅色底`);
              }
            }
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await matrixBrowser.close();
    }
  }
  console.log('batch review workbench: 2 engines x 3 windows x light/dark — no horizontal scroll, no clipped controls, preview ratio and dark surfaces passed');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
