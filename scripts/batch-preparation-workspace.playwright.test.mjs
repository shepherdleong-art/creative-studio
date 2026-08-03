import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { createAnalysisVersion, createAsset, setAssetCurrentAnalysis } from '../lib/batch-production/assets.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';

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
    INSERT INTO projects (id, name, providerId, model, prompt, workflowType)
    VALUES ('batch-ui-project', '批量准备区验收项目', 'batch-ui-provider', 'smoke', 'smoke', 'complex_product')
  `).run();

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

  function seedManagedAsset(idSuffix, withAnalysis) {
    const relativePath = path.join('storage', 'batch-media', 'batch-ui-project', `${idSuffix}.mp4`);
    const absolutePath = path.join(dataRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const contents = Buffer.from(`batch-ui-${idSuffix}`);
    fs.writeFileSync(absolutePath, contents);
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
      analysisJson: { usable: true },
    });
    setAssetCurrentAnalysis(db, 'batch-ui-project', assetId, analysisId);
    return { assetId, analysisId };
  }

  const readyAsset = seedManagedAsset('ready', true);
  seedManagedAsset('pending', false);
  db.close();

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
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
    document.body.innerText.includes('批量生产准备区')
    || document.body.innerText.includes('批量准备区暂不可用')
  ));
  const prepareResponse = batchResponses.find(({ url }) => url.includes('/api/batch-production/prepare?'));
  assert.deepEqual(
    prepareResponse,
    { url: `${baseUrl}/api/batch-production/prepare?projectId=batch-ui-project`, status: 200 },
    `点击批量生产后必须成功请求真实 prepare API；实际批量响应=${JSON.stringify(batchResponses)}`,
  );

  await page.getByRole('heading', { name: '批量生产准备区' }).waitFor();
  await page.getByRole('heading', { name: '口播 A' }).waitFor();
  await page.getByRole('heading', { name: '已分析素材' }).waitFor();

  await page.getByLabel('新批次名称').fill('三条成片验收批次');
  await page.getByRole('button', { name: '创建批次', exact: true }).click();
  await page.getByText('批次已创建', { exact: false }).waitFor();

  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).check();
  await page.getByLabel('口播 A 生成份数').fill('2');
  await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).check();
  await page.getByLabel('口播 B 生成份数').fill('1');
  await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).check();
  assert.equal(
    await page.getByRole('checkbox', { name: '选择素材 待分析素材' }).isDisabled(),
    true,
    '没有 currentAnalysisId 的素材不得参与批次快照',
  );
  await page.getByText('尚未完成素材分析，暂不可选').waitFor();

  await page.getByRole('button', { name: '确认整体输入', exact: true }).click();
  await page.getByText('已确认 3 张成片计划').waitFor();
  assert.equal(await page.getByTestId('batch-output-card').count(), 3, '必须精确展示份数合计 N 张成片计划');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '批量生产', exact: true }).click();
  await page.getByRole('heading', { name: '批量生产准备区' }).waitFor();
  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).waitFor();
  // 批次详情恢复是异步的:轮询等待选择状态与卡片数量真正恢复,避免竞态误报。
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
  await page.waitForFunction((name) => {
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((element) => element.getAttribute('aria-label') === name);
    return Boolean(checkbox && checkbox.checked);
  }, '选择素材 已分析素材');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-output-card"]').length === 3);
  assert.equal(await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).isChecked(), true, '刷新后必须恢复脚本 A 选择');
  assert.equal(await page.getByLabel('口播 A 生成份数').inputValue(), '2', '刷新后必须恢复脚本 A 份数');
  assert.equal(await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).isChecked(), true, '刷新后必须恢复脚本 B 选择');
  assert.equal(await page.getByLabel('口播 B 生成份数').inputValue(), '1', '刷新后必须恢复脚本 B 份数');
  assert.equal(await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).isChecked(), true, '刷新后必须恢复素材池选择');
  assert.equal(await page.getByTestId('batch-output-card').count(), 3, '刷新后必须从批次详情恢复精确 N 张卡片');

  await page.getByRole('button', { name: '开始批量生产', exact: true }).click();
  await page.getByText('批次已开始生产').waitFor();

  // (i) frozen 批次仍能查看和管理该版本的代理:媒体准备区必须可见、可请求代理。
  await page.getByRole('button', { name: '为当前批次全部素材生成代理', exact: true }).waitFor();
  await page.getByRole('button', { name: '为当前批次全部素材生成代理', exact: true }).click();
  await page.getByText('已为 1 条素材请求代理').waitFor();
  // 假素材字节无法被 ffprobe 识别,任务会真实失败并显示中文"失败"与"重试"
  // (不能显示 succeeded/failed 等内部值)。
  const retryButton = page.getByRole('button', { name: '重试', exact: true }).first();
  await retryButton.waitFor({ timeout: 20_000 });
  const failedTaskRow = page.locator('li', { has: retryButton }).first();
  await failedTaskRow.getByText('失败', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('succeeded', { exact: true }).count(), 0, '不得直接显示内部状态值 succeeded');
  assert.equal(await page.getByText('failed', { exact: true }).count(), 0, '不得直接显示内部状态值 failed');
  assert.equal(await page.getByText('queued', { exact: true }).count(), 0, '不得直接显示内部状态值 queued');
  assert.equal(await page.getByText('running', { exact: true }).count(), 0, '不得直接显示内部状态值 running');
  // 预览:冻结版本的素材必须渲染真实 preview API 驱动的可播放 video 元素
  await page.getByTestId(`asset-preview-${readyAsset.assetId}`).waitFor();
  assert.ok(
    batchRequests.some(({ url }) => url.includes(`/api/batch-production/preview/${readyAsset.assetId}`)),
    '素材预览必须真实请求 /api/batch-production/preview/[assetId]',
  );
  // 未确认前不得请求代理:切回草稿编辑(基于当前项目输入)后,任何输入变化都会
  // 标记"未重新确认",代理按钮必须禁用直到再次确认。
  await page.getByRole('button', { name: '基于当前项目输入创建新版本' }).click();
  await page.getByRole('checkbox', { name: '选择脚本 口播 A' }).check();
  await page.getByLabel('口播 A 生成份数').fill('2');
  await page.getByRole('checkbox', { name: '选择脚本 口播 B' }).check();
  await page.getByLabel('口播 B 生成份数').fill('1');
  await page.getByRole('checkbox', { name: '选择素材 已分析素材' }).check();
  // 修改输入后尚未重新确认:代理按钮必须禁用,不能请求旧 currentVersion 的快照
  const unconfirmedProxyButton = page.getByRole('button', { name: '为当前批次全部素材生成代理', exact: true });
  assert.equal(await unconfirmedProxyButton.isDisabled(), true, '未重新确认输入时代理按钮必须禁用');
  await page.getByRole('button', { name: '确认整体输入', exact: true }).click();
  await page.getByText('整体输入没有变化，继续使用已冻结的批次版本。').waitFor();
  await page.getByRole('heading', { name: '已冻结的批次输入' }).waitFor();
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
  await page.getByRole('heading', { name: '已冻结的批次输入' }).waitFor();
  await page.getByText('冻结脚本快照').first().waitFor();
  await page.getByText('第一份用于生成两条成片的文案。').waitFor();
  assert.equal(
    await page.getByText('上游已经改写，历史批次不得展示这段正文。').count(),
    0,
    '冻结批次必须展示自己的脚本快照，不得改为当前项目脚本正文',
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

  console.log('batch preparation and Phase B workspace Playwright tests passed');
} catch (error) {
  process.stderr.write(serverOutput.join(''));
  if (page) {
    process.stderr.write(`\n浏览器地址: ${page.url()}\n`);
    process.stderr.write(`浏览器正文: ${(await page.locator('body').innerText().catch(() => '无法读取')).slice(0, 4000)}\n`);
    process.stderr.write(`浏览器日志: ${browserMessages.join('\n')}\n`);
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
