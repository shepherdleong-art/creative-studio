/**
 * C3 BGM 换源续播 · 真实浏览器播放验证（复核 F2/F3 的运行时证据）。
 *
 * 运行方式（与 batch-preparation-workspace.playwright.test.mjs 相同）：
 *   npm run build && node scripts/batch-bgm-source-switch.playwright.test.mjs
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`生产服务提前退出，exit=${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/batch-production/readiness`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('生产服务未在 6 秒内就绪');
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-switch-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];
// lib 函数（createAsset/addAssetToPool 等）按 dataRoot() 解析 storage 路径，
// 测试进程与 server 必须共享同一数据根。
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const server = spawn(process.execPath, [standaloneServer], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CREATIVE_STUDIO_DATA_ROOT: dataRoot,
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'production',
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
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${baseUrl}/projects/${projectId}?tab=final-edit`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '批量生产', exact: true }).click();
  await page.getByRole('heading', { name: '素材区' }).waitFor();
  // 直达「检查成片」：fixture 已是冻结批次 + 当前成片版本。
  await page.getByRole('button', { name: /检查成片/ }).click();
  await page.getByTestId('batch-output-card').first().waitFor();
  await page.getByRole('button', { name: '预览成片 1' }).click();
  await page.getByRole('button', { name: '调整片段' }).waitFor();
  await page.getByRole('button', { name: '调整片段' }).click();

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
  assert.ok(
    Math.abs(stateAfterFirstSwitch.currentTime - (playheadBeforeSwitch - INTRO_SEC)) < 1.5,
    `新 BGM 应从正文偏移 ${playheadBeforeSwitch - INTRO_SEC}s 附近续播，实际 ${stateAfterFirstSwitch.currentTime}s`,
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
  try {
    await fetch(`${baseUrl}/api/shutdown`, { method: 'POST' });
  } catch {
    // 服务可能已经退出。
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
