/**
 * C3 BGM 换源续播 · 真实浏览器播放验证（复核 F2/F3 的运行时证据）。
 *
 * 运行方式（与 batch-preparation-workspace.playwright.test.mjs 相同）：
 *   npm run build && node scripts/batch-bgm-source-switch.playwright.test.mjs
 *   M7_BROWSER_DEV=1 使用源码开发服务；M7_MEDIA_EDIT_ONLY=1 运行新增剪辑操作回归。
 *   M7_BROWSER_DIRECT_EDITS=1 仅用于开发服务路由异常时的 UI+真实领域层回归，不覆盖 HTTP 路由。
 *
 * 与源码匹配测试不同，本文件用真实 standalone 服务 + 真实媒体文件（ffmpeg 生成）
 * 驱动「检查成片 → 调整片段」编辑器，在播放中切换 BGM 曲目并断言 <audio> 的
 * 实际播放状态，覆盖执行方案 §5.4 要求的浏览器证据：
 *   - 播放中从「关闭 BGM」选曲 → 新源生效、paused === false、按正文偏移定位；
 *   - 播放中曲目 A → B 换源续播，位置与正文播放头对齐；
 *   - 切回「关闭 BGM」暂停；再次选曲仍能续播（F3 的两条 null → track 路径）；
 *   - 画面播放头全程不归零。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { applyBatchOutputClipEdit, getBatchOutputArrangementView } from '../lib/batch-production/output-arrangement.ts';

const standaloneServer = path.join(process.cwd(), '.next', 'standalone', 'server.js');
assert.ok(fs.existsSync(standaloneServer), '请先运行 npm run build，再执行 BGM 换源浏览器验收');

const INTRO_SEC = 20 / 24; // 与组件内片头常量一致（20 帧 / 24fps）
const BODY_SEC = 15; // 正文（口播与片段）时长，给断言留足播放余量

async function reservePort() {
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

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`生产服务提前退出，exit=${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/batch-production/readiness`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('测试服务未在 60 秒内就绪');
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-switch-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];
// lib 函数（createAsset/addAssetToPool 等）按 dataRoot() 解析 storage 路径，
// 测试进程与 server 必须共享同一数据根。
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const useDevServer = process.env.M7_MEDIA_EDIT_ONLY === '1' || process.env.M7_BROWSER_DEV === '1';
const server = spawn(process.execPath, useDevServer ? [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)] : [standaloneServer], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CREATIVE_STUDIO_DATA_ROOT: dataRoot,
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: useDevServer ? 'development' : 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));

async function makeSineAudio(absolutePath, frequency, durationSec, outputArgs) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSec}`,
    '-ar', '44100', '-ac', '2', ...outputArgs, '-y', absolutePath,
  ]);
}

/** 等待 BGM <audio> 达到目标状态：src 命中指定曲目（或清空）、播放/暂停、位置下限。 */
async function waitForBgmState(page, { trackId, playing, minCurrentTime }) {
  try {
    await page.waitForFunction(({ trackId, playing, minCurrentTime }) => {
      const element = document.querySelector('audio[loop]');
      if (!element) return false;
      // 关闭 BGM 用 src attribute 判断：移除 attribute 后 Chromium 的
      // currentSrc 会保留旧值直到下一次 load，不能作为「已清空」的证据。
      const srcAttr = element.getAttribute('src') || '';
      const srcMatches = trackId === null
        ? srcAttr === ''
        : srcAttr.includes(encodeURIComponent(trackId));
      return srcMatches
        && element.paused === !playing
        && element.currentTime >= minCurrentTime;
    }, { trackId, playing, minCurrentTime }, { timeout: 6_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const element = document.querySelector('audio[loop]');
      if (!element) return 'audio[loop] 元素不存在';
      return {
        src: element.getAttribute('src'),
        currentSrc: element.currentSrc,
        paused: element.paused,
        currentTime: element.currentTime,
        readyState: element.readyState,
        networkState: element.networkState,
        error: element.error ? `${element.error.code}:${element.error.message}` : null,
      };
    });
    process.stderr.write(`BGM 状态等待超时，目标 trackId=${trackId} playing=${playing}，实际状态=${JSON.stringify(diagnostics)}\n`);
    throw error;
  }
}

