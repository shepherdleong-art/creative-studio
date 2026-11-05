// 票 02 验收：受保护视频缩略图的真实会话复现 + 浏览器渲染断言。
//
// 为什么必须起真服务：缺陷只在 server 模式的鉴权下暴露 —— local 模式 /api/images
// 不做实体授权，看不到 401。所以这里用真实的 next dev + 真实 SQLite + 真实 Chromium，
// 不用任何 mock 替代鉴权。
//
// 复现口径（票里第 1 条）：分别核对「原始图片 URL」和「优化后 URL」，并配一个公开
// 图片对照组，把「优化器取不到受保护图片」和「优化器本身坏了」区分开。
//
// 断言口径（票里「测试与完成证据」）：必须断言 image.complete 且 naturalWidth > 0，
// 而不是只看 <img> 存在。
//
// 端口：31xx，避开 3000。用完关服务、删临时数据根。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeExecutable = process.execPath;
const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const keep = process.argv.includes('--keep-evidence');

const evidenceDirectory = path.join(repoRoot, 'outputs', 'video-poster-auth-evidence');
fs.rmSync(evidenceDirectory, { recursive: true, force: true });
fs.mkdirSync(evidenceDirectory, { recursive: true });

const servers = [];
const result = {
  schemaVersion: 1,
  assertions: [],
  observed: {},
  evidence: [],
  pageErrors: [],
  realPaidProviderCalls: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(text) {
  return String(text).replace(/(?:__Host-team_(?:session|csrf))=[^\s;]+/g, '[redacted-cookie]');
}

async function portFree(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
}

async function pickPort() {
  for (let port = 3120; port <= 3198; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error('3120-3198 没有空闲端口');
}

function serverEnvironment(root, port, deploymentId) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'video-poster-auth-local',
  };
}

function localEnvironment(root, port) {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local',
    CREATIVE_STUDIO_PORT: String(port),
    // local 模式不读 server 配置；显式清掉避免继承上一个 server 进程的残留。
    CREATIVE_STUDIO_DEPLOYMENT_ID: '',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: '',
  };
}

async function startServer({ port, environment, label, serverMode }) {
  const entry = { label, port, baseUrl: `http://127.0.0.1:${port}`, output: '', child: null };
  entry.child = spawn(
    nodeExecutable,
    [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: repoRoot,
      env: environment,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk) => {
    entry.output += String(chunk);
    fs.appendFileSync(path.join(evidenceDirectory, `${label}-server.log`), redact(String(chunk)));
  };
  entry.child.stdout.on('data', capture);
  entry.child.stderr.on('data', capture);
  servers.push(entry);

  const deadline = Date.now() + 180_000;
  const readinessPath = serverMode ? '/api/team/health/ready' : '/api/projects';
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (entry.child.exitCode !== null) {
      throw new Error(`${label} 服务提前退出 ${entry.child.exitCode}: ${redact(entry.output).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${entry.baseUrl}${readinessPath}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = response.status;
      if (response.status === 200) return entry;
    } catch { /* 启动等待 */ }
    await sleep(300);
  }
  throw new Error(`${label} 服务 readiness 超时，最后状态 ${lastStatus}: ${redact(entry.output).slice(-4000)}`);
}

async function stopServer(entry) {
  if (!entry?.child || entry.child.exitCode !== null) return;
  const child = entry.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, sleep(15_000)]);
}

async function stopAllServers() {
  for (const entry of servers.reverse()) await stopServer(entry);
}

/* ------------------ server 模式：账号、会话、夹具 ------------------ */

async function initAdmin(root, port) {
  const initialized = spawnSync(
    nodeExecutable,
    ['scripts/team-server/init-admin.mjs', '--employee-id', 'poster-admin', '--name', '缩略图管理员'],
    { cwd: repoRoot, env: serverEnvironment(root, port, 'video-poster-auth'), encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(initialized.status, 0, `首管理员初始化失败：${redact(initialized.stderr ?? '')}`);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(credential, `未能从 init-admin 输出解析一次性凭据：${redact(initialized.stdout ?? '')}`);
  return credential;
}

function cookiePair(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, '认证响应必须设置 cookie');
  return value.split(';', 1)[0];
}

async function apiCall(baseUrl, session, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('Cookie', session.cookies.join('; '));
    headers.set('Origin', baseUrl);
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
  }
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  const { json, ...init } = options;
  return fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(120_000),
    ...init,
    headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}

async function login(baseUrl, employeeId, password) {
  const csrfResponse = await apiCall(baseUrl, null, '/api/team/auth/csrf');
  assert.equal(csrfResponse.status, 200);
  const csrfCookie = cookiePair(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const loginResponse = await fetch(`${baseUrl}/api/team/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrfCookie,
      Origin: baseUrl,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ employeeId, password }),
  });
  assert.equal(loginResponse.status, 200, redact(await loginResponse.clone().text()));
  return { employeeId, csrf, cookies: [csrfCookie, cookiePair(loginResponse)] };
}

