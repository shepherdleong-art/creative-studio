// 修复前复现（red 证据）：把结果卡海报恢复成默认优化渲染，用同一套真实服务与
// 真实会话确认浏览器里确实是破图（image.complete 为真但 naturalWidth === 0）。
//
// 只在票 02 的复现记录里用一次；实现提交后该文件的默认渲染已改为 unoptimized。
// 用法：node scripts/video-poster-pre-fix-repro.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const componentPath = path.join(repoRoot, 'components', 'VideoGenerationResults.tsx');
const evidenceDirectory = path.join(repoRoot, 'outputs', 'video-poster-auth-evidence');
fs.mkdirSync(evidenceDirectory, { recursive: true });

const current = fs.readFileSync(componentPath, 'utf8');
// 把 PosterThumb 的 Image 换成修复前的默认优化写法。
const restored = current.replace(
  /<Image\s+src=\{url\}[\s\S]*?\/>/,
  '<Image src={url} alt="视频缩略图" fill sizes="300px" className="object-cover" />',
);
assert.notEqual(restored, current, '复现脚本必须真的改到了海报渲染');
fs.writeFileSync(componentPath, restored);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const servers = [];

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function env(root, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'video-poster-pre-fix',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'video-poster-pre-fix',
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-poster-pre-fix-'));
let browser;
let child;
try {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = env(root, port);

  const initialized = spawnSync(
    process.execPath,
    ['scripts/team-server/init-admin.mjs', '--employee-id', 'pre-admin', '--name', '复现管理员'],
    { cwd: repoRoot, env: environment, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(adminCredential, initialized.stdout);

  child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: repoRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  servers.push(child);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) break;
    } catch { /* 启动等待 */ }
    await sleep(300);
  }

  async function login(employeeId, password) {
    const csrfResponse = await fetch(`${baseUrl}/api/team/auth/csrf`);
    const csrfCookie = csrfResponse.headers.get('set-cookie').split(';', 1)[0];
    const csrf = (await csrfResponse.json()).csrfToken;
    const response = await fetch(`${baseUrl}/api/team/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf },
      body: JSON.stringify({ employeeId, password }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return { csrf, cookies: [csrfCookie, response.headers.get('set-cookie').split(';', 1)[0]] };
  }
  async function api(session, pathname, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Cookie', session.cookies.join('; '));
    headers.set('Origin', baseUrl);
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
    headers.set('x-creative-studio-client-version', '0.7.1');
    headers.set('x-creative-studio-client-api', '1');
    if (options.json) headers.set('Content-Type', 'application/json');
    return fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers,
      ...(options.json ? { body: JSON.stringify(options.json) } : {}),
    });
  }

  const admin = await login('pre-admin', adminCredential);
  await api(admin, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword: adminCredential, newPassword: 'Pre-admin-pass-2026' },
  });
  const owner = await (await api(admin, '/api/team/users', {
    method: 'POST', json: { employeeId: 'pre-owner', displayName: '图片所属员工', role: 'employee' },
  })).json();
  const ownerSession = await login('pre-owner', owner.credential);
  await api(ownerSession, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword: owner.credential, newPassword: 'Pre-owner-pass-2026' },
  });

  const seeded = spawnSync(
    process.execPath,
    ['scripts/team-server/seed-video-poster-fixture.mjs', '--mode', 'server', '--owner-a', owner.user.id],
    { cwd: repoRoot, env: environment, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(seeded.status, 0, seeded.stderr?.slice(-3000));
  const fixture = JSON.parse(/FIXTURE_RESULT (.+)/.exec(seeded.stdout ?? '')[1]);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  const responses = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/_next/image') && url.searchParams.get('url') === fixture.posterUrl) {
      responses.push({ path: url.pathname, status: response.status() });
    }
  });
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: `creative-studio:video-shot-set:${fixture.projectId}`, value: fixture.shotSetId,
  });
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill('pre-owner');
  await page.locator('input[autocomplete="current-password"]').fill('Pre-owner-pass-2026');
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await page.goto(`${baseUrl}/projects/${fixture.projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  const selector = '.result-thumb img[alt="视频缩略图"]';
  await page.waitForSelector(selector, { timeout: 120_000 });
  await page.waitForTimeout(6000);

  const before = await page.evaluate((query) => {
    const image = document.querySelector(query);
    return image ? {
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      currentSrc: image.currentSrc,
    } : { present: false };
  }, selector);

  await page.screenshot({ path: path.join(evidenceDirectory, 'pre-fix-broken-poster.png') });
  const report = {
    posterUrl: fixture.posterUrl,
    image: before,
    optimizerRequests: responses,
    verdict: before.naturalWidth === 0 ? 'broken-image-reproduced' : 'not-reproduced',
  };
  fs.writeFileSync(path.join(evidenceDirectory, 'pre-fix-repro.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PRE_FIX_RESULT ${JSON.stringify(report)}`);
  assert.equal(report.verdict, 'broken-image-reproduced', '修复前必须能在浏览器里复现破图（naturalWidth === 0）');
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => undefined);
  for (const instance of servers) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(instance.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-instance.pid, 'SIGKILL'); } catch { instance.kill('SIGKILL'); }
    }
  }
  fs.writeFileSync(componentPath, current);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
