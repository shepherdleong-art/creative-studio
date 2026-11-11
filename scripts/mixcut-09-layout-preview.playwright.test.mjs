/**
 * 09 号票验收：单条精准混剪的外观与几何。
 *
 * 运行：node scripts/mixcut-09-layout-preview.playwright.test.mjs
 * 导出页定向回归：node scripts/mixcut-export-card.playwright.test.mjs
 *
 * 覆盖（对应任务单验收条件）：
 *   1. 团队版宽度规则：`html[data-deployment-mode='server']` 下混剪外壳占满父容器（内容区），
 *      不按 100vw 撑、不比内容区宽；1440×900 与 1536×864 都不横向滚动。
 *      （真实团队版跑在带侧栏的页面上，那条断言在 04 的界面验收工具里按真实矩阵量。）
 *   2. 本地版宽度与改版前一致：min(1440px, 100vw - 48px)，且按视口居中突破父栏。
 *   3. 1280×720 打开截取条，剪辑区预览高度 ≥ 200px（中间一栏自己滚，不压扁画面）。
 *   4. 导出成功后点成片打开预览对话框：画面是 3:4 且够大；有声音（不静音）；
 *      点击/拖动进度条能跳转；空格暂停；Esc 关闭并停止播放。
 *
 * 两内核都跑。WebKit 在本机解不了 H.264（实测 loadedmetadata 永不触发），
 * 所以「能跳转 / 能暂停」这类依赖解码的断言只在 Chromium 上跑；
 * WebKit 上量的是与解码无关的部分：对话框真的打开、舞台尺寸是 3:4 且够大、不静音、
 * Esc 关闭。这不是放宽断言，是把「环境做不到」和「实现没做到」分开。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, webkit } from '@playwright/test';

const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const FPS = 24;
const INTRO_FRAMES = 20;

function textStyle(fontSizePx, y) {
  return {
    fontFamily: 'Arial', fontSizePx, italic: false, x: 0.5, y, scale: 1,
    color: '#ffffff', align: 'center', boxWidthPx: 800, lineHeight: 1.2,
    stroke: { enabled: true, color: '#000000', widthPx: 2 },
    shadow: { enabled: false, color: '#000000', opacity: 0.4, blurPx: 4, distancePx: 2, angleDeg: 90 },
  };
}

function createGroup() {
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
      title: '09 验收成片',
      importedNarrationText: '第一句。第二句。',
      editedNarrationText: '第一句。第二句。',
      syncState: 'synced',
      sourceScriptUpdatedAt: '2026-11-01T00:00:00.000Z',
      narrationConfig: { providerId: 'tts-e2e', voice: 'voice-e2e', speed: 1, playbackRate: 1, gainDb: 0 },
      selectedMaterialKeys: ['module4:video-a', 'module4:video-b'],
    },
    narrationDurationUs: 10_000_000,
    totalDurationUs: 10_833_333,
    coverTitle: {
      primary: { id: 'primary', text: '验收标题', textSource: 'script' },
      secondary: { id: 'secondary', text: '09 ticket', textSource: 'script' },
    },
    subtitleCues: [
      { id: 'cue-a', segmentId: 'segment-a', text: '第一句', startUs: 0, endUs: 5_000_000, textSource: 'script', timingSource: 'aligned' },
      { id: 'cue-b', segmentId: 'segment-b', text: '第二句', startUs: 5_000_000, endUs: 10_000_000, textSource: 'script', timingSource: 'aligned' },
    ],
    textStyles: { '3x4': structuredClone(styles), '9x16': structuredClone(styles), '16x9': structuredClone(styles) },
    packaging: { enabled: false, template: 'overlay-poster', varsOverrides: {}, pointCues: [] },
    variants: [{
      id: 'variant-e2e',
      indexNum: 1,
      outputPreset: '3x4',
      timeline: {
        fps: FPS,
        introFrames: INTRO_FRAMES,
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
    assets: [
      { assetKey: 'module4:video-a', source: 'module4', videoJobId: 'video-a', shotSetId: 'shot-set-e2e', shotId: 'shot-a', filename: 'a.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-a', analysisStatus: 'succeeded', summary: '素材 A', autoUseDisabled: false, usageCount: 1 },
      { assetKey: 'module4:video-b', source: 'module4', videoJobId: 'video-b', shotSetId: 'shot-set-e2e', shotId: 'shot-b', filename: 'b.mp4', previewUrl: '', thumbnailUrl: transparentPixel, durationUs: 8_000_000, fingerprint: 'fingerprint-b', analysisStatus: 'succeeded', summary: '素材 B', autoUseDisabled: false, usageCount: 1 },
    ],
    bgmTracks: [{ id: 'bgm-e2e', filename: 'e2e.mp3', relativePath: 'bgm/e2e.mp3', durationUs: 20_000_000 }],
    coverCandidates: [{ coverKey: 'cover-e2e', sourceUrl: transparentPixel, kind: 'storyboard_image' }],
    jobs: [{ id: 'job-e2e', variantId: null, kind: 'prepare', status: 'succeeded', phase: 'ready', progress: 1, estimatedCost: null, costCurrency: 'CNY', errorCode: null, errorMessage: null, startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:10.000Z', createdAt: '2026-11-01T00:00:00.000Z' }],
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startNextDevServer() {
  const port = await getFreePort();
  const nextBin = path.resolve('node_modules/next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev server exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status < 500) return { child, baseUrl, output: () => output };
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Next dev server did not become ready:\n${output}`);
}

async function stopNextDevServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** 预览对话框要播「真实导出的成片，有声音」：用打包同源的 ffmpeg 现造一条 3:4 带音轨的 mp4。 */
async function createFixtureFilm() {
  const { default: ffmpegStatic } = await import('ffmpeg-static');
  const directory = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP, 'mixcut09-film-'));
  const file = path.join(directory, 'film.mp4');
  const result = await new Promise((resolve) => {
    const child = spawn(ffmpegStatic, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x2f6db5:s=1080x1440:d=4:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, `测试成片生成失败：${result.stderr}`);
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 10_000, '测试成片体积异常');
  return { bytes, file };
}

