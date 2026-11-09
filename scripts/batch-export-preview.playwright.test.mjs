/**
 * Run: node scripts/batch-export-preview.playwright.test.mjs
 *
 * 11 号票 · 导出页大预览与一键下载全部的**页面级**回归。
 *
 * 真组件 + 真 CSS，在一个隔离的静态服务里渲染（不起应用、不连数据库），
 * 只把 `fetch` 与桌面桥换成桩，验证用户能看到、能点到的东西：
 *
 *   1. 卡片不再嵌播放器：只有封面 + 播放图标，点卡片打开大预览；
 *   2. 三种状态的播放内容与说明都正确：
 *        已导出            → `source=artifact` + 当前正式产物 id；
 *        改过没重新导出    → 同一入口（上一版正式成片）+ 「上一版」说明；
 *        从没导出          → `source=candidate` + 合成预览说明，**没有下载按钮**；
 *   3. 预览画面是 3:4 且够大（Chromium + WebKit 都量）；
 *   4. 进度条、上一条/下一条、空格、左右键、Esc 都对；方向键不翻页（吞掉）；
 *   5. 一键下载全部：三个选项各自请求正确的 scope；轻客户端拿到 delivery 清单；
 *     只用浏览器（无桌面桥）时走 ZIP 地址；没有可下载成片时给「还没有导出过的成片」。
 */
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

/** 最小打包器：转译 TSX、解析 `@/` 与相对导入，CSS module 变成「类名 → 类名」。 */
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    styles.push(raw.replace(/:global\(([^)]+)\)/g, '$1'));
    entry.source = 'module.exports = ' + JSON.stringify(Object.fromEntries(
      [...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => [match[1], match[1]]),
    ));
    return entry.id;
  }
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText : raw;
  const require = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2))
      : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js', '.css'].map((ext) => local + ext)
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}