async function changePassword(baseUrl, session, currentPassword, newPassword) {
  const response = await apiCall(baseUrl, session, '/api/team/auth/change-password', {
    method: 'POST',
    json: { currentPassword, newPassword },
  });
  assert.equal(response.status, 200, redact(await response.clone().text()));
}

async function createEmployee(baseUrl, adminSession, employeeId, displayName) {
  const response = await apiCall(baseUrl, adminSession, '/api/team/users', {
    method: 'POST',
    json: { employeeId, displayName, role: 'employee' },
  });
  assert.equal(response.status, 201, redact(await response.clone().text()));
  return response.json();
}

function seedFixture(environment, args) {
  const seeded = spawnSync(
    nodeExecutable,
    ['scripts/team-server/seed-video-poster-fixture.mjs', ...args],
    { cwd: repoRoot, env: environment, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(seeded.status, 0, `夹具播种失败：${redact(seeded.stderr ?? '')}`);
  const line = /FIXTURE_RESULT (.+)/.exec(seeded.stdout ?? '')?.[1];
  assert.ok(line, `夹具未输出结果：${redact(seeded.stdout ?? '')}`);
  return JSON.parse(line);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/* -------------- 浏览器：真登录、真渲染、真图片字节 -------------- */

async function loginThroughPage(browser, baseUrl, employeeId, password, label) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(`${label}: ${error.message}`));
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  return { context, page };
}

/**
 * 打开第四步并收集受保护媒体的网络事实。
 *
 * 分镜组用 localStorage 预置而不是点下拉：面板的恢复逻辑是既有行为，这里复用它
 * 只是为了把「结果卡海报」这条路径稳定跑到，不是在测组选择。
 */
async function openVideoStep(page, baseUrl, projectId, shotSetId, posterUrl) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: `creative-studio:video-shot-set:${projectId}`, value: shotSetId });
  const responses = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/images/') || url.pathname.startsWith('/_next/image')) {
      responses.push({
        path: url.pathname,
        search: url.search.slice(0, 160),
        status: response.status(),
        // 只把「为这张海报发起的」优化器请求算进缺陷证据；页面上其它图片的
        // 优化请求不属于这张票的范围。
        forPoster: url.pathname === '/_next/image' && url.searchParams.get('url') === posterUrl,
      });
    }
  });
  const navigation = await page.goto(`${baseUrl}/projects/${projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  assert.equal(navigation?.ok(), true, '项目工作台必须由真实服务成功呈现');
  return responses;
}

const POSTER_SELECTOR = '.result-thumb img[alt="视频缩略图"]';

async function posterFacts(page, selector = POSTER_SELECTOR) {
  return page.evaluate((query) => {
    const image = document.querySelector(query);
    if (!image) return { present: false };
    return {
      present: true,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      currentSrc: image.currentSrc,
      // unoptimized 的关键证据：浏览器直接取同源受保护 URL，不经过 /_next/image。
      usesOptimiser: image.currentSrc.includes('/_next/image'),
      fallbackShown: Boolean(document.querySelector('[data-testid="video-poster-fallback"]')),
    };
  }, selector);
}

async function waitPosterLoaded(page) {
  await page.waitForSelector(POSTER_SELECTOR, { timeout: 120_000 });
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector);
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, POSTER_SELECTOR, { timeout: 60_000 });
}

/* ------------------------- server 模式验收 ------------------------- */

async function runServerMode(browser, root, port) {
  const environment = serverEnvironment(root, port, 'video-poster-auth');
  // 首管理员必须在服务启动前写入：服务端 bootstrap 会按 readiness 检查身份结构。
  const adminCredential = await initAdmin(root, port);
  const server = await startServer({ port, environment, label: 'server', serverMode: true });
  const baseUrl = server.baseUrl;
  result.observed.server = { baseUrl, port };

  const admin = await login(baseUrl, 'poster-admin', adminCredential);
  const adminPassword = 'Poster-admin-pass-2026';
  await changePassword(baseUrl, admin, adminCredential, adminPassword);

  const employeeA = await createEmployee(baseUrl, admin, 'poster-owner', '图片所属员工');
  const employeeB = await createEmployee(baseUrl, admin, 'poster-other', '其他员工');
  const aCredential = employeeA.credential;
  const bCredential = employeeB.credential;
  const aSession = await login(baseUrl, 'poster-owner', aCredential);
  const bSession = await login(baseUrl, 'poster-other', bCredential);
  const aPassword = 'Poster-owner-pass-2026';
  const bPassword = 'Poster-other-pass-2026';
  await changePassword(baseUrl, aSession, aCredential, aPassword);
  await changePassword(baseUrl, bSession, bCredential, bPassword);
  result.assertions.push('真实 HTTP 建立管理员 + 两名员工（图片所属 / 其他）的独立会话');

  const fixture = seedFixture(environment, ['--mode', 'server', '--owner-a', employeeA.user.id, '--owner-b', employeeB.user.id]);
  result.observed.fixture = {
    projectId: fixture.projectId,
    shotSetId: fixture.shotSetId,
    posterUrl: fixture.posterUrl,
    videoUrl: fixture.videoUrl,
    posterSha256: fixture.posterSha256,
    teamFiles: fixture.teamFiles,
  };
  result.assertions.push('隔离数据根里存在既有成功视频 + 已登记的受保护海报（不重新提交、不抽帧）');

  // ── 原始图片 URL：所属员工可取、其他员工与未登录不可取 ──
  const ownerImage = await apiCall(baseUrl, aSession, fixture.posterUrl);
  const ownerBytes = Buffer.from(await ownerImage.arrayBuffer());
  assert.equal(ownerImage.status, 200, '图片所属员工必须能读取受保护原图');
  assert.equal(sha256(ownerBytes), fixture.posterSha256, '原图字节必须与磁盘一致');
  assert.match(ownerImage.headers.get('cache-control') ?? '', /private/, '受保护图片必须保持私有缓存策略');
  assert.match(ownerImage.headers.get('cache-control') ?? '', /no-store/, '受保护图片不得被共享缓存复用');

  const otherImage = await apiCall(baseUrl, bSession, fixture.posterUrl);
  const anonymousImage = await apiCall(baseUrl, null, fixture.posterUrl);
  assert.equal(otherImage.status, 404, '其他员工读取受保护原图必须失败，且不泄露存在性');
  assert.equal(anonymousImage.status, 401, '未登录读取受保护原图必须失败');

  const ownerVideo = await apiCall(baseUrl, aSession, fixture.videoUrl);
  assert.equal(ownerVideo.status, 200, '视频必须仍可播放/下载');
  const videoBytes = Buffer.from(await ownerVideo.arrayBuffer());
  assert.equal(videoBytes.length, fixture.videoBytes, '视频字节数必须与磁盘一致');
  result.observed.http = {
    ownerImage: {
      path: fixture.posterUrl, status: ownerImage.status,
      cacheControl: ownerImage.headers.get('cache-control'), sha256: sha256(ownerBytes),
    },
    otherEmployeeImage: { path: fixture.posterUrl, status: otherImage.status },
    anonymousImage: { path: fixture.posterUrl, status: anonymousImage.status },
    ownerVideo: { path: fixture.videoUrl, status: ownerVideo.status, bytes: videoBytes.length },
  };
  result.assertions.push('所属员工取原图 200 且字节一致（private, no-store）；其他员工 404；未登录 401');
  result.assertions.push('视频播放/下载通道保持 200 且字节一致');

  // ── 优化后 URL：缺陷的核心证据 ──
  // 优化器是服务端内部请求，不带入站 Cookie。要证明「破图是因为优化器取不到受保护
  // 图片」而不是「这个构建里优化器本身坏了」，必须配一个公开图片对照组：公开图能过、
  // 受保护图过不了，差异就只可能来自鉴权。
  const optimizerPath = `/_next/image?url=${encodeURIComponent(fixture.posterUrl)}&w=640&q=75`;
  // 对照组必须用 public/ 下的栅格 PNG：SVG 会被 Next 的 dangerouslyAllowSVG 策略挡掉，
  // 那样 400 就来自格式策略而不是鉴权，无法归因。
  const controlPath = `/_next/image?url=${encodeURIComponent('/icons/app-icon-512.png')}&w=640&q=75`;
  const optimizerNoCookie = await fetch(`${baseUrl}${optimizerPath}`, { signal: AbortSignal.timeout(120_000) });
  const optimizerWithCookie = await fetch(`${baseUrl}${optimizerPath}`, {
    headers: { Cookie: aSession.cookies.join('; ') },
    signal: AbortSignal.timeout(120_000),
  });
  const controlResponse = await fetch(`${baseUrl}${controlPath}`, { signal: AbortSignal.timeout(120_000) });
  result.observed.optimizedUrl = {
    path: '/_next/image',
    query: optimizerPath.slice('/_next/image'.length),
    withoutSession: optimizerNoCookie.status,
    withSessionCookie: optimizerWithCookie.status,
    controlPublicAsset: { path: controlPath, status: controlResponse.status },
  };
  assert.equal(controlResponse.status, 200, '对照组：公开图片经同一优化器必须 200，否则无法归因到鉴权');
  assert.notEqual(optimizerNoCookie.status, 200, '优化后 URL 在无会话时必须不是 200（这就是破图成因）');
  assert.notEqual(optimizerWithCookie.status, 200, '优化器不转发入站 Cookie，因此带会话也无法让它取到受保护图片');
  result.assertions.push(
    `复现成立：公开对照图经优化器 200，而受保护海报经优化器无会话 ${optimizerNoCookie.status}、`
    + `带会话 ${optimizerWithCookie.status}；原始图片 URL 带会话 200 —— 差异只来自鉴权`,
  );

  // ── 浏览器：所属员工实际渲染结果卡海报 ──
  const owner = await loginThroughPage(browser, baseUrl, 'poster-owner', aPassword, 'owner');
  const ownerResponses = await openVideoStep(owner.page, baseUrl, fixture.projectId, fixture.shotSetId, fixture.posterUrl);
  await waitPosterLoaded(owner.page);

  const ownerFacts = await posterFacts(owner.page);
  assert.equal(ownerFacts.present, true, '所属员工必须看到结果卡海报元素');
  assert.equal(ownerFacts.complete, true, '海报必须真正加载完成（image.complete）');
  assert.ok(ownerFacts.naturalWidth > 0, `海报必须有真实像素宽度（naturalWidth=${ownerFacts.naturalWidth}）`);
  assert.equal(ownerFacts.naturalWidth, 640, '海报宽度必须等于夹具图片的真实宽度');
  assert.equal(ownerFacts.naturalHeight, 360, '海报高度必须等于夹具图片的真实高度');
  assert.equal(ownerFacts.usesOptimiser, false, '海报不得经过 /_next/image 优化器');
  assert.equal(ownerFacts.fallbackShown, false, '正常加载时不得显示失败占位');

  const posterRequests = ownerResponses.filter((entry) => entry.path.startsWith('/api/images/'));
  const optimiserForPoster = ownerResponses.filter((entry) => entry.forPoster);
  assert.ok(posterRequests.length > 0, '浏览器必须真的发起过受保护图片请求');
  assert.ok(
    posterRequests.every((entry) => entry.status === 200),
    `受保护图片请求必须全部 200：${JSON.stringify(posterRequests)}`,
  );
  assert.deepEqual(optimiserForPoster, [], '结果卡海报不得再触发 /_next/image 请求');
  result.observed.browserOwner = {
    facts: ownerFacts,
    imageRequests: posterRequests,
    optimizerRequestsForPoster: optimiserForPoster,
  };
  result.assertions.push(
    `所属员工浏览器实际渲染：complete=${ownerFacts.complete} naturalWidth=${ownerFacts.naturalWidth} `
    + `naturalHeight=${ownerFacts.naturalHeight}，同源 /api/images 请求 200，未触发优化器`,
  );

  // 宽窄窗口 + 深浅主题
  for (const [name, viewport] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1100, height: 780 }]]) {
    for (const theme of ['light', 'dark']) {
      await owner.page.setViewportSize(viewport);
      await owner.page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await waitPosterLoaded(owner.page);
      const facts = await posterFacts(owner.page);
      assert.equal(facts.complete, true, `${name}/${theme} 下海报必须仍加载完成`);
      assert.ok(facts.naturalWidth > 0, `${name}/${theme} 下海报必须有真实宽度`);
      const file = `owner-${name}-${theme}.png`;
      await owner.page.screenshot({ path: path.join(evidenceDirectory, file), fullPage: false });
      result.evidence.push(file);
    }
  }
  result.assertions.push('宽（1440）/窄（1100）窗口 × 浅/深主题下海报均 complete 且 naturalWidth > 0，截图已留档');

  // ── 播放与下载可用 ──
  const playButton = owner.page.getByRole('button', { name: '播放', exact: true }).first();
  await playButton.waitFor({ timeout: 30_000 });
  await playButton.click();
  await owner.page.waitForFunction(() => {
    const video = document.querySelector('.video-stage video');
    return Boolean(video && video.readyState >= 2);
  }, undefined, { timeout: 60_000 });
  const videoState = await owner.page.evaluate(() => {
    const video = document.querySelector('.video-stage video');
    const download = document.querySelector('a.result-action[download]');
    return {
      readyState: video?.readyState ?? null,
      src: video ? new URL(video.currentSrc || video.src).pathname : null,
      downloadHref: download ? new URL(download.href).pathname : null,
      downloadName: download?.getAttribute('download') ?? null,
    };
  });
  assert.ok(videoState.readyState >= 2, '视频必须仍可播放');
  assert.ok(videoState.downloadHref?.startsWith('/api/videos/'), '下载入口必须仍指向受保护视频地址');
  assert.ok(videoState.downloadName, '下载必须带建议文件名');
  result.observed.playback = videoState;
  result.assertions.push('修复后视频仍可播放（readyState>=2）且下载入口仍指向受保护视频地址');

  // ── 管理员也能看到 ──
  const adminBrowser = await loginThroughPage(browser, baseUrl, 'poster-admin', adminPassword, 'admin');
  await openVideoStep(adminBrowser.page, baseUrl, fixture.projectId, fixture.shotSetId, fixture.posterUrl);
  await waitPosterLoaded(adminBrowser.page);
  const adminFacts = await posterFacts(adminBrowser.page);
  assert.equal(adminFacts.complete, true);
  assert.ok(adminFacts.naturalWidth > 0);
  await adminBrowser.page.screenshot({ path: path.join(evidenceDirectory, 'admin-video-step.png') });
  result.evidence.push('admin-video-step.png');
  result.observed.browserAdmin = adminFacts;
  result.assertions.push('管理员在团队页面同样能看到海报（complete 且 naturalWidth > 0）');

  // ── 未登录浏览器必须失败 ──
  const anonymousContext = await browser.newContext({ locale: 'zh-CN' });
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(`${baseUrl}/projects/${fixture.projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  await anonymousPage.waitForURL((url) => url.pathname.startsWith('/team/login'), { timeout: 60_000 });
  const anonymousFetch = await anonymousPage.evaluate(async (posterUrl) => {
    const response = await fetch(posterUrl, { cache: 'no-store' });
    return response.status;
  }, fixture.posterUrl);
  assert.equal(anonymousFetch, 401, '未登录浏览器取受保护图片必须 401');
  assert.equal(await anonymousPage.locator(POSTER_SELECTOR).count(), 0, '未登录不得渲染结果卡海报');
  result.observed.anonymousBrowser = { redirectedToLogin: true, imageFetchStatus: anonymousFetch };
  await anonymousContext.close();
  result.assertions.push('未登录浏览器被重定向到登录页，且取受保护图片 401、无海报元素');

  // ── 其他员工：无权读取该项目，图片 404 ──
  const otherBrowser = await loginThroughPage(browser, baseUrl, 'poster-other', bPassword, 'other');
  await otherBrowser.page.goto(`${baseUrl}/projects/${fixture.projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  // next dev 把服务端 redirect 下成 __next-page-redirect 的 meta refresh（1s），
  // 不是 HTTP 302。所以这里等浏览器自己走出去，再判定落点。
  await otherBrowser.page.waitForURL((url) => !url.pathname.startsWith('/projects/'), { timeout: 45_000 })
    .catch(() => undefined);
  const otherLanded = new URL(otherBrowser.page.url());
  assert.ok(
    !otherLanded.pathname.startsWith('/projects/'),
    `其他员工打开该项目必须被挡出：实际停在 ${otherLanded.pathname}`,
  );
  assert.equal(await otherBrowser.page.locator(POSTER_SELECTOR).count(), 0, '其他员工不得看到海报');
  assert.equal(
    await otherBrowser.page.locator('.result-card').count(), 0,
    '其他员工不得看到该项目的结果卡（页面守卫必须在渲染前挡下）',
  );
  const otherFetch = await otherBrowser.page.evaluate(async (posterUrl) => {
    const response = await fetch(posterUrl, { cache: 'no-store' });
    return response.status;
  }, fixture.posterUrl);
  assert.equal(otherFetch, 404, '其他员工在浏览器里取海报必须 404');
  result.observed.otherEmployeeBrowser = {
    landedPath: otherLanded.pathname,
    imageFetchStatus: otherFetch,
    resultCards: 0,
  };
  result.assertions.push('其他员工被页面守卫挡出该项目（落点 /），取海报 404、无结果卡与海报元素');

  // ── 同一浏览器切换账号：不得泄露上一账号图片 ──
  // 关键点：Cache-Control 是 private/no-store，所以 B 的请求不能被浏览器缓存复用。
  const switchPage = owner.page;
  await switchPage.goto(`${baseUrl}/api/team/auth/session`, { waitUntil: 'domcontentloaded' });
  const logout = await switchPage.evaluate(async () => {
    const csrf = await fetch('/api/team/auth/csrf').then((response) => response.json());
    const response = await fetch('/api/team/auth/logout', {
      method: 'POST', headers: { 'x-csrf-token': csrf.csrfToken },
    });
    return response.status;
  });
  assert.equal(logout, 200, '登出必须成功');
  await switchPage.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 120_000 });
  await switchPage.locator('input[autocomplete="username"]').fill('poster-other');
  await switchPage.locator('input[autocomplete="current-password"]').fill(bPassword);
  await Promise.all([
    switchPage.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    switchPage.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  // 同一个浏览器上下文里，B 会话直接请求 A 的图片：必须 404，且不得来自缓存。
  const switched = await switchPage.evaluate(async (posterUrl) => {
    const response = await fetch(posterUrl, { cache: 'no-store' });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      contentType: response.headers.get('content-type'),
    };
  }, fixture.posterUrl);
  assert.equal(switched.status, 404, '同浏览器切换账号后不得再取到上一账号的图片');
  assert.notEqual(switched.contentType, 'image/png', '切换账号后不得返回上一账号的图片字节');
  const switchedNavigation = await switchPage.goto(`${baseUrl}/projects/${fixture.projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  // 与上面的其他员工一致：等 meta refresh 把浏览器带离项目页。
  await switchPage.waitForURL((url) => !url.pathname.startsWith('/projects/'), { timeout: 45_000 })
    .catch(() => undefined);
  const switchedLanded = new URL(switchPage.url());
  assert.ok(
    !switchedLanded.pathname.startsWith('/projects/'),
    `切换账号后打开 A 的项目必须被挡出：实际停在 ${switchedLanded.pathname}`,
  );
  assert.equal(await switchPage.locator(POSTER_SELECTOR).count(), 0, '切换账号后不得显示上一账号的海报');
  assert.equal(await switchPage.locator('.result-card').count(), 0, '切换账号后不得显示上一账号的结果卡');
  result.observed.accountSwitch = {
    logoutStatus: logout,
    afterSwitchImageStatus: switched.status,
    afterSwitchCacheControl: switched.cacheControl,
    afterSwitchLandedPath: switchedLanded.pathname,
    sawPosterAfterSwitch: false,
    navigationStatus: switchedNavigation?.status() ?? null,
  };
  result.assertions.push(
    `同一浏览器 A→登出→B：B 取 A 的图片 ${switched.status}（cache-control=${switched.cacheControl}），`
    + '打开 A 的项目被挡出且页面无结果卡/海报元素',
  );

  await owner.context.close();
  await adminBrowser.context.close();
  await otherBrowser.context.close();

  // ── 失败占位：把海报请求改成必然 404，断言占位而非破图，且无无界重试 ──
  const fallbackBrowser = await loginThroughPage(browser, baseUrl, 'poster-owner', aPassword, 'fallback');
  let interceptedRequests = 0;
  await fallbackBrowser.page.route('**/api/images/**', (route) => {
    interceptedRequests += 1;
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await openVideoStep(fallbackBrowser.page, baseUrl, fixture.projectId, fixture.shotSetId, fixture.posterUrl);
  await fallbackBrowser.page.waitForSelector('[data-testid="video-poster-fallback"]', { timeout: 120_000 });
  // 等一段固定窗口，确认没有持续重发：这里是「无界重试循环」的判据。
  await fallbackBrowser.page.waitForTimeout(4000);
  const requestsDuringWait = interceptedRequests;
  await fallbackBrowser.page.waitForTimeout(4000);
  const requestsAfterWait = interceptedRequests;
  assert.equal(
    requestsAfterWait, requestsDuringWait,
    `海报失败后不得持续重试：等待期内又新增 ${requestsAfterWait - requestsDuringWait} 次请求`,
  );
  const fallbackFacts = await fallbackBrowser.page.evaluate(() => ({
    placeholder: document.querySelector('[data-testid="video-poster-fallback"]')?.textContent?.trim() ?? null,
    brokenImages: [...document.querySelectorAll('.result-thumb img[alt="视频缩略图"]')]
      .filter((image) => image.complete && image.naturalWidth === 0).length,
    remainingPosterImages: document.querySelectorAll('.result-thumb img[alt="视频缩略图"]').length,
  }));
  assert.equal(fallbackFacts.brokenImages, 0, '失败后不得留下会显示破图图标的 img');
  assert.equal(fallbackFacts.remainingPosterImages, 0, '失败后 img 必须被占位替换掉');
  assert.match(fallbackFacts.placeholder ?? '', /缩略图不可用/, '失败必须显示明确中文占位文案');
  await fallbackBrowser.page.screenshot({ path: path.join(evidenceDirectory, 'poster-fallback.png') });
  result.evidence.push('poster-fallback.png');
  result.observed.fallback = {
    ...fallbackFacts,
    posterUrl: fixture.posterUrl,
    interceptedRequests,
    requestsDuringObservationWindow: requestsAfterWait - requestsDuringWait,
  };
  result.assertions.push(
    '海报读取失败时显示「缩略图不可用」占位，DOM 中不再保留破图 img；'
    + '观察窗 4s 内新增请求 0 次（无无界重试）',
  );
  await fallbackBrowser.context.close();

  await stopServer(server);
}

/* ------------------------- local 模式验收 ------------------------- */

async function runLocalMode(browser, root, port) {
  const environment = localEnvironment(root, port);
  const fixture = seedFixture(environment, ['--mode', 'local']);
  const server = await startServer({ port, environment, label: 'local', serverMode: false });
  const baseUrl = server.baseUrl;

  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(`local: ${error.message}`));
  const responses = await openVideoStep(page, baseUrl, fixture.projectId, fixture.shotSetId, fixture.posterUrl);
  await waitPosterLoaded(page);
  const facts = await posterFacts(page);
  assert.equal(facts.complete, true, 'local 模式下海报必须加载完成');
  assert.ok(facts.naturalWidth > 0, 'local 模式下海报必须有真实宽度');
  assert.equal(facts.usesOptimiser, false, 'local 模式下也不得经过优化器（同一组件、同一契约）');
  await page.screenshot({ path: path.join(evidenceDirectory, 'local-video-step.png') });
  result.evidence.push('local-video-step.png');
  result.observed.localMode = {
    facts,
    imageRequests: responses.filter((entry) => entry.path.startsWith('/api/images/')),
  };
  result.assertions.push('local 模式下同一组件仍完整渲染海报（complete 且 naturalWidth > 0）');
  await context.close();
  await stopServer(server);
}

/* ------------------------------ 主流程 ------------------------------ */

let browser;
const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-poster-auth-server-'));
const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-poster-auth-local-'));
try {
  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();

  const serverPort = await pickPort();
  await runServerMode(browser, serverRoot, serverPort);
  const localPort = await pickPort();
  await runLocalMode(browser, localRoot, localPort);

  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理页面异常');
  result.assertions.push('浏览器无未处理 pageerror');
  result.result = 'passed';
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS: 受保护视频海报在真实会话下渲染成功（server 端口 ${serverPort}、local 端口 ${localPort}）`);
  console.log(`证据目录：${evidenceDirectory}`);
  for (const line of result.assertions) console.log(`  - ${line}`);
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(`FAIL: ${redact(result.error)}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopAllServers();
  if (!keep) {
    fs.rmSync(serverRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(localRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