const project = {
  id: 'e2e-project',
  name: '09 验收项目',
  providerId: 'provider-e2e',
  model: 'model-e2e',
  prompt: '',
  status: 'draft',
  concurrency: 1,
  maxAttempts: 1,
  productName: '验收产品',
  productCode: '09-E2E',
  images: [],
  jobs: [],
  provider: null,
};

const context = {
  project: { id: project.id, name: project.name, productName: project.productName, productCode: project.productCode, createdAt: '2026-11-01T00:00:00.000Z', taskDate: '20261101' },
  shotSets: [{ id: 'shot-set-e2e', name: '验收分镜组', shotCount: 2, succeededVideoCount: 2, totalDurationUs: 10_000_000 }],
  currentShotSetId: 'shot-set-e2e',
  drafts: [{ id: 'draft-e2e', version: 3, shotSetId: 'shot-set-e2e', title: '09 验收成片', narrationText: '第一句。第二句。', targetDurationSec: 10, provider: 'mock', model: 'mock', createdAt: '2026-11-01T00:00:00.000Z' }],
  videoAssets: [
    { videoJobId: 'video-a', shotSetId: 'shot-set-e2e', filename: 'a.mp4', durationUs: 5_000_000, width: 1080, height: 1440, thumbnailUrl: transparentPixel, source: 'module4' },
    { videoJobId: 'video-b', shotSetId: 'shot-set-e2e', filename: 'b.mp4', durationUs: 5_000_000, width: 1080, height: 1440, thumbnailUrl: transparentPixel, source: 'module4' },
  ],
};

const server = await startNextDevServer();
const film = await createFixtureFilm();
let browser;