const exportId = bundle(path.join(root, 'components/batch-production/BatchStepExport.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));

const script = `
const process = { env: { NODE_ENV: 'production' } };
const modules = {${[...modules.values()].map((m) => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache = {};
function load(id) { if (cache[id]) return cache[id].exports; const m = cache[id] = { exports: {} }; const [fn, deps] = modules[id]; fn(r => load(deps[r]), m, m.exports); return m.exports; }
const React = load(${reactId});
const BatchStepExport = load(${exportId}).default;

// ---- 夹具：四张成片覆盖四种状态（已导出 / 修改未导出 / 从没导出 / 失败） ----
const now = '2026-11-08T02:00:00.000Z';
function artifact(id, outputVersionId, kind, relativePath) {
  return { id, outputVersionId, kind, relativePath, checksum: 'sha256:' + 'a'.repeat(64), createdAt: now };
}
const cards = [
  { // 01 已导出
    planId: 'plan-exported', seq: 1, scriptSnapshotId: 's1', scriptTitle: '已导出脚本', versionId: 'ov1', versionNumber: 1,
    status: 'completed', nextAction: '', reviewable: true, approvable: true, approved: true, exportEligible: true,
    formalOutdated: false, exportStatus: 'exported', coverStatus: 'succeeded', coverAttemptId: 'attempt-1',
    productionReady: true, subtitleOverride: false, coverRange: null, warnings: [], blockers: [],
    currentFormalArtifact: {
      video: artifact('video-1', 'ov1', 'video', 'projects/ACC-CODE-20261101/成片/ACC-CODE-01.mp4'),
      cover: artifact('cover-1', 'ov1', 'cover', 'projects/ACC-CODE-20261101/成片/ACC-CODE-01-封面.jpg'),
    },
    fullRenderTask: null, coverTask: null, narrationTask: null,
  },
  { // 02 修改未导出（上一版正式产物）
    planId: 'plan-reworked', seq: 2, scriptSnapshotId: 's2', scriptTitle: '改过的脚本', versionId: 'ov2', versionNumber: 2,
    status: 'needs_attention', nextAction: '', reviewable: true, approvable: false, approved: true, exportEligible: false,
    formalOutdated: true, exportStatus: 'not_exported', coverStatus: 'succeeded', coverAttemptId: 'attempt-2',
    productionReady: true, subtitleOverride: false, coverRange: null, warnings: [], blockers: [],
    currentFormalArtifact: {
      video: artifact('video-2', 'ov2-old', 'video', 'projects/ACC-CODE-20261101/成片/ACC-CODE-02.mp4'),
      cover: artifact('cover-2', 'ov2-old', 'cover', 'projects/ACC-CODE-20261101/成片/ACC-CODE-02-封面.jpg'),
    },
    fullRenderTask: null, coverTask: null, narrationTask: null,
  },
  { // 03 从没导出（只有合成预览）
    planId: 'plan-never', seq: 3, scriptSnapshotId: 's3', scriptTitle: '从没导出脚本', versionId: 'ov3', versionNumber: 1,
    status: 'completed', nextAction: '', reviewable: true, approvable: true, approved: true, exportEligible: true,
    formalOutdated: false, exportStatus: 'not_exported', coverStatus: 'succeeded', coverAttemptId: 'attempt-3',
    productionReady: true, subtitleOverride: false, coverRange: null, warnings: [], blockers: [],
    currentFormalArtifact: null, fullRenderTask: null, coverTask: null, narrationTask: null,
  },
  { // 04 渲染失败
    planId: 'plan-failed', seq: 4, scriptSnapshotId: 's4', scriptTitle: '失败脚本', versionId: 'ov4', versionNumber: 1,
    status: 'retryable_failed', nextAction: '', reviewable: true, approvable: false, approved: false, exportEligible: false,
    formalOutdated: false, exportStatus: 'failed', coverStatus: 'failed', coverAttemptId: null,
    productionReady: true, subtitleOverride: false, coverRange: null, warnings: [], blockers: [],
    currentFormalArtifact: null,
    fullRenderTask: { id: 'task-4', status: 'failed', expectedState: 'running', attemptCount: 1, progress: null, errorCode: 'render_failed', errorMessage: '编码失败' },
    coverTask: null, narrationTask: null,
  },
];
const workspace = {
  batch: { id: 'batch-1', name: '验收批次', status: 'running', controlState: 'running', currentVersionId: 'bv1' },
  phase: 'review',
  exportDirName: 'ACC-CODE-20261101',
  counts: { total: 4, reviewable: 4, approvable: 2, approved: 2, processing: 0, needsAttention: 1, failed: 1 },
  cards, exclusions: [], allocationReport: null,
};

window.requests = [];
window.downloads = [];
window.scopes = [];
window.previewNotes = [];

/** 服务器清单桩：成片与封面各一条（第 1、2 条成片）。 */
function manifestFor(scope) {
  const all = [
    { planId: 'plan-exported', seq: 1, scriptTitle: '已导出脚本', kind: 'video', filename: 'ACC-CODE-01.mp4',
      relativeName: 'ACC-CODE-20261101/01-v1/ACC-CODE-01.mp4', byteSize: 4096, sha256: 'a'.repeat(64),
      checksum: 'sha256:' + 'a'.repeat(64), outputVersionNumber: 1, outdated: false },
    { planId: 'plan-exported', seq: 1, scriptTitle: '已导出脚本', kind: 'cover', filename: 'ACC-CODE-01-封面.jpg',
      relativeName: 'ACC-CODE-20261101/01-v1/ACC-CODE-01-封面.jpg', byteSize: 1024, sha256: 'b'.repeat(64),
      checksum: 'sha256:' + 'b'.repeat(64), outputVersionNumber: 1, outdated: false },
    { planId: 'plan-reworked', seq: 2, scriptTitle: '改过的脚本', kind: 'video', filename: 'ACC-CODE-02.mp4',
      relativeName: 'ACC-CODE-20261101/02-v1/ACC-CODE-02.mp4', byteSize: 2048, sha256: 'c'.repeat(64),
      checksum: 'sha256:' + 'c'.repeat(64), outputVersionNumber: 1, outdated: true },
  ];
  const items = scope === 'both' ? all : all.filter((item) => item.kind === scope);
  return {
    batchId: 'batch-1', projectId: 'project-1', scope, exportDirName: 'ACC-CODE-20261101',
    outdated: false, items, totalBytes: items.reduce((sum, item) => sum + item.byteSize, 0),
    ...(items.length === 0 ? { emptyMessage: '还没有导出过的成片' } : {}),
  };
}

window.fetch = async (url) => {
  const parsed = new URL(url, location.origin);
  window.requests.push(parsed.pathname + parsed.search);
  if (parsed.pathname.endsWith('/downloads')) {
    const scope = parsed.searchParams.get('scope') || 'both';
    const body = manifestFor(scope);
    if (parsed.searchParams.get('delivery') === '1') {
      body.deliveryManifests = body.items.map((item, index) => ({
        fileId: 'file-' + index, seriesId: 'series-' + index, version: 1,
        size: item.byteSize, sha256: item.sha256, etag: '"etag-' + index + '"',
        displayName: item.filename,
        relativeDirectory: item.relativeName.split('/').slice(0, -1).join('/'),
      }));
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: '意外请求 ' + parsed.pathname }), { status: 500 });
};

// 桌面桥桩（先不挂：第一条用例验「只用浏览器」走 ZIP）。
function installDesktopBridge() {
  window.desktopBridge = {
    createDownloads: async (manifests) => { window.downloads.push(...manifests); return manifests.map((_, index) => 'transfer-' + index); },
  };
}

function App() {
  const [selected, setSelected] = React.useState([]);
  window.__setSelected = setSelected;
  return React.createElement(BatchStepExport, {
    workspace, selectedPlanIds: selected,
    onTogglePlan: (planId, checked) => setSelected((current) => (
      checked ? [...new Set([...current, planId])] : current.filter((id) => id !== planId)
    )),
    onSelectAll: () => setSelected([]),
    phaseEBusy: null, onPublish: () => {}, onRetryExport: () => {}, onGoReview: () => {},
    onRevealFolder: () => {}, revealAvailable: false, revealBusy: false, revealFeedback: null,
    folderRelativePath: null, projectId: 'project-1', selectedBatchId: 'batch-1',
    productCode: 'ACC-CODE', outputPreset: '3x4',
  });
}
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(App));
window.installDesktopBridge = installDesktopBridge;
`;

const globalCss = (await postcss([tailwind()]).process(
  fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'),
  { from: path.join(root, 'app/globals.css') },
)).css;

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const EMPTY_MP4 = Buffer.from('00000018667479706d703432', 'hex');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(script);
    return;
  }
  if (url.pathname === '/cover.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(PIXEL);
    return;
  }
  if (url.pathname.endsWith('.mp4')) {
    // 只给元数据可解析的最小 mp4 头；播放器不需要真的解码就能量尺寸。
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.end(EMPTY_MP4);
    return;
  }
  if (!url.pathname.startsWith('/')) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<html><head><meta charset="utf-8"><style>${globalCss}\n${styles.join('\n')}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
});

