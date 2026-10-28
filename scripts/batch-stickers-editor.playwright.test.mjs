// 运行：node scripts/batch-stickers-editor.playwright.test.mjs
// 真实 Next dev + 临时数据根 + 内置 Chrome；核心编辑、跨片复制与整体历史均不走 mock。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
import { createAnalysisVersion, createAsset, setAssetCurrentAnalysis } from '../lib/batch-production/assets.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } from '../lib/batch-production/versions.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { resolveCoverContractHash } from '../lib/batch-production/cover-contract.ts';
import { buildCoverRenderTaskRequestKey } from '../lib/batch-production/render-task-key.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { planPackagingStickerAutoLayout } from '../lib/media-core/packaging-sticker-planner.ts';

const projectId = 'batch-sticker-e2e-project';
const batchName = '批量贴纸真实浏览器验收';
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-stickers-e2e-'));
const dbPath = path.join(dataRoot, 'data', 'workbench.db');
const testEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot, NEXT_TELEMETRY_DISABLED: '1' };
const chrome = path.resolve('packaging/runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
const now = () => new Date().toISOString();
const apiResponses = [];
const pageErrors = [];
const consoleErrors = [];
const coreWrites = [];
let browser;
let page;
let server;
let passed = false;

async function getFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-40_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-40_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev 启动失败：${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/batch-production/readiness`, { redirect: 'manual' });
      if (response.status < 500) return { child, baseUrl, output: () => output };
    } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Next dev 启动超时：${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function eventually(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  assert.fail(message);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function manualSticker(id, overrides = {}) {
  return {
    id,
    assetId: 'highlight',
    styleMode: 'follow-template',
    fixedStyle: null,
    startFrame: 40,
    endFrame: 160,
    centerXPct: 47,
    centerYPct: 53,
    visualWidthPct: 37,
    rotationDeg: 12,
    trackIndex: 0,
    animation: 'slide',
    origin: { kind: 'manual' },
    ...overrides,
  };
}

function packaging(spec, stickers) {
  return {
    enabled: true,
    template: spec.template,
    varsOverrides: {
      title: `${spec.key}-标题`, subtitle: `${spec.key}-副标题`, point1: `${spec.key}-卖点一`,
      point2: `${spec.key}-卖点二`, point3: '', accent1: '', accent2: '', accent3: '',
    },
    pointCues: [],
    pointCuesMode: 'none',
    stickers,
    stickerDefaults: { animation: spec.defaultAnimation },
  };
}

async function seedFixture() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const storageRoot = path.join(dataRoot, 'storage');
  const mediaRelative = path.join('storage', 'batch-media', projectId, 'source.mp4');
  const mediaAbsolute = path.join(dataRoot, mediaRelative);
  fs.mkdirSync(path.dirname(mediaAbsolute), { recursive: true });
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x182838:s=96x96:r=24:d=12',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', mediaAbsolute,
  ], { timeoutMs: 60_000 });
  const videoFingerprint = `sha256:${createHash('sha256').update(fs.readFileSync(mediaAbsolute)).digest('hex')}`;

  const specs = [
    { key: 'source', title: '来源十二秒', bodySec: 12, template: 'overlay-poster', defaultAnimation: 'slide', reviewed: false },
    { key: 'target-existing', title: '目标六秒已审', bodySec: 6, template: 'overlay-journal', defaultAnimation: 'soft', reviewed: true },
    { key: 'target-empty', title: '目标九秒空白', bodySec: 9, template: 'overlay-minimal', defaultAnimation: 'zoom', reviewed: false },
    { key: 'target-short', title: '目标一秒无效', bodySec: 1, template: 'overlay-variety', defaultAnimation: 'rise', reviewed: false },
  ];
  const narrations = new Map();
  for (const spec of specs) {
    const relativePath = `batch-stickers-e2e/narration-${spec.bodySec}.wav`;
    const absolutePath = path.join(storageRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    await runFfmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=${300 + spec.bodySec * 20}:duration=${spec.bodySec}`,
      '-t', String(spec.bodySec), '-ar', 48000, '-ac', 1, '-c:a', 'pcm_s16le', '-y', absolutePath,
    ], { timeoutMs: 60_000 });
    narrations.set(spec.bodySec, {
      relativePath,
      fingerprint: `sha256:${createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')}`,
    });
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    db.prepare(`INSERT INTO providers (id, name, baseUrl, model, type)
      VALUES ('batch-sticker-e2e-provider', 'Batch Sticker E2E', 'http://127.0.0.1:1', 'smoke', 'openai-compatible')`).run();
    db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, workflowType, productCode)
      VALUES (?, '批量贴纸浏览器验收', 'batch-sticker-e2e-provider', 'smoke', 'smoke', 'complex_product', 'STICKERE2E')`).run(projectId);
    const assetId = createAsset(db, {
      projectId,
      sourceKind: 'managed',
      locationJson: { kind: 'managed', relativePath: mediaRelative },
      contentFingerprint: videoFingerprint,
      mediaKind: 'video',
      mediaJson: { displayName: '批量贴纸验收视频', durationSec: 12, durationUs: 12_000_000, width: 96, height: 96 },
    });
    db.prepare(`INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
      VALUES (?, ?, 'managed', ?, 'healthy', ?)`).run(randomUUID(), assetId, JSON.stringify({ kind: 'managed', relativePath: mediaRelative }), now());
    const analysisId = createAnalysisVersion(db, {
      assetId,
      analyzerVersion: 'batch-sticker-e2e-v1',
      providerId: 'batch-sticker-e2e-provider',
      model: 'smoke',
      analysisJson: {
        usable: true, durationUs: 12_000_000,
        scenes: [{ startUs: 0, endUs: 12_000_000, qualityScore: 1, labels: ['产品'] }],
        coverFrameTimesUs: [0],
      },
    });
    setAssetCurrentAnalysis(db, projectId, assetId, analysisId);

    const batchId = createBatchProduction(db, projectId, batchName);
    const batchVersionId = createBatchProductionVersion(db, batchId, {
      copyCount: 1,
      defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: 12 },
    });
    addAssetToPool(db, batchVersionId, { assetId, analysisId });
    const catalog = JSON.parse(fs.readFileSync(path.resolve('packaging/stickers/catalog.json'), 'utf8'));
    const sourceAutomatic = planPackagingStickerAutoLayout({
      bodyFrames: 12 * 24,
      template: 'overlay-poster',
      assets: catalog.assets,
      animation: 'slide',
      autoGroupId: 'source-auto-initial',
      random: seededRandom(35),
      createId: (slotIndex) => `source-auto-${slotIndex}`,
    });
    assert.ok(sourceAutomatic);
    assert.equal(sourceAutomatic.length, 6);
    assert.ok(sourceAutomatic.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoEdited === false));

    const created = { projectId, batchId, batchVersionId, assetId, specs };
    for (const [index, spec] of specs.entries()) {
      const scriptId = createProjectScript(db, projectId, {
        sourceKind: 'script_draft', sourceId: `batch-sticker-e2e-${spec.key}`, title: spec.title,
        bodyText: `${spec.title}的真实口播正文。`, sourceVersion: '1',
        metadata: {
          targetDurationSec: spec.bodySec,
          coverTitleJson: { primary: spec.title, secondary: '贴纸验收' },
          contentRevision: `revision-${spec.key}`,
        },
      });
      const snapshotId = snapshotScriptIntoBatch(db, batchVersionId, { scriptId, copyCount: 1 });
      const [planId] = createOutputPlansForSnapshot(db, batchVersionId, snapshotId);
      const stickers = spec.key === 'source'
        ? [manualSticker('source-manual'), ...sourceAutomatic]
        : spec.key === 'target-existing'
          ? [manualSticker('target-old-sticker', { assetId: 'recommend', startFrame: 20, endFrame: 60, animation: 'none' })]
          : [];
      const durationUs = spec.bodySec * 1_000_000;
      const narration = narrations.get(spec.bodySec);
      const arrangement = {
        schemaVersion: 'batch-allocation-v1', preset: '3:4', fps: 24, targetDurationUs: durationUs,
        editRevision: index + 1,
        productionReady: true,
        packaging: packaging(spec, stickers),
        clips: [{
          clipId: `${spec.key}:clip`, segmentId: `${spec.key}:segment`, sourceSegmentId: `${spec.key}:segment`,
          assetId, contentFingerprint: videoFingerprint, sourceStartUs: 0, sourceEndUs: durationUs,
          timelineStartUs: 0, timelineEndUs: durationUs, locked: false,
        }],
        cover: { assetId, timeUs: 0 },
        narration: {
          schemaVersion: 'batch-narration-v1', mode: 'local_ready', productionReady: true,
          audioRelativePath: narration.relativePath, audioFingerprint: narration.fingerprint,
          durationUs, gainDb: 0, segments: [],
        },
        subtitle: { cues: [] }, preserveGaps: true,
        music: { trackId: null, gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 },
        warnings: [], blockers: [],
        ...(spec.reviewed ? { review: { decision: 'approved', decidedAt: now() } } : {}),
      };
      const outputVersionId = createOutputVersion(db, planId, { arrangementJson: arrangement });
      Object.assign(spec, { planId, outputVersionId, snapshotId });
    }
    updateBatchProductionStatus(db, projectId, batchId, 'running');

    for (const spec of specs.slice(0, 3)) {
      const coverRelativePath = `batch-stickers-e2e/${spec.key}-cover.jpg`;
      const coverAbsolutePath = path.join(storageRoot, coverRelativePath);
      fs.mkdirSync(path.dirname(coverAbsolutePath), { recursive: true });
      await sharp({ create: { width: 120, height: 160, channels: 3, background: spec.key === 'source' ? '#245577' : '#786040' } })
        .jpeg().toFile(coverAbsolutePath);
      const taskId = randomUUID();
      const attemptId = randomUUID();
      const timestamp = now();
      const requestKey = buildCoverRenderTaskRequestKey(spec.outputVersionId, resolveCoverContractHash(db, spec.outputVersionId));
      db.prepare(`INSERT INTO batch_tasks
        (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
        VALUES (?, ?, ?, 'render', 'output_version_cover', ?, 'succeeded', ?, 'running', '{}', 1, ?, ?)`)
        .run(taskId, projectId, batchId, spec.outputVersionId, requestKey, timestamp, timestamp);
      db.prepare(`INSERT INTO batch_task_attempts
        (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
        VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)`)
        .run(attemptId, taskId, JSON.stringify({
          projectId, batchId, batchVersionId, planId: spec.planId, outputVersionId: spec.outputVersionId, coverRelativePath,
        }), timestamp, timestamp, timestamp);
    }
    return created;
  } finally {
    db.close();
  }
}

function rawPlans(fixture) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result = {};
    for (const spec of fixture.specs) {
      const row = db.prepare('SELECT arrangementJson FROM batch_output_versions WHERE id = ?').get(spec.outputVersionId);
      assert.ok(row, `${spec.key} 缺少当前输出版本`);
      result[spec.key] = { raw: row.arrangementJson, arrangement: JSON.parse(row.arrangementJson) };
    }
    return result;
  } finally {
    db.close();
  }
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function assertOnlyStickerFieldsChanged(before, after) {
  const arrangementKeys = ['packaging', 'editRevision', 'review'];
  assert.deepEqual(withoutKeys(after, arrangementKeys), withoutKeys(before, arrangementKeys), 'arrangement 非贴纸字段必须保留');
  assert.deepEqual(withoutKeys(after.packaging, ['stickers', 'stickerDefaults']), withoutKeys(before.packaging, ['stickers', 'stickerDefaults']), '目标模板、varsOverrides 与其他包装字段必须保留');
  assert.equal(after.editRevision, before.editRevision + 1);
  assert.equal(after.review, undefined);
}

function bodyFrames(arrangement) {
  const visual = arrangement.clips.at(-1)?.timelineEndUs ?? 0;
  return Math.floor(Math.max(visual, arrangement.narration?.durationUs ?? 0) / 1e6 * 24 + 1e-6);
}

function expectedManualFrames(sticker, sourceFrames, targetFrames) {
  return {
    startFrame: 20 + Math.round((sticker.startFrame - 20) * targetFrames / sourceFrames),
    endFrame: 20 + Math.round((sticker.endFrame - 20) * targetFrames / sourceFrames),
  };
}

try {
  assert.ok(fs.existsSync(chrome), `内置 Chrome 不存在：${chrome}`);
  server = await startServer();
  const fixture = await seedFixture();
  const [source, targetExisting, targetEmpty, targetShort] = fixture.specs;
  const clipsPath = (spec) => `/api/batch-production/batches/${fixture.batchId}/outputs/${spec.planId}/clips`;
  const stickerCopyPath = `/api/batch-production/batches/${fixture.batchId}/outputs/sticker-copy`;
  const arrangementPath = (spec) => `/api/batch-production/batches/${fixture.batchId}/outputs/${spec.planId}/arrangement`;

  browser = await chromium.launch({ headless: true, executablePath: chrome });
  page = await browser.newPage({ viewport: { width: 1720, height: 1200 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) apiResponses.push({ method: response.request().method(), path: `${url.pathname}${url.search}`, status: response.status() });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  const fetchArrangement = async (spec) => {
    const response = await page.evaluate(async ({ path, project }) => {
      const result = await fetch(`${path}?projectId=${encodeURIComponent(project)}`, { cache: 'no-store' });
      return { status: result.status, body: await result.json() };
    }, { path: arrangementPath(spec), project: projectId });
    assert.equal(response.status, 200, `${spec.key} arrangement 读取失败`);
    return response.body;
  };
  const savePackaging = async (spec, action) => {
    const pending = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== clipsPath(spec)) return false;
      return (response.request().postData() || '').includes('"type":"set_packaging"');
    });
    await action();
    const response = await pending;
    const request = JSON.parse(response.request().postData() || '{}');
    const body = await response.json();
    coreWrites.push({ kind: 'set_packaging', plan: spec.key, status: response.status(), request, response: body });
    assert.equal(response.status(), 200, `${spec.key} 包装保存失败：${JSON.stringify(body)}`);
    assert.equal(request.expectedOutputVersionId, spec.outputVersionId);
    const view = await fetchArrangement(spec);
    assert.equal(view.editRevision, body.editRevision);
    return { request, body, view };
  };
  const stickerCopyRequest = async (type, action) => {
    const pending = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== stickerCopyPath) return false;
      return (response.request().postData() || '').includes(`"type":"${type}"`);
    });
    await action();
    const response = await pending;
    const request = JSON.parse(response.request().postData() || '{}');
    const body = await response.json();
    coreWrites.push({ kind: `sticker-${type}`, status: response.status(), request, response: body });
    assert.equal(response.status(), 200, `sticker-copy ${type} 失败：${JSON.stringify(body)}`);
    assert.equal(body.targets.length, 2);
    return { request, body };
  };
  const enterReview = async () => {
    const batchTab = page.getByRole('tab', { name: '批量生产', exact: true });
    await batchTab.waitFor();
    await batchTab.click();
    const reviewStep = page.getByRole('button', { name: /检查成片/ });
    await reviewStep.waitFor();
    await reviewStep.click();
    await page.getByRole('heading', { name: '批量剪辑 · 统一审片' }).waitFor();
    await page.locator(`[data-sticker-clip-id="source-manual"]`).waitFor();
    await page.getByRole('checkbox', { name: '选择成片 2' }).waitFor();
  };
  const openFilmStickers = async (spec) => {
    const seq = fixture.specs.indexOf(spec) + 1;
    await page.getByText(`${String(seq).padStart(2, '0')} · ${spec.title}`, { exact: true }).click();
    await page.getByRole('heading', { name: `成片 ${String(seq).padStart(2, '0')} · ${spec.title}` }).waitFor();
    await page.getByRole('button', { name: '包装', exact: true }).click();
    const stickerTab = page.getByRole('tab', { name: '贴纸', exact: true });
    await stickerTab.waitFor();
    if (await stickerTab.getAttribute('aria-selected') !== 'true') await stickerTab.click();
    const panel = page.locator('#batch-packaging-stickers-panel');
    await panel.getByRole('button', { name: /^添加贴纸 / }).first().waitFor();
    return panel;
  };

  await page.goto(`${server.baseUrl}/projects/${projectId}?tab=final-edit`, { waitUntil: 'domcontentloaded' });
  await enterReview();
  await page.locator(`[data-sticker-clip-id="target-old-sticker"]`).waitFor();
  let panel = await openFilmStickers(source);
  assert.equal(await page.getByRole('tab', { name: '包装设置', exact: true }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: '贴纸', exact: true }).getAttribute('aria-selected'), 'true');
  const assetButtons = panel.getByRole('button', { name: /^添加贴纸 / });
  assert.equal(await assetButtons.count(), 28, '来源 comic 模板必须展示 28 张当前风格素材');
  await panel.getByLabel('搜索贴纸名称').fill('好物来了');
  assert.equal(await assetButtons.count(), 1, '素材库中文搜索必须生效');
  await panel.getByLabel('搜索贴纸名称').fill('');
  assert.equal(await assetButtons.count(), 28);

  const beforeAdd = await fetchArrangement(source);
  const addedResult = await savePackaging(source, () => panel.getByRole('button', { name: '添加贴纸 推荐', exact: true }).click());
  assert.equal(addedResult.view.packaging.stickers.length, 8);
  const added = addedResult.view.packaging.stickers.find((sticker) => !beforeAdd.packaging.stickers.some((item) => item.id === sticker.id));
  assert.ok(added, '点击素材库后必须真实新增贴纸');
  const overlay = page.frameLocator('iframe[title="包装版式编辑"]');
  try {
    await overlay.locator(`[data-sticker-id="${added.id}"]`).waitFor({ timeout: 45_000 });
  } catch (error) {
    const frameStates = await Promise.all(page.frames().map(async (frame) => ({
      url: frame.url(),
      stickers: await frame.locator('.packaging-sticker[data-sticker-id]').evaluateAll((elements) => elements.map((element) => ({
        id: element.getAttribute('data-sticker-id'), opacity: getComputedStyle(element).opacity, display: getComputedStyle(element).display,
      }))).catch(() => []),
    })));
    console.error(`新增贴纸 overlay 诊断：${JSON.stringify({ added, frameStates })}`);
    throw error;
  }
  await overlay.locator('[data-sticker-edit-ui]').waitFor();
  const addedBlock = page.locator(`[data-sticker-clip-id="${added.id}"]`);
  await addedBlock.scrollIntoViewIfNeeded();
  await eventually(async () => (await addedBlock.innerText()).includes('推荐'), '时间轴块必须显示中文贴纸名');
  await eventually(async () => await addedBlock.getAttribute('data-selected') === 'true', '添加后时间轴选中必须同步');
  await panel.getByText(/动效 · 当前贴纸（推荐）/).waitFor();
  await overlay.locator('#root').click({ position: { x: 6, y: 6 }, force: true });
  await panel.getByText('动效 · 新贴纸默认', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-sticker-clip-id][data-selected="true"]').count(), 0, '点击预览空白必须取消选中');
  await addedBlock.click({ position: { x: 24, y: 10 } });
  await eventually(async () => await addedBlock.getAttribute('data-selected') === 'true');
  const deletedByKeyboardResult = await savePackaging(source, () => page.keyboard.press('Delete'));
  assert.equal(deletedByKeyboardResult.view.packaging.stickers.length, 7, '从预览空白回到时间轴选中后，Delete 必须真实删除贴纸');
  assert.ok(!deletedByKeyboardResult.view.packaging.stickers.some((sticker) => sticker.id === added.id));

  const previewDeleteAddResult = await savePackaging(source, () => panel.getByRole('button', { name: '添加贴纸 推荐', exact: true }).click());
  assert.equal(previewDeleteAddResult.view.packaging.stickers.length, 8);
  const previewDeleteAdded = previewDeleteAddResult.view.packaging.stickers.find((sticker) => !deletedByKeyboardResult.view.packaging.stickers.some((item) => item.id === sticker.id));
  assert.ok(previewDeleteAdded);
  await overlay.locator(`[data-sticker-id="${previewDeleteAdded.id}"]`).waitFor({ timeout: 45_000 });
  await overlay.locator('[data-sticker-delete]').waitFor();
  const deletedResult = await savePackaging(source, () => overlay.locator('[data-sticker-delete]').click({ force: true }));
  assert.equal(deletedResult.view.packaging.stickers.length, 7, '预览调整框删除按钮必须真实删除当前贴纸');
  assert.ok(!deletedResult.view.packaging.stickers.some((sticker) => sticker.id === previewDeleteAdded.id));

  const targetsBeforeCurrentFilmChanges = rawPlans(fixture);
  const beforeReplace = deletedResult.view.packaging;
  const replacedResult = await savePackaging(source, () => panel.getByRole('button', { name: '换一组基础贴纸', exact: true }).click());
  const replacedAutomatic = replacedResult.view.packaging.stickers.filter((sticker) => sticker.origin.kind === 'auto');
  assert.equal(replacedAutomatic.length, 6);
  assert.equal(replacedResult.view.packaging.stickers.filter((sticker) => sticker.origin.kind === 'manual').length, 1);
  assert.notEqual(replacedAutomatic[0].origin.autoGroupId, beforeReplace.stickers.find((sticker) => sticker.origin.kind === 'auto').origin.autoGroupId);
  assert.ok(replacedAutomatic.every((sticker) => sticker.origin.autoEdited === false));
  assert.deepEqual(replacedResult.view.packaging.stickers.find((sticker) => sticker.id === 'source-manual'), beforeReplace.stickers.find((sticker) => sticker.id === 'source-manual'));
  const targetsAfterCurrentFilmChanges = rawPlans(fixture);
  for (const spec of [targetExisting, targetEmpty, targetShort]) {
    assert.equal(targetsAfterCurrentFilmChanges[spec.key].raw, targetsBeforeCurrentFilmChanges[spec.key].raw, `换一组只能修改当前来源片，不得串改 ${spec.key}`);
  }

  const snapButton = page.getByTitle('磁吸对齐 (N);按住 Alt 临时关闭');
  if (await snapButton.getAttribute('aria-pressed') === 'true') await snapButton.click();
  const manualBeforeMove = replacedResult.view.packaging.stickers.find((sticker) => sticker.id === 'source-manual');
  const manualBlock = page.locator('[data-sticker-clip-id="source-manual"]');
  await manualBlock.scrollIntoViewIfNeeded();
  const blockBox = await manualBlock.boundingBox();
  assert.ok(blockBox);
  const movedResult = await savePackaging(source, async () => {
    await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(blockBox.x + blockBox.width * 0.25 + 60, blockBox.y + blockBox.height / 2, { steps: 8 });
    await page.mouse.up();
  });
  const manualAfterMove = movedResult.view.packaging.stickers.find((sticker) => sticker.id === 'source-manual');
  assert.equal(manualAfterMove.startFrame, manualBeforeMove.startFrame + 24, '时间轴移动 60px 必须真实保存 24 整帧');
  assert.equal(manualAfterMove.endFrame, manualBeforeMove.endFrame + 24);

  panel = await openFilmStickers(targetExisting);
  await panel.getByText('动效 · 新贴纸默认', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-sticker-clip-id][data-selected="true"]').count(), 0, '切换成片不得串带来源贴纸选中');
  await page.getByText('已通过', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: '选择成片 2' }).check();
  await page.getByRole('checkbox', { name: '选择成片 3' }).check();
  panel = await openFilmStickers(source);
  await panel.getByRole('button', { name: '复制到其他成片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '复制贴纸到其他成片' });
  await dialog.waitFor();
  const targetCheckbox = (spec) => dialog.locator(`[data-plan-id="${spec.planId}"] input[type="checkbox"]`);
  assert.equal(await targetCheckbox(targetExisting).isChecked(), true, '弹窗必须默认勾选已选目标一');
  assert.equal(await targetCheckbox(targetEmpty).isChecked(), true, '弹窗必须默认勾选已选目标二');
  await dialog.getByText('已选 2 / 2 条可复制成片', { exact: true }).waitFor();
  assert.equal(await targetCheckbox(targetShort).isDisabled(), true, '短成片必须是不可复制的无效目标');
  await dialog.locator(`[data-plan-id="${targetShort.planId}"]`).getByText(/目标正文至少需要 144 帧/).waitFor();
  await dialog.locator(`[data-plan-id="${targetExisting.planId}"]`).getByText('1 张已有', { exact: true }).waitFor();
  await dialog.locator(`[data-plan-id="${targetExisting.planId}"]`).getByText(/已审核，复制后需重新审核/).waitFor();
  await dialog.getByText(/将替换 1 条目标成片的全部现有贴纸/).waitFor();
  await dialog.getByText(/1 条已审核目标在复制后需要重新审核/).waitFor();
  await dialog.getByRole('button', { name: '清空', exact: true }).click();
  assert.equal(await targetCheckbox(targetExisting).isChecked(), false);
  assert.equal(await targetCheckbox(targetEmpty).isChecked(), false);
  assert.equal(await dialog.getByRole('button', { name: '复制并生成变体', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: '全选有效', exact: true }).click();
  assert.equal(await targetCheckbox(targetExisting).isChecked(), true);
  assert.equal(await targetCheckbox(targetEmpty).isChecked(), true);
  assert.equal(await targetCheckbox(targetShort).isChecked(), false);

  const beforeCopy = rawPlans(fixture);
  const copiedResult = await stickerCopyRequest('copy', () => dialog.getByRole('button', { name: '复制并生成变体（2）', exact: true }).click());
  assert.equal(copiedResult.request.sourcePlanId, source.planId);
  assert.deepEqual(copiedResult.request.targets.map((target) => target.planId), [targetExisting.planId, targetEmpty.planId]);
  await dialog.waitFor({ state: 'detached' });
  const afterCopy = rawPlans(fixture);
  assert.equal(afterCopy.source.raw, beforeCopy.source.raw, '跨片复制不得改写来源');
  for (const spec of [targetExisting, targetEmpty]) assertOnlyStickerFieldsChanged(beforeCopy[spec.key].arrangement, afterCopy[spec.key].arrangement);
  assert.equal(afterCopy['target-existing'].arrangement.packaging.template, beforeCopy['target-existing'].arrangement.packaging.template);
  assert.equal(afterCopy['target-empty'].arrangement.packaging.template, beforeCopy['target-empty'].arrangement.packaging.template);
  assert.deepEqual(afterCopy['target-existing'].arrangement.packaging.varsOverrides, beforeCopy['target-existing'].arrangement.packaging.varsOverrides);
  assert.deepEqual(afterCopy['target-empty'].arrangement.packaging.varsOverrides, beforeCopy['target-empty'].arrangement.packaging.varsOverrides);
  assert.ok(!afterCopy['target-existing'].arrangement.packaging.stickers.some((sticker) => sticker.id === 'target-old-sticker'), '目标已有贴纸必须全部替换');

  const sourceAtCopy = beforeCopy.source.arrangement;
  const sourceManual = sourceAtCopy.packaging.stickers.find((sticker) => sticker.origin.kind === 'manual');
  const sourceFrames = bodyFrames(sourceAtCopy);
  for (const spec of [targetExisting, targetEmpty]) {
    const targetArrangement = afterCopy[spec.key].arrangement;
    const targetManuals = targetArrangement.packaging.stickers.filter((sticker) => sticker.origin.kind === 'manual');
    const targetAutomatic = targetArrangement.packaging.stickers.filter((sticker) => sticker.origin.kind === 'auto');
    assert.equal(targetManuals.length, 1);
    assert.equal(targetAutomatic.length, 6);
    assert.ok(targetAutomatic.every((sticker) => sticker.origin.autoEdited === false));
    assert.deepEqual(targetArrangement.packaging.stickerDefaults, sourceAtCopy.packaging.stickerDefaults);
    const expected = expectedManualFrames(sourceManual, sourceFrames, bodyFrames(targetArrangement));
    assert.equal(targetManuals[0].startFrame, expected.startFrame, `${spec.key} 手动贴纸起点必须按正文时长等比映射`);
    assert.equal(targetManuals[0].endFrame, expected.endFrame, `${spec.key} 手动贴纸结尾必须按正文时长等比映射`);
    assert.deepEqual(
      { ...targetManuals[0], id: sourceManual.id, startFrame: sourceManual.startFrame, endFrame: sourceManual.endFrame },
      sourceManual,
      `${spec.key} 手动贴纸除 ID 与时间外必须完整继承来源`,
    );
  }
  const automaticOne = afterCopy['target-existing'].arrangement.packaging.stickers.filter((sticker) => sticker.origin.kind === 'auto');
  const automaticTwo = afterCopy['target-empty'].arrangement.packaging.stickers.filter((sticker) => sticker.origin.kind === 'auto');
  assert.notEqual(automaticOne[0].origin.autoGroupId, automaticTwo[0].origin.autoGroupId);
  assert.ok(automaticOne.some((sticker, index) => (
    sticker.assetId !== automaticTwo[index].assetId
    || sticker.centerXPct !== automaticTwo[index].centerXPct
    || sticker.centerYPct !== automaticTwo[index].centerYPct
    || sticker.animation !== automaticTwo[index].animation
  )), '不同目标的未编辑自动贴纸必须按规则生成尽量不同的素材、位置或动效变体');

  await eventually(async () => await page.getByTitle('撤销 (⌘Z)').isEnabled(), '复制完成后整体撤销必须可用');
  const undoneResult = await stickerCopyRequest('restore', () => page.keyboard.press('Control+z'));
  assert.ok(undoneResult.request.targets.every((target) => target.snapshot && !target.snapshot.after), '整体撤销必须恢复 before 快照');
  const afterUndo = rawPlans(fixture);
  for (const spec of [targetExisting, targetEmpty]) {
    assertOnlyStickerFieldsChanged(afterCopy[spec.key].arrangement, afterUndo[spec.key].arrangement);
    assert.deepEqual(afterUndo[spec.key].arrangement.packaging.stickers, beforeCopy[spec.key].arrangement.packaging.stickers, `${spec.key} 一次整体撤销必须恢复复制前 stickers`);
    assert.deepEqual(afterUndo[spec.key].arrangement.packaging.stickerDefaults, beforeCopy[spec.key].arrangement.packaging.stickerDefaults, `${spec.key} 一次整体撤销必须恢复复制前 stickerDefaults`);
  }
  assert.equal(afterUndo.source.raw, beforeCopy.source.raw, '整体撤销不得改写来源');

  await eventually(async () => await page.getByTitle('重做 (⌘⇧Z)').isEnabled(), '整体撤销完成后重做必须可用');
  const redoneResult = await stickerCopyRequest('restore', () => page.keyboard.press('Control+Shift+z'));
  for (const target of redoneResult.request.targets) {
    const copiedTarget = copiedResult.body.targets.find((item) => item.planId === target.planId);
    assert.ok(copiedTarget);
    assert.deepEqual(target.snapshot, copiedTarget.after, '整体重做必须回放已持久化 after 变体，不得重新随机');
  }
  const afterRedo = rawPlans(fixture);
  for (const spec of [targetExisting, targetEmpty]) {
    assertOnlyStickerFieldsChanged(afterUndo[spec.key].arrangement, afterRedo[spec.key].arrangement);
    assert.deepEqual(afterRedo[spec.key].arrangement.packaging.stickers, afterCopy[spec.key].arrangement.packaging.stickers, `${spec.key} 整体重做必须恢复完全相同的贴纸变体`);
    assert.deepEqual(afterRedo[spec.key].arrangement.packaging.stickerDefaults, afterCopy[spec.key].arrangement.packaging.stickerDefaults);
  }
  assert.equal(afterRedo.source.raw, beforeCopy.source.raw, '整体重做不得改写来源');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await enterReview();
  const afterReload = rawPlans(fixture);
  for (const spec of fixture.specs) assert.equal(afterReload[spec.key].raw, afterRedo[spec.key].raw, `${spec.key} 刷新后数据库快照必须持久化`);
  for (const spec of [source, targetExisting, targetEmpty]) {
    panel = await openFilmStickers(spec);
    await panel.getByText('7 张已放置', { exact: true }).waitFor();
  }

  const coreApiFailures = apiResponses.filter((response) => response.status >= 400 && (
    response.path.startsWith('/api/batch-production/') || response.path.startsWith('/api/packaging/')
  ));
  assert.deepEqual(coreApiFailures, [], `批量/包装真实 API 不得出现失败响应：${JSON.stringify(coreApiFailures)}`);
  assert.deepEqual(pageErrors, [], `页面不得出现未捕获异常：${pageErrors.join('\n')}`);
  assert.ok(coreWrites.some((entry) => entry.kind === 'set_packaging' && entry.request.config?.stickers), '必须记录真实当前片包装保存');
  assert.equal(coreWrites.filter((entry) => entry.kind === 'sticker-copy').length, 1);
  assert.equal(coreWrites.filter((entry) => entry.kind === 'sticker-restore').length, 2);

  passed = true;
  console.log(`批量贴纸真实浏览器验收通过：${coreWrites.length} 次核心写入、${apiResponses.length} 条真实 API 响应、0 个页面异常。`);
  console.log('覆盖：当前片素材库/添加/overlay/中文时间轴/选中/空白取消/Delete与预览删除、换一组隔离、跨片选中隔离、时间轴移动、复制弹窗与双目标真实 API、字段与时间比例、自动变体、整体撤销/重做及刷新持久化。');
  console.log(`API 失败响应：${JSON.stringify(coreApiFailures)}；console error 记录：${JSON.stringify(consoleErrors)}`);
} catch (error) {
  if (server) console.error(server.output());
  console.error(`真实 API 响应记录：${JSON.stringify(apiResponses)}`);
  console.error(`核心写入记录：${JSON.stringify(coreWrites)}`);
  console.error(`页面异常：${JSON.stringify(pageErrors)}`);
  console.error(`console error：${JSON.stringify(consoleErrors)}`);
  if (page) console.error(`浏览器正文：${(await page.locator('body').innerText().catch(() => '无法读取')).slice(0, 6000)}`);
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server.child);
  if (passed) {
    try { fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { console.warn(`Windows 文件锁未释放，临时测试目录保留：${dataRoot}`); }
  } else console.error(`临时测试数据保留供排查：${dataRoot}`);
}
