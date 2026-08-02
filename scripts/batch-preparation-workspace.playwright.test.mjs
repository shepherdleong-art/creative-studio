import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';

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
  db.close();

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on('console', (message) => browserMessages.push(`${message.type()}: ${message.text()}`));
  const batchResponses = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/batch-production/')) {
      batchResponses.push({ url: response.url(), status: response.status() });
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
  await page.getByText('暂无可用项目脚本，请先在第 3 步保存脚本。').waitFor();
  await page.getByText('暂无可用视频素材，请先在第 4 步完成视频生成。').waitFor();
  assert.equal(await page.getByText('本阶段只核对输入，不会创建批次或开始生产。', { exact: false }).count(), 1);

  console.log('batch preparation workspace Playwright tests passed');
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