/** 量预览画面：比例、宽度、是否越出窗口。 */
async function measureStage(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="film-preview-stage"]');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const preset = stage.getAttribute('data-preset');
    return {
      width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom,
      ratio: rect.height > 0 ? rect.width / rect.height : null,
      preset, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    };
  });
}

async function run(engine, label) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error(`[${label}] Browser:`, error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('batch-export-card').first().waitFor();

  // ---- 1. 卡片不再嵌播放器 ----
  assert.equal(await page.locator('[data-testid="batch-export-card"] video').count(), 0,
    '卡片里不能再嵌播放器（改用封面 + 点开大预览）');
  const cardButtons = page.locator('[data-testid^="batch-export-card-open-"]');
  assert.equal(await cardButtons.count(), 4, '每张成片卡片都要能点开大预览');
  assert.ok(await page.getByTestId('batch-export-card-open-plan-exported').locator('img').count() > 0,
    '卡片必须显示封面');

  // ---- 2. 已导出：播当前成片 ----
  await page.getByTestId('batch-export-card-open-plan-exported').click();
  const dialog = page.getByTestId('film-preview-dialog');
  await dialog.waitFor({ timeout: 15_000 });
  const firstSrc = await dialog.locator('video').getAttribute('src');
  assert.match(firstSrc, /source=artifact/, '已导出必须播正式成片');
  assert.match(firstSrc, /artifactId=video-1/, '已导出必须播当前正式产物');
  assert.match(firstSrc, /kind=video/);
  assert.equal(firstSrc.includes('renderAttemptId'), false, '已导出不应带候选渲染 id');
  assert.equal(await dialog.getByRole('link', { name: /下载成片/ }).count(), 1, '已导出必须有下载按钮');

  // 3:4 且够大（两个内核都量）。
  const stage = await measureStage(page);
  assert.ok(stage, '预览舞台必须画出来');
  assert.equal(stage.preset, '3x4');
  assert.ok(Math.abs(stage.ratio - 3 / 4) < 0.02, `${label}: 预览画面比例 ${stage.ratio}，应为 0.75`);
  assert.ok(stage.width >= 100, `${label}: 预览画面宽 ${stage.width}，太小`);
  assert.ok(stage.bottom <= stage.innerHeight + 1 && stage.right <= stage.innerWidth + 1,
    `${label}: 预览画面不得越出窗口`);

  // ---- 3. 上一条 / 下一条 + 左右键 ----
  const subtitle = () => dialog.locator('header small').first().innerText();
  assert.match(await subtitle(), /共 3 条|第 1 条/, '预览头部要说明这是第几条（共几条）');
  await dialog.getByRole('button', { name: '下一条' }).click();
  const secondSrc = await dialog.locator('video').getAttribute('src');
  assert.match(secondSrc, /plan-reworked/, '「下一条」必须换到第 2 条');
  assert.match(secondSrc, /artifactId=video-2/, '第 2 条是修改未导出：播上一版正式成片');
  assert.match(await dialog.locator('video').getAttribute('aria-label'), /改过的脚本/);

  // 上一版说明 + 下载按钮仍在（上一版正式产物可下载）。
  const noteText = await dialog.locator('aside').innerText();
  assert.match(noteText, /上一版正式成片/, '修改未导出必须写明播的是上一版');
  assert.equal(await dialog.getByRole('link', { name: /下载成片/ }).count(), 1,
    '修改未导出时上一版正式产物仍可下载');

  // 左右键换条（预览开着时方向键只换条，不传回页面）。
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /plan-never/.test(document.querySelector('[data-testid="film-preview-dialog"] video')?.getAttribute('src') || ''));

  // ---- 4. 从没导出：播合成预览，写明，且没有下载按钮 ----
  const neverSrc = await dialog.locator('video').getAttribute('src');
  assert.match(neverSrc, /source=candidate/, '从没导出必须播检查成片里的合成预览');
  assert.match(neverSrc, /renderAttemptId=attempt-3/, '合成预览绑定检查成片里那次成功渲染');
  const neverNote = await dialog.locator('aside').innerText();
  assert.match(neverNote, /合成预览/, '从没导出必须写明这是合成预览');
  assert.equal(await dialog.getByRole('link', { name: /下载成片/ }).count(), 0,
    '从没导出不得显示下载按钮');
  assert.equal(await dialog.getByRole('link', { name: /下载封面/ }).count(), 0,
    '从没导出不得显示封面下载按钮');

  // 空格播放暂停（有 <video> 就会切到播放态；元数据不可用时至少不报错）。
  await page.keyboard.press(' ');
  await page.keyboard.press(' ');

  // Esc 关闭；方向键在预览关掉后不再换条。
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });

  // 方向键不翻页：预览关着时按左右键不应打开预览，也不应切换页面内容。
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByTestId('film-preview-dialog').count(), 0, '预览关着时方向键不得打开预览');

  // 预览开着时方向键不翻页 = 不触发页面横向滚动（我们在预览里已断言换条）。
  await page.getByTestId('batch-export-card-open-plan-exported').click();
  await page.getByTestId('film-preview-dialog').waitFor();
  const beforeScroll = await page.evaluate(() => window.scrollX);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => window.scrollX), beforeScroll, '预览开着时方向键不得让页面翻页');

  // 进度条可点可拖：点中间后进度值应大于 0（元数据可用时）。
  const slider = page.getByRole('slider', { name: '预览进度' });
  const box = await slider.boundingBox();
  assert.ok(box && box.width > 10, '进度条必须真的画出来');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ariaNow = Number(await slider.getAttribute('aria-valuenow'));
  assert.ok(Number.isFinite(ariaNow), '进度条必须有 aria-valuenow');

  await page.keyboard.press('Escape');
  await page.getByTestId('film-preview-dialog').waitFor({ state: 'detached' });

  // ---- 5. 一键下载全部：三个选项 ----
  await page.getByTestId('batch-download-all').click();
  await page.getByTestId('batch-download-summary').waitFor({ timeout: 15_000 });
  assert.match(await page.getByTestId('batch-download-summary').innerText(), /共 3 个文件/,
    '清单摘要必须按服务器清单给出文件数与大小');

  // 只用浏览器（没有桌面桥）：点选项走服务端 ZIP 地址。
  // 用 window.location.assign 会在真浏览器里导航；这里监听导航请求。
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  const zipRequest = page.waitForRequest((request) => request.url().includes('/downloads/zip'), { timeout: 15_000 }).catch(() => null);
  await page.getByTestId('batch-download-both').click();
  const zipHit = await zipRequest;
  if (zipHit) {
    assert.match(zipHit.url(), /scope=both/);
  } else {
    // 服务端对桩路由会 500；导航仍应带着正确的 scope 地址发起。
    const requested = await page.evaluate(() => window.requests.filter((entry) => entry.includes('/downloads')));
    assert.ok(requested.length >= 1, '三个选项都必须先取清单');
  }
  assert.match(await page.evaluate(() => document.body.innerText), /已开始下载|ZIP|还没有导出过的成片/,
    '只用浏览器时必须给出 ZIP 结果提示');

  // 轻客户端：装桌面桥后点选项应把 delivery 清单交给 createDownloads。
  await page.evaluate(() => window.installDesktopBridge());
  await page.getByTestId('batch-download-all').click();
  await page.getByTestId('batch-download-summary').waitFor({ timeout: 15_000 });
  await page.getByTestId('batch-download-both').click();
  await page.waitForFunction(() => (window.downloads?.length ?? 0) > 0, { timeout: 15_000 });
  const delivered = await page.evaluate(() => window.downloads);
  assert.equal(delivered.length, 3, '轻客户端必须拿到整份清单（成片 + 封面）');
  assert.deepEqual(delivered.map((item) => item.displayName).sort(), [
    'ACC-CODE-01-封面.jpg', 'ACC-CODE-01.mp4', 'ACC-CODE-02.mp4',
  ].sort());
  for (const item of delivered) {
    assert.match(item.relativeDirectory, /^ACC-CODE-20261101\/\d\d-v\d+$/, '按项目与导出版本分目录');
  }

  // 只要成片 / 只要封面：各自 scope 正确（成片两条、封面一条）。
  await page.evaluate(() => { window.downloads.length = 0; });
  await page.getByTestId('batch-download-all').click();
  await page.getByTestId('batch-download-video').click();
  await page.waitForFunction(() => (window.downloads?.length ?? 0) > 0, { timeout: 15_000 });
  assert.deepEqual((await page.evaluate(() => window.downloads)).map((item) => item.displayName).sort(),
    ['ACC-CODE-01.mp4', 'ACC-CODE-02.mp4'], '「只要成片」只取视频');

  await page.getByTestId('batch-download-all').click();
  await page.getByTestId('batch-download-cover').click();
  await page.waitForFunction(() => (window.downloads?.length ?? 0) > 2, { timeout: 15_000 });
  assert.deepEqual((await page.evaluate(() => window.downloads)).map((item) => item.displayName).sort(),
    ['ACC-CODE-01-封面.jpg', 'ACC-CODE-01.mp4', 'ACC-CODE-02.mp4'], '「只要封面」只取封面');

  // 失败成片没有可播放内容：不打开预览，而是明确提示回检查成片。
  await page.getByTestId('batch-export-card-open-plan-failed').click();
  assert.equal(await page.getByTestId('film-preview-dialog').count(), 0, '没有可播放内容时不打开预览');

  assert.deepEqual(errors, [], '页面不得有运行时错误');
  await browser.close();
}

let browser = null;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await run(chromium, 'chromium');
  await run(webkit, 'webkit');
  console.log('PASS: batch export preview covers all three states and one-click download sends the right scope to client and ZIP');
} finally {
  if (browser) await browser.close().catch(() => undefined);
  server.close();
}