/** 每屏都重新装一遍 mock：导出流程会推进 job 状态，各内核、各窗口互不影响。 */
async function preparePage(engine, viewport) {
  const instance = await engine.launch({ headless: true });
  const page = await instance.newPage({ viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  let savedGroup = createGroup();
  let renderJob = null;
  let renderPollCount = 0;
  const routes = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    routes.push(`${request.method()} ${pathname}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

    if (pathname === '/api/projects/e2e-project') return json(project);
    if (pathname === '/api/projects/e2e-project/run') return json({ queueStatus: 'idle' });
    if (pathname === '/api/team/auth/session') return json({ role: 'employee' });
    if (pathname === '/api/team/models') {
      const kind = url.searchParams.get('kind');
      if (kind === 'image') return json([{ id: 'provider-e2e', name: '图示供应商', model: 'gpt-image-2', enabled: 1, hasApiKey: true }]);
      if (kind === 'tts') return json([{ id: 'tts-e2e', name: 'Mock TTS', model: 'mock-tts', configured: true, voices: [{ id: 'voice-e2e', label: '验收音色' }] }]);
      if (kind === 'script') return json([{ id: 'vision-e2e', name: 'Mock Vision', model: 'mock-vision', configured: true, supportsVision: true }]);
      return json([]);
    }
    if (pathname === '/api/providers/tts') return json([{ id: 'tts-e2e', name: 'Mock TTS', model: 'mock-tts', configured: true, voices: [{ id: 'voice-e2e', label: '验收音色' }] }]);
    if (pathname === '/api/providers/script') return json([{ id: 'vision-e2e', configured: true, supportsVision: true }]);
    if (pathname === '/api/system-fonts') return json(['Arial']);
    if (pathname === '/api/final-edit/capabilities') return json({ revealInFolder: false });
    if (pathname === '/api/final-edit/title-presets') return json([]);
    if (pathname === '/api/projects/e2e-project/final-edit/context') return json(context);
    if (pathname === '/api/projects/e2e-project/final-edit/shot-sets/shot-set-e2e/external-assets') return json({ assets: [] });
    if (pathname === '/api/projects/e2e-project/final-edit/groups') return json({ groups: [savedGroup] });
    if (pathname === '/api/final-edit-groups/group-e2e' && request.method() === 'GET') return json(savedGroup);
    if (pathname === '/api/final-edit-groups/group-e2e/cover-frame') return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(transparentPixel.split(',')[1], 'base64') });
    if (pathname === '/api/final-edit-groups/group-e2e/narration') return route.fulfill({ status: 204, body: '' });
    if (pathname === '/api/final-edit-groups/group-e2e/overlay-bundles/3x4' && request.method() === 'POST') return json({ id: 'overlay-e2e' }, 201);
    if (pathname === '/api/final-edit-groups/group-e2e/download') return route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK') });
    if (pathname === '/api/final-edit-variants/variant-e2e/render' && request.method() === 'POST') {
      renderJob = {
        id: 'render-job-e2e', groupId: 'group-e2e', variantId: 'variant-e2e', status: 'queued', phase: 'queued', progress: 0,
        target: {
          taskName: project.name, productCode: project.productCode, taskDate: '20261101',
          videoFilename: '成片-09-E2E-20261101.mp4', coverFilename: '成片-09-E2E-20261101-封面.jpg',
          displayDirectory: `工作台/${project.name}/成片/`,
        },
        output: null,
        renderRevision: { groupRevision: savedGroup.revision, variantRevision: savedGroup.variants[0].revision },
      };
      return json({ id: renderJob.id, groupId: renderJob.groupId, variantId: renderJob.variantId, status: 'queued', target: renderJob.target });
    }
    if (pathname === '/api/final-edit-jobs/render-job-e2e' && request.method() === 'GET') {
      renderPollCount += 1;
      if (renderPollCount <= 1) {
        renderJob = { ...renderJob, status: 'running', phase: 'composition', progress: 0.42 };
        return json(renderJob);
      }
      renderJob = {
        ...renderJob,
        status: 'succeeded',
        phase: 'succeeded',
        progress: 1,
        output: {
          videoFilename: '成片-09-E2E-20261101.mp4',
          coverFilename: '成片-09-E2E-20261101-封面.jpg',
          displayDirectory: `工作台/${project.name}/成片/`,
          videoUrl: '/api/final-edit-jobs/render-job-e2e/video',
          videoDownloadUrl: '/api/final-edit-jobs/render-job-e2e/video?download=1',
          coverUrl: '/api/final-edit-jobs/render-job-e2e/cover',
          coverDownloadUrl: '/api/final-edit-jobs/render-job-e2e/cover?download=1',
        },
      };
      return json(renderJob);
    }
    if (/^\/api\/final-edit-jobs\/render-job-e2e\/video$/.test(pathname)) {
      // 真实 H.264 + AAC 成片：预览对话框要能解出声音、时长，并且**能拖动进度条**。
      // 拖动依赖 Range 请求：Chromium 对不支持 Range 的响应把 seekable 报成 0，
      // 那时 currentTime 赋值无效——和「实现没做跳转」是两件事，所以这里必须如实支持 Range。
      const range = request.headers()['range'];
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(Number(match[2]), film.bytes.length - 1) : film.bytes.length - 1;
          const chunk = film.bytes.subarray(start, end + 1);
          return route.fulfill({
            status: 206,
            headers: {
              'Content-Type': 'video/mp4',
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${film.bytes.length}`,
              'Content-Length': String(chunk.length),
            },
            body: chunk,
          });
        }
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(film.bytes.length) },
        body: film.bytes,
      });
    }
    if (/^\/api\/final-edit-jobs\/render-job-e2e\/cover$/.test(pathname)) return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from(transparentPixel.split(',')[1], 'base64') });
    if (pathname === '/api/final-edit-bgm') return route.fulfill({ status: 204, body: '' });
    if (pathname.startsWith('/api/final-edit-bgm/')) return route.fulfill({ status: 204, body: '' });
    return json({ error: `Unhandled E2E API: ${request.method()} ${pathname}` }, 404);
  });
  return { instance, page, routes };
}

