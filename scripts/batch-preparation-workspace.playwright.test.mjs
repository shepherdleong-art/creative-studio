import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import sharp from 'sharp';
import { createAnalysisVersion, createAsset, setAssetCurrentAnalysis } from '../lib/batch-production/assets.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const standaloneServer = path.join(process.cwd(), '.next', 'standalone', 'server.js');
assert.ok(fs.existsSync(standaloneServer), '请先运行 npm run build，再执行批量准备区浏览器验收');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-ui-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];
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

let browser;
let page;
const browserMessages = [];
try {
  await waitForServer(baseUrl, server);

  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.prepare(`
    INSERT INTO providers (id, name, baseUrl, model, type)
    VALUES ('batch-ui-provider', 'Browser Smoke', 'http://127.0.0.1', 'smoke', 'openai-compatible')
  `).run();
  db.prepare(`
    INSERT INTO projects (id, name, providerId, model, prompt, workflowType, productCode)
    VALUES ('batch-ui-project', '批量准备区验收项目', 'batch-ui-provider', 'smoke', 'smoke', 'complex_product', 'BATCHUI')
  `).run();
  // 配音供应商(用于开启开始按钮;baseUrl 指向本地拒绝端口,口播任务快速失败,不影响本测试断言)。
  // 注意:服务启动时 getDb 已把内置 vapi-qwen3-tts 插入(INSERT OR IGNORE),这里必须 upsert 而不是 INSERT。
  db.prepare(`
    INSERT INTO final_edit_tts_providers
      (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, createdAt, updatedAt)
    VALUES ('vapi-qwen3-tts', 'V-API Qwen3 TTS Flash', 'vapi-qwen-json-url', 'http://127.0.0.1:1', 'smoke-key', '', 'qwen3-tts-flash', 1, 1, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET baseUrl = excluded.baseUrl, apiKey = excluded.apiKey, keyEnv = excluded.keyEnv, enabled = 1, updatedAt = excluded.updatedAt
  `).run();
  // BGM 曲库:BGM 是必选项,空曲库会禁用开始按钮
  fs.mkdirSync(path.join(dataRoot, 'storage', 'bgm'), { recursive: true });
  const bgmPath = path.join(dataRoot, 'storage', 'bgm', 'smoke-bgm.mp3');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-y', bgmPath,
  ]);
  const bgmFingerprint = createHash('sha256').update(fs.readFileSync(bgmPath)).digest('hex');
  db.prepare(`
    INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
    VALUES ('smoke-bgm', 'bgm/smoke-bgm.mp3', ?, 2_000_000, 'mp3', 'ready', datetime('now'))
  `).run(bgmFingerprint);

  const scriptAId = createProjectScript(db, 'batch-ui-project', {
    sourceKind: 'script_draft',
    sourceId: 'batch-ui-script-a',
    title: '口播 A',
    bodyText: '第一份用于生成两条成片的文案。',
    sourceVersion: '1',
    metadata: {
      coverTitleJson: { primary: '口播 A', secondary: '两条成片' },
      shotSetId: 'shot-set-a',
      contentRevision: 'revision-a',
    },
  });
  const scriptBId = createProjectScript(db, 'batch-ui-project', {
    sourceKind: 'script_draft',
    sourceId: 'batch-ui-script-b',
    title: '口播 B',
    bodyText: '第二份用于生成一条成片的文案。',
    sourceVersion: '1',
    metadata: {
      coverTitleJson: { primary: '口播 B', secondary: '一条成片' },
      shotSetId: 'shot-set-b',
      contentRevision: 'revision-b',
    },
  });

  async function seedManagedAsset(idSuffix, withAnalysis) {
    const relativePath = path.join('storage', 'batch-media', 'batch-ui-project', `${idSuffix}.mp4`);
    const absolutePath = path.join(dataRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=${idSuffix === 'ready' ? 'blue' : 'orange'}:duration=0.4:size=64x64:rate=12`,
      '-pix_fmt', 'yuv420p', '-y', absolutePath,
    ]);
    const contents = fs.readFileSync(absolutePath);
    const fingerprint = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
    const assetId = createAsset(db, {
      projectId: 'batch-ui-project',
      sourceKind: 'managed',
      locationJson: { kind: 'managed', relativePath },
      contentFingerprint: fingerprint,
      mediaKind: 'video',
      mediaJson: { displayName: idSuffix === 'ready' ? '已分析素材' : '待分析素材', durationSec: 12, width: 1080, height: 1920 },
    });
    db.prepare(`
      INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
      VALUES (?, ?, 'managed', ?, 'healthy', '2026-08-02T00:00:00.000Z')
    `).run(randomUUID(), assetId, JSON.stringify({ kind: 'managed', relativePath }));
    if (!withAnalysis) return { assetId, analysisId: null };
    const analysisId = createAnalysisVersion(db, {
      assetId,
      analyzerVersion: 'batch-ui-v1',
      providerId: 'batch-ui-provider',
      model: 'smoke',
      analysisJson: {
        usable: true,
        durationUs: 60_000_000,
        scenes: [{ startUs: 0, endUs: 60_000_000, qualityScore: 0.9, labels: ['产品'] }],
        coverFrameTimesUs: [0],
      },
    });
    setAssetCurrentAnalysis(db, 'batch-ui-project', assetId, analysisId);
    return { assetId, analysisId };
  }

  const readyAsset = await seedManagedAsset('ready', true);
  const pendingAsset = await seedManagedAsset('pending', false);
  db.close();

  const pendingMediaQuery = `projectId=batch-ui-project`;
  const thumbnailResponse = await fetch(
    `${baseUrl}/api/batch-production/assets/${pendingAsset.assetId}/thumbnail?${pendingMediaQuery}`,
  );
  assert.equal(thumbnailResponse.status, 200, '真实缩略图 route 必须可用');
  assert.match(thumbnailResponse.headers.get('content-type') ?? '', /^image\/jpeg/);
  const thumbnailMetadata = await sharp(Buffer.from(await thumbnailResponse.arrayBuffer())).metadata();
  assert.deepEqual(
    { format: thumbnailMetadata.format, width: thumbnailMetadata.width, height: thumbnailMetadata.height },
    { format: 'jpeg', width: 960, height: 540 },
    '浏览器验收素材必须得到真实 960×540 JPEG 缩略图',
  );
  const previewResponse = await fetch(
    `${baseUrl}/api/batch-production/assets/${pendingAsset.assetId}/preview?${pendingMediaQuery}`,
    { headers: { Range: 'bytes=0-7' } },
  );
  assert.equal(previewResponse.status, 206, '真实原片预览 route 必须支持 Range');
  assert.equal((await previewResponse.arrayBuffer()).byteLength, 8);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  let analysisRequested = false;
  let analysisTaskReads = 0;
  await page.route('**/api/batch-production/batches/*/assets/analyze**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    analysisRequested = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        batchId: 'mock-batch',
        projectId: 'batch-ui-project',
        items: [{ assetId: pendingAsset.assetId, taskId: 'mock-asset-task', status: 'queued', ready: false }],
      }),
    });
  });
  await page.route('**/api/batch-production/prepare?projectId=batch-ui-project', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (analysisRequested) {
      const pending = body.assets.find(({ id }) => id === pendingAsset.assetId);
      if (pending) {
        pending.currentAnalysisId = 'mock-analysis-id';
        pending.analysisLevel = 'technical';
      }
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route('**/api/batch-production/batches/*/tasks?projectId=batch-ui-project', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tasks = body.tasks.filter(({ workType }) => workType !== 'asset_prepare');
    if (analysisRequested) {
      analysisTaskReads += 1;
      const succeeded = analysisTaskReads > 1;
      body.tasks.push({
        id: 'mock-asset-task',
        workType: 'asset_prepare',
        targetKind: 'asset',
        targetId: pendingAsset.assetId,
        status: succeeded ? 'succeeded' : 'queued',
        expectedState: 'running',
        attemptCount: 1,
        progressJson: succeeded
          ? { phase: 'analyzed', description: '分析完成', percent: 1 }
          : { phase: 'locating', description: '定位素材来源', percent: null },
        createdAt: '2026-08-03T00:00:00.000Z',
        attempts: [{
          id: 'mock-asset-attempt',
          attemptNumber: 1,
          status: succeeded ? 'succeeded' : 'running',
          progressJson: succeeded
            ? { phase: 'analyzed', description: '分析完成', percent: 1 }
            : { phase: 'locating', description: '定位素材来源', percent: null },
          errorCode: null,
          errorMessage: null,
          startedAt: '2026-08-03T00:00:00.000Z',
          finishedAt: succeeded ? '2026-08-03T00:00:01.000Z' : null,
        }],
      });
    }
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  page.on('console', (message) => browserMessages.push(`${message.type()}: ${message.text()}`));
  const batchResponses = [];
  const batchRequests = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/batch-production/')) {
      batchResponses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/batch-production/')) {
      batchRequests.push({
        url: request.url(),
        method: request.method(),
        postData: request.postDataJSON(),
      });
    }
  });
  await page.goto(`${baseUrl}/projects/batch-ui-project?tab=final-edit`, { waitUntil: 'domcontentloaded' });

  const batchTab = page.getByRole('tab', { name: '批量生产', exact: true });
  await batchTab.waitFor();
  await batchTab.click();
  await page.waitForFunction(() => (
    document.body.innerText.includes('素材区')
    || document.body.innerText.includes('批量准备区暂不可用')
  ));
  const prepareResponse = batchResponses.find(({ url }) => url.includes('/api/batch-production/prepare?'));
  assert.deepEqual(
    prepareResponse,
    { url: `${baseUrl}/api/batch-production/prepare?projectId=batch-ui-project`, status: 200 },
    `点击批量生产后必须成功请求真实 prepare API；实际批量响应=${JSON.stringify(batchResponses)}`,
  );

  await page.getByRole('heading', { name: '素材区' }).waitFor();
  await page.getByRole('heading', { name: '已分析素材' }).waitFor();
  await page.getByRole('img', { name: '待分析素材 缩略图' }).waitFor();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByLabel('素材列表').waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const previewDialog = page.getByRole('dialog');
  await page.getByRole('img', { name: '待分析素材 缩略图' }).click();
  await previewDialog.waitFor();
  await page.getByTestId(`asset-preview-modal-${pendingAsset.assetId}`).waitFor();
  await page.getByRole('button', { name: '关闭素材预览' }).click();
  assert.equal(await previewDialog.count(), 0, '素材预览弹窗必须可关闭');

  await page.getByLabel('新批次名称').fill('三条成片验收批次');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByText('批次已创建', { exact: false }).waitFor();

  const analyzeRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && /\/api\/batch-production\/batches\/[^/]+\/assets\/analyze\?projectId=batch-ui-project$/.test(request.url())
  ));
  await page.getByRole('button', { name: '基础分析（1）', exact: true }).click();
  const analysisRequest = await analyzeRequest;
  assert.deepEqual(analysisRequest.postDataJSON(), { assetIds: [pendingAsset.assetId], mode: 'technical' });
  const pendingAssetCheckbox = page.getByRole('checkbox', { name: '选择素材 待分析素材' });
  await playwrightExpect(pendingAssetCheckbox).toBeEnabled({ timeout: 10_000 });

  const selectAllAssetsButton = page.getByRole('button', { name: '一键全选', exact: true });
  await playwrightExpect(selectAllAssetsButton).toBeEnabled();
  await selectAllAssetsButton.click();
  await playwrightExpect(page.getByRole('checkbox', { name: '选择素材 已分析素材' })).toBeChecked();
  await playwrightExpect(pendingAssetCheckbox).toBeChecked();
  const cancelSelectAllAssetsButton = page.getByRole('button', { name: '取消全选', exact: true });
  await cancelSelectAllAssetsButton.click();
  await playwrightExpect(page.getByRole('checkbox', { name: '选择素材 已分析素材' })).not.toBeChecked();
  await playwrightExpect(pendingAssetCheckbox).not.toBeChecked();

  // 第 2 步 · 脚本与口播:先勾选素材解锁步骤,再进入并选择脚本
  await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).check();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).check();
  await page.getByLabel('口播 A 生成份数').fill('2');
  await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).check();
  await page.getByLabel('口播 B 生成份数').fill('1');

  await page.getByRole('button', { name: '确认整体输入', exact: true }).click();
  await page.getByText('已确认 3 张成片计划').waitFor();
  // 第 3 步 · 检查成片:待生成成片卡片
  await page.getByRole('button', { name: /检查成片/ }).click();
  assert.equal(await page.getByTestId('batch-output-card').count(), 3, '必须精确展示份数合计 N 张成片计划');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '批量生产', exact: true }).click();
  await page.getByRole('heading', { name: '素材区' }).waitFor();
  // 刷新后批次详情异步恢复:先确认素材选择(第 1 步),再进第 2 步确认脚本与份数
  await page.waitForFunction((name) => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.getAttribute('aria-label') === name);
    return Boolean(checkbox && checkbox.checked);
  }, '选择素材 已分析素材');
  assert.equal(await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).isChecked(), true, '刷新后必须恢复素材池选择');
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).waitFor();
  await page.waitForFunction((name) => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.getAttribute('aria-label') === name);
    return Boolean(checkbox && checkbox.checked);
  }, '选择脚本 口播 A');
  await page.waitForFunction((name) => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.getAttribute('aria-label') === name);
    return Boolean(checkbox && checkbox.checked);
  }, '选择脚本 口播 B');
  assert.equal(await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).isChecked(), true, '刷新后必须恢复脚本 A 选择');
  assert.equal(await page.getByLabel('口播 A 生成份数').inputValue(), '2', '刷新后必须恢复脚本 A 份数');
  assert.equal(await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).isChecked(), true, '刷新后必须恢复脚本 B 选择');
  assert.equal(await page.getByLabel('口播 B 生成份数').inputValue(), '1', '刷新后必须恢复脚本 B 份数');
  await page.getByRole('button', { name: /检查成片/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-output-card"]').length === 3);
  assert.equal(await page.getByTestId('batch-output-card').count(), 3, '刷新后必须从批次详情恢复精确 N 张卡片');

  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('button', { name: '开始批量生产', exact: true }).click();
  await page.getByText('自动配画面完成，已建立 3 条渲染候选。').waitFor();

  // Phase E 浏览器闭环：失败候选可重试、单条重分配只调用目标 route、
  // 无正式候选的选中导出必须逐条跳过并给出原因。
  const renderRetryRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && /\/api\/batch-production\/tasks\/[^/]+\/retry$/.test(new URL(request.url()).pathname)
  ));
  await page.getByRole('button', { name: '重新渲染', exact: true }).first().click();
  await renderRetryRequest;

  const reallocateRequest = page.waitForRequest((request) => (
    request.method() === 'POST'
    && /\/api\/batch-production\/batches\/[^/]+\/outputs\/[^/]+\/reallocate$/.test(new URL(request.url()).pathname)
  ));
  await page.getByRole('button', { name: '换一批画面', exact: true }).first().click();
  await reallocateRequest;
  await page.getByText(/已为这一条建立新候选|本次没有得到不同的合法安排/).waitFor();

  // 无配音样片不可勾选(正式发布门禁),导出按钮随之禁用;跳过原因在卡片上说明。
  const exportCheckbox = page.getByRole('checkbox', { name: '选择成片 1' });
  await exportCheckbox.waitFor();
  assert.equal(await exportCheckbox.isDisabled(), true, '无配音样片的导出勾选框必须禁用');
  assert.equal(await exportCheckbox.getAttribute('title'), '这条成片还没有配音，暂时无法导出', '无配音样片必须给出可读的禁用原因');
  // 第 4 步 · 导出成片
  await page.getByRole('button', { name: /导出成片/ }).click();
  const exportButton = page.getByRole('button', { name: '正式导出选中项（0）', exact: true });
  await exportButton.waitFor();
  assert.equal(await exportButton.isDisabled(), true, '没有可导出成片时正式导出按钮必须禁用');
  await page.getByText('当前没有可导出的成片', { exact: false }).waitFor();

  // (i) frozen 批次仍能查看和管理该版本的代理:画质与调色折叠区必须可见、可请求低清预览片。
  await page.getByRole('button', { name: /准备素材/ }).click();
  await page.getByRole('button', { name: /画质与调色（进阶）/ }).click();
  const generateProxyButton = page.getByRole('button', { name: '为当前批次全部素材生成低清预览片', exact: true });
  await generateProxyButton.waitFor();
  await generateProxyButton.click();
  await page.getByText('已为 1 条素材请求代理').waitFor();
  // 真实视频应完成代理生成，并只显示中文状态（不泄漏内部枚举值）。
  // 已完成/已取消任务默认收起，先展开历史再确认中文状态文本。
  const mediaPrepSection = page.getByRole('region', { name: '画质与调色' });
  await mediaPrepSection.getByRole('button', { name: /显示全部/ }).click();
  await mediaPrepSection.getByText('已完成', { exact: true }).first().waitFor({ timeout: 20_000 });
  assert.equal(await page.getByText('succeeded', { exact: true }).count(), 0, '不得直接显示内部状态值 succeeded');
  assert.equal(await page.getByText('failed', { exact: true }).count(), 0, '不得直接显示内部状态值 failed');
  assert.equal(await page.getByText('queued', { exact: true }).count(), 0, '不得直接显示内部状态值 queued');
  assert.equal(await page.getByText('running', { exact: true }).count(), 0, '不得直接显示内部状态值 running');
  // 统一素材区:素材卡可直接预览原片/低清预览片,不再有第二个固定高度的批次素材池。
  assert.equal(await page.getByTestId('media-prep-asset-pool').count(), 0, '不得再出现旧的固定高度批次素材池');
  await page.getByRole('button', { name: '播放锁定素材 已分析素材' }).click();
  await page.getByTestId(`asset-preview-modal-${readyAsset.assetId}`).waitFor();
  assert.ok(
    batchRequests.some(({ url }) => url.includes(`/api/batch-production/preview/${readyAsset.assetId}`)),
    '素材预览必须真实请求 /api/batch-production/preview/[assetId]',
  );
  await page.getByRole('button', { name: '关闭素材预览' }).click();
  // 未确认前不得请求代理:切回草稿编辑(基于当前项目输入)后,任何输入变化都会
  // 标记"未重新确认",代理按钮必须禁用直到再次确认。
  await page.getByRole('button', { name: '基于当前项目输入创建新版本' }).click();
  // 创建新版本后回到第 1 步且素材选择被清空;未选中素材时第 2 步不可进入
  await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).check();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).check();
  await page.getByLabel('口播 A 生成份数').fill('2');
  await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).check();
  await page.getByLabel('口播 B 生成份数').fill('1');
  // 修改输入后尚未重新确认:代理按钮必须禁用,不能请求旧 currentVersion 的快照
  await page.getByRole('button', { name: /准备素材/ }).click();
  const unconfirmedProxyButton = page.getByRole('button', { name: '为当前批次全部素材生成低清预览片', exact: true });
  assert.equal(await unconfirmedProxyButton.isDisabled(), true, '未重新确认输入时代理按钮必须禁用');
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('button', { name: '确认整体输入', exact: true }).click();
  await page.getByText('整体输入没有变化，继续使用已冻结的批次版本。').waitFor();
  await page.getByRole('button', { name: /准备素材/ }).click();
  await page.getByRole('heading', { name: '已锁定的批次设置' }).waitFor();
  // 重新确认后代理按钮恢复可用
  assert.equal(await unconfirmedProxyButton.isDisabled(), false, '重新确认后代理按钮必须恢复可用');

  const postStartDb = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  postStartDb.prepare(`
    UPDATE batch_scripts SET title = '上游已改标题', bodyText = '上游已经改写，历史批次不得展示这段正文。'
    WHERE id = ?
  `).run(scriptAId);
  postStartDb.close();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '批量生产', exact: true }).click();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('heading', { name: '已锁定的脚本与口播' }).waitFor();
  await page.getByText('已锁定的脚本快照').first().waitFor();
  await page.getByText('第一份用于生成两条成片的文案。').waitFor();
  assert.equal(
    await page.getByText('上游已经改写，历史批次不得展示这段正文。').count(),
    0,
    '锁定批次必须展示自己的脚本快照，不得改为当前项目脚本正文',
  );

  const created = batchRequests.find(({ method, url }) => method === 'POST' && new URL(url).pathname === '/api/batch-production/batches');
  assert.equal(created?.postData?.projectId, 'batch-ui-project');
  assert.equal(created?.postData?.name, '三条成片验收批次');

  const snapshot = batchRequests.find(({ method, url }) => method === 'POST' && /\/api\/batch-production\/batches\/[^/]+\/snapshot$/.test(new URL(url).pathname));
  assert.deepEqual(snapshot?.postData?.scriptSelections, [
    { scriptId: scriptAId, copyCount: 2 },
    { scriptId: scriptBId, copyCount: 1 },
  ]);
  assert.deepEqual(snapshot?.postData?.assetSelections, [
    { assetId: readyAsset.assetId, analysisId: readyAsset.analysisId, colorSnapshot: { lutId: null } },
  ]);

  const started = batchRequests.find(({ method, url }) => method === 'PUT' && /\/api\/batch-production\/batches\/[^/]+\/start$/.test(new URL(url).pathname));
  assert.ok(started, '开跑必须调用规范的 /batches/[id]/start API');

  console.log('batch preparation and Phase E workspace Playwright tests passed');
} catch (error) {
  process.stderr.write(serverOutput.join(''));
  if (page) {
    process.stderr.write(`\n浏览器地址: ${page.url()}\n`);
    process.stderr.write(`浏览器正文: ${(await page.locator('body').innerText().catch(() => '无法读取')).slice(0, 4000)}\n`);
    process.stderr.write(`浏览器日志: ${browserMessages.join('\n')}\n`);
  }
  throw error;
} finally {
  if (page) await page.unrouteAll({ behavior: 'ignoreErrors' });
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