let browser;
let page;
let directEditDb;
const pageErrors = [];
try {
  await waitForServer(baseUrl, server);

  const storageRoot = path.join(dataRoot, 'storage');
  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.prepare(`
    INSERT INTO providers (id, name, baseUrl, model, type)
    VALUES ('bgm-switch-provider', 'BGM Switch', 'http://127.0.0.1', 'smoke', 'openai-compatible')
  `).run();
  const projectId = 'bgm-switch-project';
  db.prepare(`
    INSERT INTO projects (id, name, providerId, model, prompt, workflowType, productCode)
    VALUES (?, 'BGM 换源验收项目', 'bgm-switch-provider', 'smoke', 'smoke', 'complex_product', 'BGMSW')
  `).run(projectId);

  // BGM 曲库：两首不同音高的真实 mp3（12 秒 > 正文，避免循环取模干扰位置断言）。
  fs.mkdirSync(path.join(storageRoot, 'bgm'), { recursive: true });
  const bgmTracks = [
    { id: 'bgm-switch-track-a', frequency: 220 },
    { id: 'bgm-switch-track-b', frequency: 330 },
  ];
  for (const { id, frequency } of bgmTracks) {
    const bgmPath = path.join(storageRoot, 'bgm', `${id}.mp3`);
    await makeSineAudio(bgmPath, frequency, BODY_SEC + 3, ['-c:a', 'libmp3lame']);
    const fingerprint = createHash('sha256').update(fs.readFileSync(bgmPath)).digest('hex');
    db.prepare(`
      INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
      VALUES (?, ?, ?, ?, 'mp3', 'ready', datetime('now'))
    `).run(id, `bgm/${id}.mp3`, fingerprint, (BODY_SEC + 3) * 1_000_000);
  }

  // 口播音频：真实 wav，供预览双声道播放链路加载。
  const narrationDir = path.join(storageRoot, 'batch-narration', projectId);
  fs.mkdirSync(narrationDir, { recursive: true });
  const narrationPath = path.join(narrationDir, 'narration.wav');
  await makeSineAudio(narrationPath, 440, BODY_SEC, ['-c:a', 'pcm_s16le']);

  // 冻结批次：素材池（managed 真实 mp4）+ 脚本快照 + 一张成片计划。
  const batchId = createBatchProduction(db, projectId, 'BGM 换源验收批次');
  const versionId = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: BODY_SEC },
  });
  const scriptId = createProjectScript(db, projectId, {
    sourceKind: 'script_draft',
    sourceId: 'bgm-switch-script-source',
    title: '换源脚本',
    bodyText: '用于验证播放中切换 BGM 的文案。',
    sourceVersion: '1',
    metadata: { shotSetId: 'shot-set-bgm', contentRevision: 'revision-1' },
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);
  assert.equal(planIds.length, 1);
  const planId = planIds[0];

  const mediaDir = path.join(storageRoot, 'batch-media', projectId);
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaRelativePath = path.join('storage', 'batch-media', projectId, 'source.mp4');
  const mediaAbsolutePath = path.join(dataRoot, mediaRelativePath);
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=steelblue:duration=${BODY_SEC}:size=540x960:rate=12`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', mediaAbsolutePath,
  ]);
  const mediaFingerprint = `sha256:${createHash('sha256').update(fs.readFileSync(mediaAbsolutePath)).digest('hex')}`;
  const assetId = createAsset(db, {
    projectId,
    sourceKind: 'managed',
    locationJson: { kind: 'managed', relativePath: mediaRelativePath },
    contentFingerprint: mediaFingerprint,
    mediaKind: 'video',
    mediaJson: { displayName: '换源素材', durationSec: BODY_SEC, width: 540, height: 960 },
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'managed', ?, 'healthy', datetime('now'))
  `).run(randomUUID(), assetId, JSON.stringify({ kind: 'managed', relativePath: mediaRelativePath }));
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'bgm-switch-v1',
    providerId: 'bgm-switch-provider',
    model: 'smoke',
    analysisJson: {
      durationUs: BODY_SEC * 1_000_000,
      usableRanges: [{ startUs: 0, endUs: BODY_SEC * 1_000_000, qualityScore: 1 }],
    },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });

  // 输入冻结 + 当前成片版本（初始 music.trackId = null，即「关闭 BGM」）。
  db.prepare(`
    UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = datetime('now') WHERE id = ?
  `).run(versionId);
  const outputVersionId = createOutputVersion(db, planId, {
    arrangementJson: {
      preset: '3:4',
      clips: [{
        clipId: 'clip-1',
        segmentId: '',
        assetId,
        contentFingerprint: mediaFingerprint,
        sourceStartUs: 0,
        sourceEndUs: BODY_SEC * 1_000_000,
        timelineStartUs: 0,
        timelineEndUs: BODY_SEC * 1_000_000,
      }],
      narration: {
        audioRelativePath: `batch-narration/${projectId}/narration.wav`,
        durationUs: BODY_SEC * 1_000_000,
        gainDb: 0,
      },
      // 初始关闭 BGM：播放中第一次选曲正是 F3 的原始复现路径。
      music: { trackId: null, gainDb: -18, fadeInSec: 0, fadeOutSec: 0 },
    },
  });

  // 渲染候选（真实小文件），让检查成片卡片可点开预览。
  const candidateDir = path.join(storageRoot, 'batch-renders', outputVersionId, 'fixture');
  fs.mkdirSync(candidateDir, { recursive: true });
  const candidateVideoPath = path.join(candidateDir, 'video.mp4');
  fs.copyFileSync(mediaAbsolutePath, candidateVideoPath);
  const candidateCoverPath = path.join(candidateDir, 'cover.jpg');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=darkseagreen:size=540x960:rate=1',
    '-frames:v', '1', '-y', candidateCoverPath,
  ]);
  const taskId = createBatchTask(db, projectId, {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionId,
    requestKey: `bgm-switch-candidate:${outputVersionId}`,
  });
  const resultJson = JSON.stringify({
    projectId,
    batchId,
    batchVersionId: versionId,
    planId,
    outputVersionId,
    videoRelativePath: path.relative(storageRoot, candidateVideoPath),
    coverRelativePath: path.relative(storageRoot, candidateCoverPath),
    durationUs: BODY_SEC * 1_000_000,
    audioMode: 'narration',
    productionReady: true,
  });
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(randomUUID(), taskId, resultJson);
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(taskId);
  db.close();

  browser = await chromium.launch({
    headless: true,
    // 换源续播的 play() 不在点击事件同步栈里（select onChange → effect → play），
    // 放宽手势策略让媒体播放只取决于被测逻辑本身。
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(useDevServer ? 30_000 : 10_000);
  page.setDefaultNavigationTimeout(useDevServer ? 60_000 : 10_000);
  if (process.env.M7_BROWSER_DIRECT_EDITS === '1' && process.env.M7_MEDIA_EDIT_ONLY === '1') {
    directEditDb = new Database(path.join(dataRoot, 'data', 'workbench.db'));
    directEditDb.pragma('foreign_keys = ON');
    await page.route(`**/outputs/${planId}/arrangement?*`, async (route) => {
      await route.fulfill({ json: getBatchOutputArrangementView(directEditDb, projectId, batchId, planId) });
    });
    await page.route(`**/outputs/${planId}/clips?*`, async (route) => {
      try {
        const result = applyBatchOutputClipEdit(directEditDb, projectId, batchId, planId, route.request().postDataJSON());
        await route.fulfill({ json: result });
      } catch (error) {
        await route.fulfill({ status: 400, json: { message: error.message } });
      }
    });
  }
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('response', async (response) => {
    if (response.url().includes('/arrangement?') && !response.ok()) serverOutput.push(`Arrangement HTTP ${response.status()}: ${(await response.text().catch(() => '')).slice(0, 1200)}\n`);
  });

  await page.goto(`${baseUrl}/projects/${projectId}?tab=final-edit`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '批量生产', exact: true }).click();
  await page.getByRole('heading', { name: '素材区' }).waitFor();
  // 直达「检查成片」：fixture 已是冻结批次 + 当前成片版本。
  await page.getByRole('button', { name: /检查成片/ }).click();
  await page.getByTestId('batch-output-card').first().waitFor();
  await page.getByRole('button', { name: /^编辑成片 1 / }).click();

  if (process.env.M7_MEDIA_EDIT_ONLY === '1') {
    const arrangementUrl = `${baseUrl}/api/batch-production/batches/${batchId}/outputs/${planId}/arrangement?projectId=${projectId}`;
    const readArrangement = async () => directEditDb ? getBatchOutputArrangementView(directEditDb, projectId, batchId, planId) : fetch(arrangementUrl).then((response) => response.json());
    const waitForArrangement = async (check) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const view = await readArrangement();
        if (check(view)) return view;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('编辑未持久化');
    };
    const clip = page.locator('[data-clip-id="clip-1"]');
    await clip.click();
    await clip.dblclick();
    assert.equal(await page.getByRole('button', { name: '完成修剪', exact: true }).count(), 0, '双击不再打开独立修剪面板');
    await clip.click({ button: 'right' });
    assert.equal(await page.getByRole('menu', { name: '片段操作' }).count(), 1);
    assert.equal(await page.getByRole('menuitem', { name: /精细修剪/ }).count(), 0, '右键菜单不再提供精细修剪');
    assert.equal(await page.getByRole('menuitem', { name: '删除片段（保留空位）', exact: true }).count(), 1);
    await page.getByRole('menu', { name: '片段操作' }).locator('..').click({ position: { x: 2, y: 2 } });
    const selectTool = page.getByRole('button', { name: '选择工具', exact: true });
    const splitTool = page.getByRole('button', { name: '分割工具', exact: true });
    assert.equal(await page.getByRole('button', { name: '联动修剪', exact: true }).getAttribute('aria-pressed'), 'false', '联动修剪默认关闭');
    await selectTool.focus();
    await page.keyboard.press('c');
    assert.equal(await splitTool.getAttribute('aria-pressed'), 'true', 'C 切换分割工具');
    assert.equal((await readArrangement()).clips.length, 1, '快捷键只切换工具，不直接切开素材');
    await page.keyboard.press('v');
    assert.equal(await selectTool.getAttribute('aria-pressed'), 'true', 'V 切换选择工具');
    await page.keyboard.press('Control+c');
    assert.equal(await selectTool.getAttribute('aria-pressed'), 'true', '不抢占复制快捷键');
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    await page.keyboard.down('Space');
    await page.keyboard.down('Space'); // 按住重复事件不得切回暂停。
    await page.keyboard.up('Space');
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: '播放', exact: true }).waitFor();
    const editorInput = page.getByTestId(`batch-output-editor-${planId}`).locator('input[type="number"]').first();
    await editorInput.focus();
    await page.keyboard.press('c');
    await page.keyboard.press('Space');
    assert.equal(await selectTool.getAttribute('aria-pressed'), 'true', '输入框中 C 不切换工具');
    assert.equal(await page.getByRole('button', { name: '播放', exact: true }).count(), 1, '输入框中空格不播放');
    await splitTool.click();
    await editorInput.focus();
    await page.keyboard.press('v');
    assert.equal(await splitTool.getAttribute('aria-pressed'), 'true', '输入框中 V 不切换工具');
    await selectTool.click();
    console.log('batch keyboard checks: Space/C/V, input focus, modifiers and repeats passed');
    fs.mkdirSync(path.resolve('outputs/playwright'), { recursive: true });
    const buttonAppearance = async (button) => button.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(element);
      const luminance = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return { background: style.backgroundColor, color: style.color, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), outline: style.outlineStyle };
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
      await page.mouse.move(0, 0);
      const enabled = await buttonAppearance(selectTool);
      const inactive = await buttonAppearance(splitTool);
      await selectTool.hover();
      const enabledHover = await buttonAppearance(selectTool);
      await splitTool.hover();
      const inactiveHover = await buttonAppearance(splitTool);
      console.log(`toolbar ${theme}: ${JSON.stringify({ enabled, inactive, enabledHover, inactiveHover })}`);
      for (const [state, appearance] of Object.entries({ enabled, inactive, enabledHover, inactiveHover })) {
        assert.ok(appearance.contrast >= 4.5, `${theme}/${state} 小字号按钮文字对比度不足：${appearance.contrast}`);
      }
      await page.mouse.move(0, 0);
      await buttonAppearance(selectTool);
      await buttonAppearance(splitTool);
      await page.getByRole('toolbar', { name: '成片时间轴工具' }).screenshot({ path: path.resolve(`outputs/playwright/batch-toolbar-${theme}.png`) });
      await selectTool.focus();
      await page.keyboard.press('Tab');
      assert.equal(await splitTool.evaluate((element) => element.matches(':focus-visible')), true);
      assert.equal((await buttonAppearance(splitTool)).outline, 'solid', `${theme} 键盘焦点需要可见轮廓`);
      await page.getByRole('toolbar', { name: '成片时间轴工具' }).screenshot({ path: path.resolve(`outputs/playwright/batch-toolbar-${theme}-focus.png`) });
      const enabledColor = await selectTool.evaluate((element) => getComputedStyle(element).backgroundColor);
      const disabledColor = await splitTool.evaluate((element) => getComputedStyle(element).backgroundColor);
      assert.notEqual(enabledColor, disabledColor, `${theme} 模式工具开关必须有不同底色`);
      assert.notEqual(enabledColor, 'rgba(0, 0, 0, 0)', '选中工具不能被桌面壳重置为透明');
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    fs.mkdirSync(path.resolve('outputs/playwright'), { recursive: true });
    await page.getByRole('toolbar', { name: '成片时间轴工具' }).screenshot({ path: path.resolve('outputs/playwright/batch-toolbar-shortcuts.png') });
    const speed = page.getByRole('slider', { name: '视频倍速拉条', exact: true });
    await speed.fill('1.5');
    await speed.press('Tab');
    await waitForArrangement((view) => view.clips[0].playbackRate === 1.5);
    await page.getByRole('button', { name: '恢复原速（1×）', exact: true }).click();
    await waitForArrangement((view) => view.clips[0].playbackRate === 1 && view.clips[0].timelineEndUs === 15_000_000);
    await speed.fill('2');
    await speed.dispatchEvent('pointerup');
    let view = await waitForArrangement((view) => view.clips[0].playbackRate === 2);
    assert.equal(view.clips[0].timelineEndUs, 7_500_000);
    const assertVideoPanels = async () => {
      assert.equal(await page.getByRole('slider', { name: '视频倍速拉条', exact: true }).count(), 1, '选中素材后倍速面板只能有一个');
      assert.equal(await page.getByRole('slider', { name: '画面缩放', exact: true }).count(), 1, '画面面板只能有一个');
    };
    const dragClip = async (locator, deltaX) => {
        await page.waitForFunction(() => document.querySelector('input[aria-label="视频倍速拉条"]')?.disabled === false);
      const box = await locator.boundingBox(); assert.ok(box);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + deltaX, y, { steps: 12 }); await page.mouse.up();
    };
    await dragClip(clip, 90);
    view = await waitForArrangement((view) => view.clips[0].timelineStartUs === 1_500_000);
    assert.equal(view.clips[0].sourceStartUs, 0);
    assert.equal(view.clips[0].sourceEndUs, 15_000_000, '移动不能改源截取范围');
    await dragClip(clip, -90);
    await waitForArrangement((view) => view.clips[0].timelineStartUs === 0);
    await assertVideoPanels();
    const scale = page.getByRole('slider', { name: '画面缩放', exact: true });
    await scale.fill('0.5'); await scale.press('ArrowRight');
    await waitForArrangement((view) => view.clips[0].framing.scale < 1);
    const horizontal = page.getByRole('slider', { name: '水平位移', exact: true });
    await horizontal.fill('0.5'); await horizontal.press('ArrowRight');
    await waitForArrangement((view) => view.clips[0].framing.offsetX > 0);
    fs.mkdirSync(path.resolve('outputs/playwright'), { recursive: true });
    await page.screenshot({ path: path.resolve('outputs/playwright/batch-video-speed-sidebar.png') });
    await page.getByRole('button', { name: '分割工具', exact: true }).click();
    await page.locator('[data-track="narration"] [data-audio-clip-id]').first().click({ position: { x: 100, y: 10 } });
    await waitForArrangement((view) => view.audio?.narration?.length === 2);
    await page.locator('[data-track="narration"] [data-audio-clip-id]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除音频片段', exact: true }).click();
    view = await waitForArrangement((view) => view.audio?.narration?.length === 1);
    assert.ok(view.audio.narration[0].startUs > 0);
    await clip.click({ position: { x: 120, y: 20 } });
    view = await waitForArrangement((view) => view.clips.length === 2);
    const laterStart = view.clips[1].timelineStartUs;
    await page.getByRole('button', { name: '选择工具', exact: true }).click();
    const secondId = view.clips[1].clipId;
    const second = page.locator(`[data-clip-id="${secondId}"]`);
    for (let i = 0; i < 4; i++) {
      await second.click(); await assertVideoPanels();
      await clip.click(); await assertVideoPanels();
    }
    await dragClip(clip, 240);
    view = await waitForArrangement((view) => view.clips[0].clipId === secondId);
    await assertVideoPanels();
    await dragClip(clip, -330);
    view = await waitForArrangement((view) => view.clips[0].clipId === 'clip-1');
    assert.equal(view.clips[1].timelineStartUs, laterStart);

    // 两段相邻画面：左右手柄联动修剪、贴边磁吸、禁止重叠与精确保存。
    const dragHandle = async (edge, dx, checkSnap = false) => {
      await page.waitForFunction(() => document.querySelector('input[aria-label="视频倍速拉条"]')?.disabled === false);
      const handle = clip.locator(`[aria-label="修剪片段${edge === 'start' ? '开头' : '结尾'}"]`);
      const box = await handle.boundingBox(); assert.ok(box);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 12 });
      if (checkSnap) await page.getByTestId('batch-timeline-snap-guide').waitFor();
      await page.mouse.up();
    };
    assert.equal(await page.getByRole('button', { name: '磁吸', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '联动修剪', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: '联动修剪', exact: true }).click();
    await dragHandle('end', 60);
    view = await waitForArrangement((view) => view.clips[1].timelineStartUs === laterStart + 1_000_000);
    assert.equal(view.clips[0].timelineEndUs, view.clips[1].timelineStartUs);
    assert.equal(view.preserveGaps, false);
    await dragHandle('end', -60);
    await waitForArrangement((view) => view.clips[1].timelineStartUs === laterStart);
    await dragHandle('start', 30);
    view = await waitForArrangement((view) => view.clips[1].timelineStartUs === laterStart - 500_000);
    assert.equal(view.clips[0].timelineStartUs, 0);
    assert.equal(view.clips[0].timelineEndUs, view.clips[1].timelineStartUs);
    await dragHandle('start', -30);
    await waitForArrangement((view) => view.clips[1].timelineStartUs === laterStart);

    await page.getByRole('button', { name: '联动修剪', exact: true }).click();
    await dragHandle('end', -30);
    view = await waitForArrangement((view) => view.clips[0].timelineEndUs === laterStart - 500_000);
    assert.equal(view.clips[1].timelineStartUs, laterStart);
    await dragHandle('end', 28, true); // 距离接点约 2px，应精确吸附。
    await waitForArrangement((view) => view.clips[0].timelineEndUs === laterStart);
    const beforeOvershoot = await readArrangement();
    await dragHandle('end', 90);
    assert.equal((await readArrangement()).editRevision, beforeOvershoot.editRevision, '顶到邻片边界不应提交非法修剪');
    await page.getByRole('button', { name: '联动修剪', exact: true }).click();
    assert.equal(await page.getByText('修剪超出当前空位，不能覆盖相邻片段', { exact: true }).count(), 0);
    console.log('batch trim browser checks: both handles, ripple, snap guide and overlap clamp passed');

    await clip.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: '删除片段（保留空位）', exact: true }).click();
    view = await waitForArrangement((view) => view.clips.length === 1);
    assert.equal(view.clips[0].timelineStartUs, laterStart);
    await page.getByRole('button', { name: '关闭成片编辑器' }).click();
    await page.getByRole('button', { name: /^编辑成片 1 / }).click();
    await page.locator('[data-track="narration"] [data-audio-clip-id]').first().waitFor();
    assert.equal(await page.locator('[data-track="narration"] [data-audio-clip-id]').count(), 1);
    fs.mkdirSync(path.resolve('outputs/playwright'), { recursive: true });
    await page.screenshot({ path: path.resolve('outputs/playwright/batch-media-edit.png') });
    console.log('batch media editing browser checks passed');
  } else {
  const playButton = page.getByRole('button', { name: '播放', exact: true });
  await playButton.waitFor();
  await playButton.click();

  // 等播放头推进到正文（片头 INTRO_SEC ≈ 0.833s，留 0.7s 余量）。
  await page.waitForFunction((introSec) => {
    const input = document.querySelector('input[aria-label="播放位置"]');
    return input !== null && Number(input.value) > introSec + 0.7;
  }, INTRO_SEC, { timeout: 8_000 });
  const playheadBeforeSwitch = await page.evaluate(() => Number(document.querySelector('input[aria-label="播放位置"]').value));
  assert.ok(playheadBeforeSwitch > INTRO_SEC, '切换曲目前播放头必须已进入正文');

  const bgmSelect = page.getByLabel('成片背景音乐曲目');
  const readBgmState = async () => {
    const state = await page.evaluate(() => {
      const element = document.querySelector('audio[loop]');
      if (!element) return null;
      return {
        src: element.currentSrc || element.getAttribute('src') || '',
        paused: element.paused,
        currentTime: element.currentTime,
      };
    });
    assert.ok(state, 'BGM <audio> 元素必须存在');
    return state;
  };
  const readPlayhead = () => page.evaluate(() => Number(document.querySelector('input[aria-label="播放位置"]').value));

  // 场景 1（F3 红灯核心）：播放中从「关闭 BGM」选曲 A——新源必须定位正文偏移并续播。
  await bgmSelect.selectOption('bgm-switch-track-a');
  await waitForBgmState(page, { trackId: 'bgm-switch-track-a', playing: true, minCurrentTime: 0.2 });
  const stateAfterFirstSwitch = await readBgmState();
  const playheadAfterFirstSwitch = await readPlayhead();
  assert.ok(
    Math.abs(stateAfterFirstSwitch.currentTime - (playheadAfterFirstSwitch - INTRO_SEC)) < 1.5,
    `新 BGM 应跟随加载完成时的正文偏移 ${playheadAfterFirstSwitch - INTRO_SEC}s 续播，实际 ${stateAfterFirstSwitch.currentTime}s`,
  );
  assert.ok(await readPlayhead() > INTRO_SEC, '切换 BGM 不得重置画面播放头');

  // 场景 2：播放中曲目 A → B 换源续播，位置跟随当前正文播放头（F4：读 ref 而非陈旧闭包）。
  await bgmSelect.selectOption('bgm-switch-track-b');
  await waitForBgmState(page, { trackId: 'bgm-switch-track-b', playing: true, minCurrentTime: 0.5 });
  const playheadAtSecondSwitch = await readPlayhead();
  const stateAfterSecondSwitch = await readBgmState();
  assert.ok(
    Math.abs(stateAfterSecondSwitch.currentTime - (playheadAtSecondSwitch - INTRO_SEC)) < 1.5,
    `换曲后 BGM 位置应贴合正文播放头 ${playheadAtSecondSwitch - INTRO_SEC}s，实际 ${stateAfterSecondSwitch.currentTime}s`,
  );
  assert.ok(await readPlayhead() > INTRO_SEC, '再次换曲不得重置画面播放头');

  // 场景 3：播放中切回「关闭 BGM」——当前曲目暂停。
  await bgmSelect.selectOption('');
  await waitForBgmState(page, { trackId: null, playing: false, minCurrentTime: 0 });
  assert.ok(await readPlayhead() > INTRO_SEC, '关闭 BGM 不得重置画面播放头');

  // 场景 4（F3 原始复现）：关闭 → 播放中再选曲，必须重新续播而不是静默。
  await bgmSelect.selectOption('bgm-switch-track-a');
  await waitForBgmState(page, { trackId: 'bgm-switch-track-a', playing: true, minCurrentTime: 0.2 });
  const playheadAfterResume = await readPlayhead();
  assert.ok(playheadAfterResume > INTRO_SEC, '再次选曲不得重置画面播放头');

  }
  assert.equal(pageErrors.length, 0, `页面不得有未捕获异常：${pageErrors.join('\n')}`);
  console.log('batch BGM source switch Playwright tests passed');
} catch (error) {
  process.stderr.write(serverOutput.join(''));
  if (page) {
    process.stderr.write(`\n浏览器地址: ${page.url()}\n`);
    process.stderr.write(`浏览器正文: ${(await page.locator('body').innerText().catch(() => '无法读取')).slice(0, 4000)}\n`);
    process.stderr.write(`页面异常: ${pageErrors.join('\n')}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  directEditDb?.close();
  try {
    await fetch(`${baseUrl}/api/shutdown`, { method: 'POST' });
  } catch {
    // 服务可能已经退出。
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