/** 读混剪外壳与它父容器的几何。 */
function readShellGeometry(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="mixcut-shell"]');
    if (!shell) return null;
    const rect = shell.getBoundingClientRect();
    const parent = shell.parentElement?.parentElement ?? shell.parentElement;
    const parentRect = parent?.getBoundingClientRect();
    return {
      mode: document.documentElement.dataset.deploymentMode ?? '',
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      parentLeft: parentRect ? Math.round(parentRect.left * 10) / 10 : null,
      parentWidth: parentRect ? Math.round(parentRect.width * 10) / 10 : null,
    };
  });
}

try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1536, height: 864 }]) {
      const { instance, page } = await preparePage(engine, viewport);
      browser = instance;
      try {
        await page.goto(`${server.baseUrl}/projects/e2e-project?tab=final-edit`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
        await page.getByText('当前素材组').first().waitFor({ timeout: 180_000 });
        await page.getByTestId('mixcut-shell').waitFor({ timeout: 60_000 });

        const local = await readShellGeometry(page);
        assert.ok(local, `${engineName} ${viewport.width}: 混剪外壳必须存在`);
        assert.equal(local.mode, 'local', `${engineName} ${viewport.width}: 本测试跑在未开启团队模式的 dev server 上，应是 local`);
        // 本地版：保留 8 月定的破格宽度（按视口算，且居中突破父栏），与改版前一致。
        const expectedLocalWidth = Math.min(1440, local.viewportWidth - 48);
        assert.ok(Math.abs(local.width - expectedLocalWidth) <= 2,
          `${engineName} ${viewport.width}: 本地版宽度必须仍是 min(1440px, 100vw - 48px) = ${expectedLocalWidth}px，实际 ${local.width}px`);
        assert.ok(local.right <= local.viewportWidth + 1, `${engineName} ${viewport.width}: 本地版破格后仍不得超出视口`);

        // 团队版：同一套 DOM 只换 html[data-deployment-mode]，宽度必须改成「占满内容区」。
        await page.evaluate(() => { document.documentElement.dataset.deploymentMode = 'server'; });
        await page.waitForTimeout(150);
        const team = await readShellGeometry(page);
        assert.ok(team, `${engineName} ${viewport.width}: 切换团队版后外壳仍在`);
        assert.ok(team.documentScrollWidth <= team.documentClientWidth + 1,
          `${engineName} ${viewport.width}: 团队版不得横向滚动（scrollWidth ${team.documentScrollWidth} > clientWidth ${team.documentClientWidth}）`);
        assert.ok(Math.abs(team.left - team.parentLeft) <= 1.5,
          `${engineName} ${viewport.width}: 团队版外壳必须从内容区左边界开始（外壳 ${team.left}px，内容区 ${team.parentLeft}px）`);
        assert.ok(Math.abs(team.width - team.parentWidth) <= 1.5,
          `${engineName} ${viewport.width}: 团队版外壳必须占满内容区宽度（外壳 ${team.width}px，内容区 ${team.parentWidth}px）`);
        assert.ok(team.right <= team.viewportWidth + 1, `${engineName} ${viewport.width}: 团队版外壳不得越出视口右边界`);
        // 恢复本地版，后面的步骤断言仍按原设计跑。
        await page.evaluate(() => { document.documentElement.dataset.deploymentMode = 'local'; });
      } finally {
        await browser.close();
        browser = null;
      }
    }
  }

  // ---- 1280×720：打开截取条后剪辑区预览仍 ≥ 200px，中间一栏自己滚 ----
  {
    const { instance, page } = await preparePage(chromium, { width: 1280, height: 720 });
    browser = instance;
    try {
      await page.goto(`${server.baseUrl}/projects/e2e-project?tab=final-edit`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      await page.getByText('当前素材组').first().waitFor({ timeout: 180_000 });
      await page.getByRole('navigation', { name: '智能混剪步骤' }).getByRole('button', { name: /预览调整/ }).click();
      await page.locator('[data-track="video"]').waitFor({ timeout: 60_000 });

      const previewHeight = () => page.evaluate(() => {
        const frame = document.querySelector('[data-output-preset]');
        return frame ? Math.round(frame.getBoundingClientRect().height) : 0;
      });
      const beforeTrim = await previewHeight();
      assert.ok(beforeTrim >= 300, `1280×720：放大后的剪辑区预览不得低于 300px，实际 ${beforeTrim}px`);
      const previewWidth = await page.locator('[data-preview-preset]').last().evaluate(element => ({
        width: element.getBoundingClientRect().width, available: element.parentElement.getBoundingClientRect().width,
      }));
      assert.ok(Math.abs(previewWidth.width - previewWidth.available) <= 2, '预览应利用中栏全宽');
      console.log(`1280×720 preview: height=${beforeTrim}px, width=${Math.round(previewWidth.width)}px`);
      if (process.env.MIXCUT_PREVIEW_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.MIXCUT_PREVIEW_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MIXCUT_PREVIEW_EVIDENCE_DIR, 'preview-1280x720.png') });
      }

      await page.locator('[data-clip-id="clip-a"]').dblclick();
      await page.getByText(/截取片段 #1/).waitFor({ timeout: 30_000 });
      const afterTrim = await previewHeight();
      assert.ok(afterTrim >= 200, `1280×720 打开截取条后：剪辑区预览不得低于 200px，实际 ${afterTrim}px`);

      // 放不下时中间一栏自己滚（不是整页滚）。
      const scrollState = await page.evaluate(() => {
        const main = document.querySelector('[data-track="video"]')?.closest('main');
        return {
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          mainScrollable: main ? main.scrollHeight > main.clientHeight + 1 : false,
          mainOverflowY: main ? getComputedStyle(main).overflowY : '',
        };
      });
      assert.equal(scrollState.pageOverflowX <= 1, true, '1280×720：整页不得横向溢出');
      assert.equal(scrollState.mainOverflowY, 'auto', '1280×720：中间一栏必须自己滚动（不是整页滚）');
      assert.equal(scrollState.mainScrollable, true, '1280×720 打开截取条后：中间一栏内容超出可视高度时必须能自己滚');

      // 截取条的既有交互保持不变：聚焦截取条后 Esc 取消（Esc 由截取条自己的键盘处理接管）。
      await page.getByRole('slider', { name: '移动截取选框' }).focus();
      await page.keyboard.press('Escape');
      await page.getByText(/截取片段 #1/).waitFor({ state: 'detached', timeout: 10_000 });
    } finally {
      await browser.close();
      browser = null;
    }
  }

  // ---- 导出成功后点成片打开大预览 ----
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const { instance, page } = await preparePage(engine, { width: 1536, height: 864 });
    browser = instance;
    try {
      await page.goto(`${server.baseUrl}/projects/e2e-project?tab=final-edit`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      await page.getByText('当前素材组').first().waitFor({ timeout: 180_000 });
      await page.getByRole('navigation', { name: '智能混剪步骤' }).getByRole('button', { name: /预览调整/ }).click();
      await page.locator('[data-track="video"]').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '下一步：导出' }).click();
      await page.getByRole('heading', { name: '导出并写回项目' }).waitFor({ timeout: 60_000 });

      const renderResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-variants/variant-e2e/render') && response.request().method() === 'POST');
      await page.getByRole('button', { name: '开始导出' }).click();
      await renderResponse;
      await page.getByText('成片-09-E2E-20261101.mp4', { exact: true }).waitFor({ timeout: 90_000 });

      // 导出结果里不再内嵌播放器：成片是「点了打开大预览」的卡片。
      const resultCard = page.getByRole('button', { name: '打开成片预览' });
      await resultCard.waitFor({ timeout: 30_000 });
      assert.equal(await page.locator('section[aria-label="导出结果"] video[controls]').count(), 0,
        `${engineName}: 导出结果卡片里不得再嵌 controls 播放器（改由预览对话框播放）`);
      assert.equal(await page.locator('section[aria-label="导出结果"] video').count(), 0,
        `${engineName}: 成片卡片应使用封面，点击前不加载视频`);
      const cardBox = await resultCard.boundingBox();
      assert.ok(cardBox && cardBox.width <= 280 && Math.abs(cardBox.width / cardBox.height - 0.75) < 0.02,
        `${engineName}: 成片应为竖版封面卡片，不得撑成整栏黑屏（实际 ${JSON.stringify(cardBox)}）`);
      assert.equal(await resultCard.getByRole('img', { name: '成片封面' }).count(), 1);

      await resultCard.click();
      const dialog = page.getByTestId('film-preview-dialog');
      await dialog.waitFor({ timeout: 30_000 });
      await page.getByRole('dialog', { name: '成片预览' }).waitFor({ timeout: 10_000 });

      // 画面是 3:4，而且够大（宽 ≥ 200px、高 ≥ 260px，1536×864 下的实际可用高度）。
      const stage = await page.evaluate(() => {
        const element = document.querySelector('[data-testid="film-preview-stage"]');
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          ratio: rect.height > 0 ? Number((rect.width / rect.height).toFixed(4)) : null,
          preset: element.getAttribute('data-preset'),
          inlineWidth: element.style.width,
          inlineHeight: element.style.height,
        };
      });
      assert.ok(stage, `${engineName}: 预览舞台必须存在`);
      assert.equal(stage.preset, '3x4', `${engineName}: 成片画幅必须标成 3x4`);
      assert.ok(Math.abs(stage.ratio - 0.75) <= 0.02, `${engineName}: 预览画面比例必须是 3:4（实际 ${stage.width}×${stage.height}，比例 ${stage.ratio}）`);
      assert.ok(stage.width >= 200 && stage.height >= 260, `${engineName}: 预览画面必须够大（实际 ${stage.width}×${stage.height}）`);
      // 宽高由代码算出来并显式写死，不靠 aspect-ratio 反推（Safari 会被挤成细条）。
      assert.match(stage.inlineWidth, /^\d+px$/, `${engineName}: 预览宽度必须由代码显式算出（实际 style.width=${stage.inlineWidth || '空'}）`);
      assert.match(stage.inlineHeight, /^\d+px$/, `${engineName}: 预览高度必须由代码显式算出（实际 style.height=${stage.inlineHeight || '空'}）`);

      // 播放的是真实导出的成片，且不静音。
      const media = await page.evaluate(() => {
        const video = document.querySelector('[data-testid="film-preview-stage"] video');
        if (!video) return null;
        return { src: video.getAttribute('src'), muted: video.muted, volume: video.volume, autoplay: video.autoplay };
      });
      assert.ok(media, `${engineName}: 预览里必须有视频元素`);
      assert.equal(media.src, '/api/final-edit-jobs/render-job-e2e/video', `${engineName}: 必须播放导出的成片 URL`);
      assert.equal(media.muted, false, `${engineName}: 预览必须有声音（不得静音）`);
      assert.equal(media.volume, 1, `${engineName}: 预览音量必须是默认满值`);
      assert.equal(media.autoplay, false, `${engineName}: 不得自动播放`);

      // 信息栏：时长 / 画幅 / 包装 / 文件名。
      const infoText = await dialog.innerText();
      assert.match(infoText, /时长/, `${engineName}: 信息栏必须显示时长`);
      assert.match(infoText, /3:4/, `${engineName}: 信息栏必须显示画幅`);
      assert.match(infoText, /包装/, `${engineName}: 信息栏必须显示包装`);
      assert.match(infoText, /成片-09-E2E-20261101\.mp4/, `${engineName}: 信息栏必须显示文件名`);

      if (engineName === 'chromium') {
        // 解码相关的断言只在本机能解 H.264 的内核上跑（WebKit 实测 loadedmetadata 不触发）。
        await page.waitForFunction(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && Number.isFinite(video.duration) && video.duration > 1;
        }, null, { timeout: 30_000 });

        // 点击进度条中段 → 跳转。
        const bar = page.getByRole('slider', { name: '预览进度' });
        const barBox = await bar.boundingBox();
        assert.ok(barBox, '进度条必须可见');
        await page.mouse.click(barBox.x + barBox.width * 0.6, barBox.y + barBox.height / 2);
        await page.waitForFunction(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && video.currentTime >= 1.5;
        }, null, { timeout: 15_000 });
        const afterClick = await page.evaluate(() => document.querySelector('[data-testid="film-preview-stage"] video').currentTime);
        assert.ok(afterClick >= 1.5 && afterClick <= 3.2, `点击进度条 60% 后必须跳到约 2.4 秒处（实际 ${afterClick.toFixed(2)}s）`);

        // 拖动进度条 → 持续跳转。
        await page.mouse.move(barBox.x + barBox.width * 0.2, barBox.y + barBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(barBox.x + barBox.width * 0.35, barBox.y + barBox.height / 2, { steps: 6 });
        await page.mouse.up();
        const afterDrag = await page.evaluate(() => document.querySelector('[data-testid="film-preview-stage"] video').currentTime);
        assert.ok(afterDrag >= 0.8 && afterDrag <= 2.2, `拖动进度条必须跳到约 1.4 秒处（实际 ${afterDrag.toFixed(2)}s）`);

        // 空格播放 → 再按空格暂停。
        await page.keyboard.press(' ');
        await page.waitForFunction(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && !video.paused;
        }, null, { timeout: 15_000 });
        await page.waitForFunction((afterDrag) => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && video.currentTime > afterDrag + 0.15;
        }, afterDrag, { timeout: 15_000 });
        await page.getByRole('button', { name: '暂停预览' }).waitFor({ timeout: 10_000 });
        await page.keyboard.press(' ');
        await page.waitForFunction(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && video.paused;
        }, null, { timeout: 15_000 });

        // 预览开着时方向键不翻页：事件能到达页面（capture 阶段看得到），
        // 但必须在捕获阶段被对话框拦下——不会冒泡回页面（bubble 阶段收不到），
        // 也不会改播放位置、不会滚页面。
        const beforeArrows = await page.evaluate(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          globalThis.__arrowProbe = { capture: [], bubble: [], preventedAtWindow: [] };
          // window 的捕获阶段在 document 之前跑：记下「按键确实到了页面」。
          window.addEventListener('keydown', (event) => {
            if (!event.key.startsWith('Arrow')) return;
            globalThis.__arrowProbe.capture.push(event.key);
            globalThis.__arrowProbe.preventedAtWindow.push(event.defaultPrevented);
          }, true);
          // 冒泡阶段在 document 之后跑：对话框一旦 stopPropagation，这里就收不到。
          window.addEventListener('keydown', (event) => {
            if (!event.key.startsWith('Arrow')) return;
            globalThis.__arrowProbe.bubble.push(event.key);
          });
          return { currentTime: video ? video.currentTime : null, scrollX: window.scrollX, scrollY: window.scrollY };
        });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowLeft');
        const afterArrows = await page.evaluate(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return {
            probe: globalThis.__arrowProbe,
            currentTime: video ? video.currentTime : null,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            dialogStillOpen: Boolean(document.querySelector('[data-testid="film-preview-dialog"]')),
          };
        });
        assert.deepEqual(afterArrows.probe.capture, ['ArrowRight', 'ArrowLeft'], '方向键必须真的送到页面（才能验证被吞掉）');
        assert.deepEqual(afterArrows.probe.bubble, [], '预览开着时方向键必须在捕获阶段被拦下，不得冒泡回页面（不翻页）');
        assert.equal(afterArrows.dialogStillOpen, true, '方向键不得关闭预览');
        assert.equal(afterArrows.currentTime, beforeArrows.currentTime, '方向键不得改变成片播放位置');
        assert.equal(afterArrows.scrollX, beforeArrows.scrollX, '方向键不得让页面横向滚动');
        assert.equal(afterArrows.scrollY, beforeArrows.scrollY, '方向键不得让页面纵向滚动');

        // 播放起来再 Esc：关闭 + 停止播放。
        await page.keyboard.press(' ');
        await page.waitForFunction(() => {
          const video = document.querySelector('[data-testid="film-preview-stage"] video');
          return video && !video.paused;
        }, null, { timeout: 15_000 });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached', timeout: 10_000 });
        assert.equal(await page.getByTestId('film-preview-stage').count(), 0, 'Esc 关闭后预览舞台必须消失');
        const anyPlaying = await page.evaluate(() => [...document.querySelectorAll('video')].some((video) => !video.paused));
        assert.equal(anyPlaying, false, 'Esc 关闭预览必须同时停止播放');
      } else {
        // WebKit：Esc 关闭 + 停止播放（不依赖解码）。
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached', timeout: 10_000 });
        assert.equal(await page.getByTestId('film-preview-stage').count(), 0, 'Esc 关闭后预览舞台必须消失');
      }

      await page.close();
    } finally {
      await browser.close();
      browser = null;
    }
  }

  console.log('mixcut 09 layout + trim preview + export preview dialog tests passed');
} catch (error) {
  console.error(error);
  console.error(`dev server output:\n${server.output()}`);
  throw error;
} finally {
  await browser?.close();
  await stopNextDevServer(server.child);
  fs.rmSync(path.dirname(film.file), { recursive: true, force: true });
}
