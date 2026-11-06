import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import ffmpegPath from 'ffmpeg-static';
import { summarizeRequests } from './team-server/acceptance-lib.mjs';
import { runProductionScenario } from './team-server/production-scenario.mjs';

const repoRoot = process.env.TEAM_ACCEPTANCE_RELEASE_PATH ? path.resolve(fileURLToPath(new URL('..', import.meta.url))) : process.cwd();
const releaseRoot = process.env.TEAM_ACCEPTANCE_RELEASE_PATH ? path.resolve(process.env.TEAM_ACCEPTANCE_RELEASE_PATH) : null;
const appRoot = releaseRoot ? path.join(releaseRoot, 'app') : repoRoot;
const nodeExecutable = releaseRoot ? path.join(releaseRoot, 'runtimes', 'node', 'node.exe') : process.execPath;
const packagedRelease = releaseRoot ? JSON.parse(fs.readFileSync(path.join(releaseRoot, 'release-manifest.json'), 'utf8')) : null;
const root = fs.mkdtempSync(process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT
  ? path.join(path.resolve(process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT), 'creative-studio-team-acceptance-http-')
  : path.join(os.tmpdir(), 'creative-studio-team-acceptance-http-'));
const resultPath = process.env.TEAM_ACCEPTANCE_RESULT_PATH;
const evidenceDirectory = process.env.TEAM_ACCEPTANCE_EVIDENCE_DIR;
if (!resultPath || !evidenceDirectory) throw new Error('HTTP 验收必须指定独立结果与证据目录');
if (process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT) fs.mkdirSync(path.resolve(process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT), { recursive: true });
fs.mkdirSync(evidenceDirectory, { recursive: true });
const users = Number(process.env.TEAM_ACCEPTANCE_USERS ?? 20);
const concurrency = Number(process.env.TEAM_ACCEPTANCE_CONCURRENCY ?? 20);
const durationSeconds = Number(process.env.TEAM_ACCEPTANCE_DURATION_SECONDS ?? 10);
const requestDelayMs = Number(process.env.TEAM_ACCEPTANCE_REQUEST_DELAY_MS ?? 25);
const sampleIntervalMs = Number(process.env.TEAM_ACCEPTANCE_SAMPLE_INTERVAL_MS ?? 1000);
const largeFileMiB = Number(process.env.TEAM_ACCEPTANCE_LARGE_FILE_MIB ?? 8);
const apiP95Target = Number(process.env.TEAM_ACCEPTANCE_API_P95_MS ?? 2000);
const acceptP95Target = Number(process.env.TEAM_ACCEPTANCE_ACCEPT_P95_MS ?? 3000);
const serverErrorRateTarget = Number(process.env.TEAM_ACCEPTANCE_5XX_RATE_BELOW ?? 0.001);
const deploymentId = 'deployment-team-acceptance-http';
const productionScenario = process.env.TEAM_ACCEPTANCE_PRODUCTION === '1';
let schedulersEnabled = false;
const passwordByEmployee = new Map();
const secrets = new Set();
const requests = [];
const assertions = [];
const processSamples = [];
const dbSamples = [];
let server = null;
let serverOutput = '';
let serverPid = null;
let baseUrl = '';
let port = 0;
let browser = null;
let mediaBuild = null;
let dbProbe = null;
let monitor = null;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
const result = {
  schemaVersion: 1,
  config: { users, concurrency, durationSeconds, requestDelayMs, sampleIntervalMs, largeFileMiB },
  realPaidProviderCalls: 0,
  runtime: releaseRoot ? 'packaged-standalone' : 'next-dev',
  releaseId: packagedRelease?.releaseId ?? 'team-acceptance-local',
  sourceCommit: packagedRelease?.sourceCommit ?? null,
  fakeProvider: true,
  capacityDurationTargetMet: durationSeconds >= 3600,
  capacitySignoff: false,
  assertions,
  evidence: ['http/server.log'],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sanitize(text) {
  let safe = String(text).split(root).join('[isolated-data-root]');
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/(?:__Host-team_(?:session|csrf))=[^\s;]+/g, '[redacted-cookie]');
}
async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const selected = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return selected;
}
function environment() {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    ...(releaseRoot ? { NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port) } : {}),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${path.join(repoRoot, 'scripts', 'team-server', 'no-external-network.cjs').replaceAll('\\', '/')}"`,
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: packagedRelease?.releaseId ?? 'team-acceptance-local',
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: productionScenario ? 'company' : 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: schedulersEnabled ? '1' : '0',
  };
}
function startServer() {
  const nextBinary = fileURLToPath(import.meta.resolve('next/dist/bin/next'));
  server = spawn(nodeExecutable, releaseRoot ? [path.join(appRoot, 'runtime', 'team-server-entry.cjs')] : [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: appRoot,
    env: environment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverPid = server.pid;
  const capture = (chunk) => {
    serverOutput += String(chunk);
    fs.appendFileSync(path.join(evidenceDirectory, 'live-server.log'), sanitize(String(chunk)));
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, sleep(10_000)]);
  server = null;
  serverPid = null;
}
async function waitReady() {
  const deadline = Date.now() + 120_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`隔离 Next 服务提前退出 ${server.exitCode}: ${sanitize(serverOutput).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch { /* startup wait */ }
    await sleep(250);
  }
  throw new Error(`隔离 Next 服务 readiness 超时，最后状态 ${lastStatus}: ${sanitize(serverOutput).slice(-4000)}`);
}
function cookiePair(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, '认证响应必须设置 cookie');
  return value.split(';', 1)[0];
}
async function request(session, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('Cookie', session.cookies.join('; '));
    headers.set('Origin', baseUrl);
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
  }
  if (!headers.has('x-creative-studio-client-version')) headers.set('x-creative-studio-client-version', '0.7.1');
  if (!headers.has('x-creative-studio-client-api')) headers.set('x-creative-studio-client-api', '1');
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const { json, ...init } = options;
  return fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(120_000),
    ...init,
    headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}
async function jsonRequest(session, pathname, options = {}, expected = null) {
  const response = await request(session, pathname, options);
  if (expected !== null) assert.equal(response.status, expected, `${options.method ?? 'GET'} ${pathname}: ${await response.clone().text()}`);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}
async function login(employeeId, password) {
  const csrfResponse = await request(null, '/api/team/auth/csrf');
  assert.equal(csrfResponse.status, 200);
  const csrfCookie = cookiePair(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const loginResponse = await fetch(`${baseUrl}/api/team/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf,
    },
    body: JSON.stringify({ employeeId, password }),
  });
  assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
  const sessionCookie = cookiePair(loginResponse);
  return { employeeId, csrf, cookies: [csrfCookie, sessionCookie] };
}
async function changePassword(session, currentPassword, newPassword) {
  await jsonRequest(session, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword, newPassword },
  }, 200);
  // Password changes revoke every previous session by contract; establish a fresh one.
  return login(session.employeeId, newPassword);
}
function recordRequest(kind, started, status) {
  requests.push({ kind, status, durationMs: performance.now() - started });
}
async function timedRequest(session, kind, pathname, options = {}) {
  const started = performance.now();
  const response = await request(session, pathname, options);
  recordRequest(kind, started, response.status);
  await response.arrayBuffer();
  return response;
}
async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function makeMedia() {
  if (!ffmpegPath) throw new Error('真实 FFmpeg 不可用');
  const mediaPath = path.join(evidenceDirectory, 'acceptance-source.mp4');
  const generated = spawnSync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x480:rate=24',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-y', mediaPath,
  ], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr?.slice(-2000));
  const encodedSourceBytes = fs.statSync(mediaPath).size;
  const minimumBytes = largeFileMiB * 1024 * 1024;
  if (encodedSourceBytes < minimumBytes) fs.truncateSync(mediaPath, minimumBytes);
  mediaBuild = { encodedSourceBytes, trailingPaddingBytes: Math.max(0, minimumBytes - encodedSourceBytes) };
  assert.ok(fs.statSync(mediaPath).size > 1024 * 1024, '真实临时媒体必须大于 1 MiB 并形成多分片');
  return mediaPath;
}
async function uploadMedia(session, otherSession, projectId, mediaPath, delivery = false) {
  const size = fs.statSync(mediaPath).size;
  const expectedSha256 = await sha256File(mediaPath);
  const partSize = 1024 * 1024;
  const created = await jsonRequest(session, '/api/team/uploads', {
    method: 'POST',
    json: {
      targetKind: delivery ? null : 'batch_asset', targetScope: { resourceType: 'project', resourceId: projectId },
      usage: delivery ? 'output' : 'batch_asset', relativeName: delivery ? '验收/交付媒体.mp4' : '验收/真实临时媒体.mp4', mimeType: 'video/mp4',
      expectedSize: size, expectedSha256, sourceFingerprint: 'acceptance-source-v1',
      idempotencyKey: delivery ? 'acceptance-delivery-v1' : 'acceptance-video-v1', partSize,
    },
  }, 200);
  const uploadId = created.body.uploadId;
  assert.ok(created.body.missingParts.length > 1);
  const fd = fs.openSync(mediaPath, 'r');
  try {
    const parts = [...created.body.missingParts].reverse();
    for (const partNumber of parts) {
      const start = (partNumber - 1) * partSize;
      const bytes = Buffer.alloc(Math.min(partSize, size - start));
      fs.readSync(fd, bytes, 0, bytes.length, start);
      await jsonRequest(session, `/api/team/uploads/${uploadId}/parts/${partNumber}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      }, 200);
      if (partNumber === parts[0]) {
        await jsonRequest(session, `/api/team/uploads/${uploadId}/parts/${partNumber}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
        }, 200);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const cross = await request(otherSession, `/api/team/uploads/${uploadId}/parts/1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1),
  });
  assert.equal(cross.status, 404);
  const completed = await jsonRequest(session, `/api/team/uploads/${uploadId}/complete`, {
    method: 'POST', json: { expectedSha256 },
  }, 200);
  const replay = await jsonRequest(session, `/api/team/uploads/${uploadId}/complete`, { method: 'POST', json: {} }, 200);
  assert.equal(replay.body.file.fileId, completed.body.file.fileId);
  assert.equal(replay.body.resultResourceId, completed.body.resultResourceId);
  result.media = {
    ...mediaBuild,
    ffmpeg: path.basename(ffmpegPath),
    byteSize: size,
    partSize,
    partCount: Math.ceil(size / partSize),
    sha256: expectedSha256,
    uploadIdHash: createHash('sha256').update(uploadId).digest('hex').slice(0, 16),
  };
  if (!delivery) assertions.push('真实 FFmpeg 媒体经乱序、重复多分片和重复 complete 只发布一个业务实体');
  return { uploadId, file: completed.body.file, expectedSha256 };
}
async function registerDevice(session, suffix) {
  return (await jsonRequest(session, '/api/team/devices', {
    method: 'POST', json: { clientDeviceId: `acceptance-${suffix}`, displayName: `验收设备 ${suffix}`, platform: 'win32-x64' },
  }, 200)).body;
}
async function downloadManifest(session, deviceId) {
  return (await jsonRequest(session, `/api/team/downloads?deviceId=${encodeURIComponent(deviceId)}`, {}, 200)).body;
}
let sampleInFlight = false;
async function sampleServer() {
  if (!serverPid) return;
  const at = Date.now();
  let processInfo = null;
  if (process.platform === 'win32') {
    const command = `
      function Get-Tree($parent) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue | ForEach-Object {
          $_.ProcessId
          Get-Tree $_.ProcessId
        }
      }
      $ids = @(${serverPid}) + @(Get-Tree ${serverPid})
      $items = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
      [pscustomobject]@{
        CPU = ($items | Measure-Object -Property CPU -Sum).Sum
        WorkingSet64 = ($items | Measure-Object -Property WorkingSet64 -Sum).Sum
        HandleCount = ($items | Measure-Object -Property HandleCount -Sum).Sum
        ProcessCount = $items.Count
      } | ConvertTo-Json -Compress
    `;
    const sampled = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill(); resolve({ status: null, stdout, stderr }); }, 5000);
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', (error) => { clearTimeout(timeout); resolve({ status: null, stdout, stderr: String(error) }); });
      child.once('exit', (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    });
    if (sampled.status === 0 && sampled.stdout.trim()) {
      const value = JSON.parse(sampled.stdout.trim());
      processInfo = {
        cpuTotalSeconds: value.CPU,
        workingSetBytes: value.WorkingSet64,
        handleCount: value.HandleCount,
        processCount: value.ProcessCount,
      };
    } else {
      throw new Error(`进程树采样失败：${sampled.stderr || sampled.status}`);
    }
  }
  const previous = processSamples.at(-1);
  const sample = { at: new Date(at).toISOString(), scope: 'Next server process tree', ...processInfo };
  if (previous && processInfo?.cpuTotalSeconds !== undefined && previous.cpuTotalSeconds !== undefined) {
    sample.cpuPercent = Math.max(0, (processInfo.cpuTotalSeconds - previous.cpuTotalSeconds) * 100 / ((at - Date.parse(previous.at)) / 1000));
  }
  processSamples.push(sample);
  const stats = await fs.promises.statfs(root);
  if (dbSamples.length) dbSamples[dbSamples.length - 1].diskFreeBytes = stats.bavail * stats.bsize;
}
async function buildVersionedResourceFixtures() {
  const directory = path.join(evidenceDirectory, 'versioned-uploads');
  fs.mkdirSync(directory, { recursive: true });
  for (const kind of ['strategy', 'template', 'viral']) {
    const book = new ExcelJS.Workbook();
    if (kind === 'strategy') {
      const sheet = book.addWorksheet('产品策略');
      sheet.addRow(['型号', '产品信息']);
      sheet.addRow(['BROWSER-RESOURCE', '型号']);
      sheet.addRow(['统一名称', '品类心智', '主卖点', '差异化', '搜索词']);
      sheet.addRow(['浏览器产品', '生活', '真实卖点', '材质差异', '浏览器搜索词']);
    } else if (kind === 'template') {
      const framework = book.addWorksheet('脚本核心框架');
      framework.addRow(['视频类型', '核心结构', '适用产品', '首选钩子']);
      framework.addRow(['01 浏览器框架', '痛点+解决', '全品类', '痛点式']);
      const copy = book.addWorksheet('开头钩子文案');
      copy.addRow(['钩子类型', '核心机制', '公式', '文案示例']);
      copy.addRow(['痛点式', '共鸣', '为什么更好用', '浏览器示例']);
      const visual = book.addWorksheet('开头钩子画面（待优化）');
      visual.addRow(['核心玩法', '裂变玩法', '画面公式', '适用品类', '搭配钩子']);
      visual.addRow(['实拍', '浏览器画面', '产品→细节', '全品类', '痛点式']);
    } else {
      const sheet = book.addWorksheet('全部模板');
      sheet.addRow(['类目', '子类目', '模板名称', '标题', '参考文案', '结构拆解', '结构摘要', '模板ID', '是否私有', '脚本编号']);
      sheet.addRow(['床', '实木床', '浏览器爆文', '真实使用', '标题：真实使用\n正文：整块实木框架和静音床板，展示具体材质和使用体验。', '', '钩子>卖点>行动', 'browser-template', '否', 'J1']);
    }
    const filename = `browser-${kind}.xlsx`;
    await book.xlsx.writeFile(path.join(directory, filename));
  }
  return directory;
}
function startMetrics() {
  const dbPath = path.join(root, 'data', 'workbench.db');
  dbProbe = new Database(dbPath, { readonly: true, fileMustExist: true });
  dbProbe.pragma('busy_timeout = 0');
  eventLoop.enable();
  monitor = setInterval(() => {
    const started = performance.now();
    const sample = { at: new Date().toISOString(), busyErrors: 0, readMs: 0, walBytes: 0, dbBytes: 0, diskFreeBytes: null };
    try {
      dbProbe.prepare('SELECT COUNT(*) FROM team_users').pluck().get();
      sample.readMs = performance.now() - started;
    } catch (error) {
      sample.readMs = performance.now() - started;
      if (String(error?.code).includes('SQLITE_BUSY')) sample.busyErrors = 1;
      else sample.error = String(error?.code ?? error);
    }
    for (const [key, suffix] of [['walBytes', '-wal'], ['dbBytes', '']]) {
      const file = `${dbPath}${suffix}`;
      if (fs.existsSync(file)) sample[key] = fs.statSync(file).size;
    }
    dbSamples.push(sample);
    if (!sampleInFlight) {
      sampleInFlight = true;
      void sampleServer()
        .catch((error) => { processSamples.push({ at: new Date().toISOString(), error: String(error) }); })
        .finally(() => { sampleInFlight = false; });
    }
  }, sampleIntervalMs);
}
async function stopMetrics() {
  if (monitor) clearInterval(monitor);
  monitor = null;
  const deadline = Date.now() + 6000;
  while (sampleInFlight && Date.now() < deadline) await sleep(25);
  eventLoop.disable();
  if (dbProbe?.open) dbProbe.close();
  dbProbe = null;
  fs.writeFileSync(path.join(evidenceDirectory, 'process-samples.json'), `${JSON.stringify(processSamples, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDirectory, 'db-load-samples.json'), `${JSON.stringify(dbSamples, null, 2)}\n`);
  result.evidence.push('http/process-samples.json', 'http/db-load-samples.json');
}
async function createProject(session, index, providerId) {
  return (await jsonRequest(session, '/api/projects', {
    method: 'POST', json: {
      storeCode: 'B店', productCode: `ACCEPT-${index}`, productSubmodel: '', productionType: 'AI种草', editorName: '自动验收',
      providerId, model: 'gpt-image-2', size: '1024x1024',
    },
  }, 200)).body;
}
async function prepareCanvas(session, index) {
  const created = await jsonRequest(session, '/api/canvas', { method: 'POST', json: { name: `验收画布 ${index}` } }, 201);
  const models = await jsonRequest(session, '/api/canvas/models', {}, 200);
  const capability = models.body.models.find((model) => model.mediaKind === 'image' && model.modes.includes('text-to-image'));
  assert.ok(capability, `至少一个图片画布能力可用于不执行的受理测试：${JSON.stringify(models.body).slice(0, 4000)}`);
  const graph = {
    schemaVersion: 1,
    nodes: [{ id: 'node-1', kind: 'image-generation', position: { x: 0, y: 0 }, data: {
      title: '只受理不执行', modelKey: capability.key, generationMode: 'text-to-image', prompt: '隔离验收，不调用供应商',
      parameters: {}, references: [], referenceLabelCounter: 0,
    } }],
    edges: [],
  };
  const saved = await jsonRequest(session, `/api/canvas/${created.body.canvas.id}`, {
    method: 'PATCH', json: { graph, expectedGraphRevision: 0 },
  }, 200);
  const requestKey = `acceptance-load-${index}`;
  const plan = await jsonRequest(session, `/api/canvas/${created.body.canvas.id}/plan`, {
    method: 'POST', json: { mode: 'single', targetNodeId: 'node-1', requestKey, expectedGraphRevision: 1 },
  }, 200);
  return {
    id: created.body.canvas.id,
    runBody: {
      mode: 'single', targetNodeId: 'node-1', requestKey, expectedGraphRevision: saved.body.canvas.graphRevision,
      planFingerprint: plan.body.plan.fingerprint,
    },
  };
}

try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const initialized = spawnSync(nodeExecutable, ['scripts/team-server/init-admin.mjs', '--employee-id', 'accept-admin', '--name', '隔离管理员'], {
    cwd: appRoot, env: environment(), encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${initialized.error?.code ?? ''} ${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(adminCredential);
  secrets.add(adminCredential);
  startServer();
  await waitReady();
  assertions.push('独立 Next server 在临时 SQLite/数据根和固定回环端口完成真实启动与 readiness');

  let sessions = [];
  let projects = [];
  const canvases = [];
  let provider;
  let browserResultPath;
  let browserOutput = '';
  const initialAdmin = await login('accept-admin', adminCredential);
  const adminPassword = `Accept-admin-${randomBytes(12).toString('base64url')}`;
  secrets.add(adminPassword);
  await changePassword(initialAdmin, adminCredential, adminPassword);
  // 改密会撤销所有旧会话，包括当前设备；验收继续使用真实重新登录的新会话。
  const activeAdmin = await login('accept-admin', adminPassword);
  if (productionScenario) {
    result.production = await runProductionScenario({ root, admin: activeAdmin, jsonRequest, request, stopServer, startServer,
      waitReady, enableSchedulers: () => { schedulersEnabled = true; }, makeMedia, sessions: [], projects: [] });
  } else if (process.env.TEAM_ACCEPTANCE_TASK_HISTORY === '1') {
    provider = (await jsonRequest(activeAdmin, '/api/providers', { method: 'POST', json: {
      name: '历史场景备用图片供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-real-key', model: 'gpt-image-2', type: 'openai-compatible',
    } }, 200)).body;
    sessions = [activeAdmin];
    projects = [await createProject(sessions[0], 1, provider.id)];
    const { runProductionScenario } = await import('./team-server/production-scenario.mjs');
    result.production = await runProductionScenario({ root, admin: activeAdmin, sessions, projects, jsonRequest, request, stopServer, startServer,
      waitReady, enableSchedulers: () => { schedulersEnabled = true; }, makeMedia, taskHistoryOnly: true });
    result.taskDisplayFixture = {
      employee: { operationId: null, taskId: result.production.taskDisplay.taskId },
      otherMember: null, projectName: projects[0].name, syntheticHistoryOnly: false,
      model: result.production.taskDisplay.model, providerName: result.production.taskDisplay.providerName,
      currentProviderModel: result.production.taskDisplay.currentProviderModel,
    };
      assertions.push('真实回环 LLM 产生执行快照后修改当前模型；历史任务仍显示原模型，调用总数不变');
    await request(null, '/team/login', { headers: { Accept: 'text/html' } }).then(response => response.arrayBuffer());
    browserResultPath = path.join(evidenceDirectory, 'browser', 'browser.json');
    browser = spawn(process.execPath, ['scripts/team-acceptance-browser.playwright.test.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env, TEAM_ACCEPTANCE_BASE_URL: baseUrl, TEAM_ACCEPTANCE_EMPLOYEE_ID: 'accept-admin',
        TEAM_ACCEPTANCE_PASSWORD: adminPassword, TEAM_ACCEPTANCE_PROVIDER_ID: provider.id,
        TEAM_ACCEPTANCE_TASK_FIXTURE: JSON.stringify(result.taskDisplayFixture),
        TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR: path.join(evidenceDirectory, 'browser'), TEAM_ACCEPTANCE_BROWSER_RESULT_PATH: browserResultPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } else if (process.env.TEAM_ACCEPTANCE_TASK_HISTORY !== '1') {
  provider = (await jsonRequest(activeAdmin, '/api/providers', { method: 'POST', json: {
    name: '隔离 fake 供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-real-key',
    model: 'gpt-image-2', type: 'openai-compatible',
  } }, 200)).body;
  sessions = [];
  for (let index = 1; index <= users; index += 1) {
    const employeeId = `accept-${String(index).padStart(2, '0')}`;
    const created = await jsonRequest(activeAdmin, '/api/team/users', {
      method: 'POST', json: { employeeId, displayName: `逻辑用户 ${index}`, role: 'employee' },
    }, 201);
    const credential = created.body.credential;
    secrets.add(credential);
    const session = await login(employeeId, credential);
    const password = `Accept-user-${randomBytes(12).toString('base64url')}`;
    secrets.add(password);
    await changePassword(session, credential, password);
    const activeSession = await login(employeeId, password);
    passwordByEmployee.set(employeeId, password);
    sessions.push(activeSession);
  }
  assert.equal(new Set(sessions.map((session) => session.cookies[1])).size, users);
  assertions.push(`${users} 个员工分别经真实 HTTP 登录、改密并持有不同 session cookie`);

  projects = [];

  for (let index = 0; index < sessions.length; index += 1) {
    projects.push(await createProject(sessions[index], index + 1, provider.id));
    canvases.push(await prepareCanvas(sessions[index], index + 1));
  }
  const crossProject = await request(sessions[1], `/api/projects/${projects[0].id}`);
  assert.equal(crossProject.status, 403);
  const adminProject = await request(activeAdmin, `/api/projects/${projects[0].id}`);
  assert.equal(adminProject.status, 200);
  const unauthenticated = await request(null, '/api/projects');
  assert.equal(unauthenticated.status, 401);
  const oldClient = await request(sessions[0], '/api/font-favorites', {
    method: 'POST', json: { action: 'set', family: '验收字体', favorite: true },
    headers: { 'x-creative-studio-client-version': '0.0.1', 'x-creative-studio-client-api': '0' },
  });
  assert.equal(oldClient.status, 426);
  assertions.push('真实 HTTP 下员工跨项目 403、管理员 200、未认证 401、不兼容旧客户端写入 426');

  // Historical display fixture only: isolated SQLite, no provider execution or paid call.
  const taskFixtureDb = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    const fixtureUsers = taskFixtureDb.prepare("SELECT id, employeeId FROM team_users WHERE employeeId IN ('accept-01', 'accept-02')").all();
    const fixtureActors = Object.fromEntries(fixtureUsers.map((user) => [user.employeeId, user.id]));
    const fixtureAt = new Date().toISOString();
    const insertOperation = taskFixtureDb.prepare(`INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, configVersion, clientVersion, serverReleaseId, requiredPoolsJson,
      quoteJson, status, readySeq, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', ?, 'llm', ?, ?, 'history-r1', ?, 1, ?, ?, 'history.fixture', ?, 'history-config', '0.7.1', 'acceptance-history', '[]', ?, 'succeeded', ?, ?, ?)`);
    const insertAttempt = taskFixtureDb.prepare(`INSERT INTO execution_attempts (
      id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
      providerSnapshotJson, submissionState, terminalState, instanceId, fence, leaseOwner,
      leaseUntil, intentJournalSeq, policyVersion, accountingPeriod, currency, reservedMinor, costState, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, 'terminal', 'succeeded', 'acceptance-history', 1, 'acceptance-history', ?, 1, 1, '2026-11', 'CNY', 0, 'released', ?, ?)`);
    const addHistory = taskFixtureDb.transaction((suffix, actorId, projectId, model) => {
      const operationId = `history-operation-${suffix}`;
      const taskId = `11111111-2222-4333-8444-${suffix.padStart(12, '0')}`;
      const step = 'script-studio-generate:plan:2:polish:1';
      const provider = JSON.stringify({ name: '历史脚本供应商（fixture）', model: '当前默认模型（fixture）', apiKey: 'must-not-leak', baseUrl: 'https://must-not-leak.invalid' });
      const input = JSON.stringify({ request: { model, userPrompt: 'must-not-leak-input' }, provider: JSON.parse(provider) });
      insertOperation.run(operationId, `llm/${taskId}/${step}/history-r1`, actorId, projectId, taskId, step, `history-business-${suffix}`, `history-hash-${suffix}`, input, provider, '{"kind":"unpriced"}', 900 + Number(suffix), fixtureAt, fixtureAt);
      insertAttempt.run(`history-attempt-${suffix}`, operationId, `history-permit-${suffix}`, actorId, provider, fixtureAt, fixtureAt, fixtureAt);
      return { operationId, taskId };
    });
    result.taskDisplayFixture = {
      employee: addHistory('1', fixtureActors['accept-02'], projects[1].id, '历史脚本模型-fixture-A'),
      otherMember: addHistory('2', fixtureActors['accept-01'], projects[0].id, '其他成员模型-fixture-B'),
      projectName: projects[1].name,
      syntheticHistoryOnly: true,
      providerCalls: 0,
    };
  } finally { taskFixtureDb.close(); }
  assertions.push('隔离历史执行夹具已写入，不调用供应商；首页/任务页验证真实查询与安全投影');

  await jsonRequest(sessions[0], `/api/batch-production/batches?projectId=${encodeURIComponent(projects[0].id)}`, {}, 200);
  const firstDevice = await registerDevice(sessions[0], 'original');
  const mediaPath = await makeMedia();
  await uploadMedia(sessions[0], sessions[1], projects[0].id, mediaPath);
  const uploaded = await uploadMedia(sessions[0], sessions[1], projects[0].id, mediaPath, true);
  const secondDevice = await registerDevice(sessions[0], 'new');
  const originalDownloads = await downloadManifest(sessions[0], firstDevice.id);
  const newDownloads = await downloadManifest(sessions[0], secondDevice.id);
  assert.equal(originalDownloads.items.length, 1);
  assert.equal(newDownloads.items.length, 0, '新设备不得自动补拉历史');
  const range = await request(sessions[0], `/api/team/files/${uploaded.file.fileId}`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 1024);
  const foreignFile = await request(sessions[1], `/api/team/files/${uploaded.file.fileId}`);
  assert.equal(foreignFile.status, 404);
  const badReceipt = await request(sessions[0], '/api/team/downloads/receipts', {
    method: 'POST', json: {
      deviceId: firstDevice.id, fileId: uploaded.file.fileId, artifactVersion: uploaded.file.version,
      state: 'completed', etag: uploaded.file.etag, verifiedSha256: '0'.repeat(64),
    },
  });
  assert.notEqual(badReceipt.status, 200);
  await jsonRequest(sessions[0], '/api/team/downloads/receipts', {
    method: 'POST', json: {
      deviceId: firstDevice.id, fileId: uploaded.file.fileId, artifactVersion: uploaded.file.version,
      state: 'completed', etag: uploaded.file.etag, verifiedSha256: uploaded.expectedSha256,
    },
  }, 200);
  assert.equal((await downloadManifest(sessions[0], firstDevice.id)).items.length, 0);
  assertions.push('原设备补下、新设备不拉历史、Range 先授权、坏哈希回执拒绝且完整哈希后才完成设备回执');

  const accepted = await jsonRequest(sessions[0], `/api/canvas/${canvases[0].id}/runs`, {
    method: 'POST', json: canvases[0].runBody,
  }, 200);
  assert.equal(accepted.body.tasks.length, 1);
  const report = await jsonRequest(sessions[0], '/api/team/errors/report', {
    method: 'POST', json: { clientEventId: 'acceptance-error-1', taskId: accepted.body.tasks[0].id, stage: 'remote_submit', code: 'fixture_error', message: '隔离诊断，不含凭据' },
  }, 201);
  const ownErrors = await jsonRequest(sessions[0], '/api/team/errors', {}, 200);
  const otherErrors = await jsonRequest(sessions[1], '/api/team/errors', {}, 200);
  assert.ok(ownErrors.body.items.some((item) => item.errorId === report.body.errorId));
  assert.equal(otherErrors.body.items.some((item) => item.errorId === report.body.errorId), false);
  assertions.push('实际错误编号关联用户/任务/阶段，另一员工不可见');

  const duplicate = await login('accept-01', passwordByEmployee.get('accept-01'));
  await jsonRequest(duplicate, '/api/team/auth/logout', { method: 'POST', json: {} }, 200);
  const loggedOut = await jsonRequest(duplicate, '/api/team/auth/session', {}, 200);
  assert.equal(loggedOut.body.authenticated, false);
  assertions.push('真实 HTTP 退出会撤销当前会话且不影响另一独立会话');

  await stopServer();
  startServer();
  await waitReady();
  const recovered = await jsonRequest(sessions[0], `/api/team/uploads/${uploaded.uploadId}`, {}, 200);
  assert.equal(recovered.body.state, 'ready');
  const downloaded = await request(sessions[0], `/api/team/files/${uploaded.file.fileId}`);
  assert.equal(downloaded.status, 200);
  const hash = createHash('sha256');
  for await (const chunk of downloaded.body) hash.update(chunk);
  assert.equal(hash.digest('hex'), uploaded.expectedSha256);
  assertions.push('强制崩溃重启后会话、ready 上传与完整媒体哈希保持正确，未自动调用供应商');

  const warmupStartedAt = performance.now();
  const warmedLogin = await request(null, '/team/login', {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(warmedLogin.status, 200, `重启后登录页预热失败：${warmedLogin.status}`);
  await warmedLogin.arrayBuffer();
  result.pageWarmup = {
    pathname: '/team/login',
    status: warmedLogin.status,
    durationMs: Math.round(performance.now() - warmupStartedAt),
    timeoutMs: 120_000,
  };
  assertions.push('重启后真实 HTTP 登录页预热完成才启动 Chromium；浏览器 60s 导航阈值保持不变');

  browserResultPath = path.join(evidenceDirectory, 'browser', 'browser.json');
  browser = spawn(process.execPath, ['scripts/team-acceptance-browser.playwright.test.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEAM_ACCEPTANCE_BASE_URL: baseUrl,
      TEAM_ACCEPTANCE_EMPLOYEE_ID: process.env.TEAM_ACCEPTANCE_TASK_HISTORY === '1' ? 'accept-admin' : 'accept-02',
      TEAM_ACCEPTANCE_PASSWORD: process.env.TEAM_ACCEPTANCE_TASK_HISTORY === '1' ? adminPassword : passwordByEmployee.get('accept-02'),
      TEAM_ACCEPTANCE_ADMIN_ID: 'accept-admin',
      TEAM_ACCEPTANCE_ADMIN_PASSWORD: adminPassword,
      TEAM_ACCEPTANCE_PROVIDER_ID: provider.id,
      TEAM_ACCEPTANCE_TASK_FIXTURE: JSON.stringify(result.taskDisplayFixture),
      TEAM_ACCEPTANCE_VERSIONED_FIXTURE_DIR: await buildVersionedResourceFixtures(),
      TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR: path.join(evidenceDirectory, 'browser'),
      TEAM_ACCEPTANCE_BROWSER_RESULT_PATH: browserResultPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  browser.stdout.on('data', (chunk) => { browserOutput += String(chunk); });
  browser.stderr.on('data', (chunk) => { browserOutput += String(chunk); });
  }
  const runningBrowser = browser;
  assert.ok(runningBrowser, '浏览器进程必须已启动');
  const browserExit = await new Promise((resolve) => runningBrowser.once('exit', resolve));
  assert.equal(browserExit, 0, sanitize(browserOutput).slice(-2000));
  const browserResult = JSON.parse(fs.readFileSync(browserResultPath, 'utf8'));
  result.browser = browserResult;
  if (process.env.TEAM_ACCEPTANCE_TASK_HISTORY === '1') {
    assert.equal(browserResult.result, 'passed', '真实历史场景必须完成实际浏览器验收');
    assert.ok(browserResult.assertions.some((entry) => entry.includes('首页/任务页共享中文步骤')));
  }
  result.evidence.push('http/browser/browser.json', ...browserResult.evidence);
  assertions.push(...browserResult.assertions);

  if (process.env.TEAM_ACCEPTANCE_TASK_HISTORY !== '1') {
  startMetrics();
  const loadStarted = Date.now();
  const deadline = loadStarted + durationSeconds * 1000;
  async function loadUser(index) {
    let counter = 0;
    while (Date.now() < deadline) {
      const session = sessions[index];
      const choice = counter % 4;
      if (choice === 0) {
        const response = await timedRequest(session, 'list', '/api/projects');
        assert.equal(response.status, 200);
      } else if (choice === 1) {
        const response = await timedRequest(session, 'progress', '/api/team/tasks');
        assert.equal(response.status, 200);
      } else if (choice === 2) {
        const response = await timedRequest(session, 'edit', '/api/font-favorites', {
          method: 'POST', json: { action: 'set', family: `验收字体 ${index}`, favorite: counter % 8 === 2 },
        });
        assert.equal(response.status, 200);
      } else {
        const response = await timedRequest(session, 'accept', `/api/canvas/${canvases[index].id}/runs`, {
          method: 'POST', json: canvases[index].runBody,
        });
        assert.equal(response.status, 200, '画布任务受理/幂等重放必须保持可用');
      }
      counter += 1;
      if (requestDelayMs > 0) await sleep(requestDelayMs);
    }
  }
  await Promise.all(sessions.slice(0, concurrency).map((_, index) => loadUser(index)));
  await stopMetrics();
  result.load = summarizeRequests(requests);
  result.load.actualDurationMs = Date.now() - loadStarted;
  result.load.independentSessions = users;
  result.load.activeWorkers = Math.min(users, concurrency);
  result.load.taskAcceptMode = '每用户首次真实画布任务受理，其后同 requestKey 幂等重放；fixture 执行器，真实付费 0';
  result.load.targets = { apiP95Ms: apiP95Target, acceptP95Ms: acceptP95Target, serverErrorRateBelow: serverErrorRateTarget };
  const nonAccept = requests.filter((entry) => entry.kind !== 'accept');
  const accepts = requests.filter((entry) => entry.kind === 'accept');
  result.load.apiP95Ms = summarizeRequests(nonAccept).p95Ms;
  result.load.acceptP95Ms = summarizeRequests(accepts).p95Ms;
  result.eventLoop = {
    scope: '负载驱动进程；不是 Next 服务内部 event-loop 探针',
    p50Ms: eventLoop.percentile(50) / 1e6,
    p95Ms: eventLoop.percentile(95) / 1e6,
    maxMs: eventLoop.max / 1e6,
  };
  result.db = {
    samples: dbSamples.length,
    busyErrors: dbSamples.reduce((sum, sample) => sum + sample.busyErrors, 0),
    maxReadMs: Math.max(0, ...dbSamples.map((sample) => sample.readMs)),
    maxWalBytes: Math.max(0, ...dbSamples.map((sample) => sample.walBytes)),
    finalWalBytes: dbSamples.at(-1)?.walBytes ?? 0,
  };
  result.resources = {
    samples: processSamples.length,
    maxWorkingSetBytes: Math.max(0, ...processSamples.map((sample) => sample.workingSetBytes ?? 0)),
    maxCpuPercentProcessTree: Math.max(0, ...processSamples.map((sample) => sample.cpuPercent ?? 0)),
    minDiskFreeBytes: dbSamples.some((sample) => Number.isFinite(sample.diskFreeBytes))
      ? Math.min(...dbSamples.map((sample) => sample.diskFreeBytes).filter(Number.isFinite))
      : null,
  };
  result.violations = [];
  if ((result.load.apiP95Ms ?? Infinity) > apiP95Target) result.violations.push(`API p95 ${result.load.apiP95Ms}ms > ${apiP95Target}ms`);
  if ((result.load.acceptP95Ms ?? Infinity) > acceptP95Target) result.violations.push(`受理 p95 ${result.load.acceptP95Ms}ms > ${acceptP95Target}ms`);
  if (result.load.serverErrorRate >= serverErrorRateTarget) result.violations.push(`5xx 比例 ${result.load.serverErrorRate} 未低于 ${serverErrorRateTarget}`);
  if (result.db.busyErrors > 0) result.violations.push(`出现 ${result.db.busyErrors} 次未处理 SQLITE_BUSY`);
  assertions.push('20 独立会话完成列表/进度/编辑/画布受理混合负载，延迟、5xx、驱动 event-loop、WAL、DB busy、服务进程树 CPU/内存与磁盘均来自实际采样');
  if (durationSeconds < 3600) assertions.push(`本次为 ${durationSeconds}s 短烟测，明确不是 60 分钟容量签收`);
  assert.deepEqual(result.violations, [], '容量阈值或数据库断言失败，不能降低阈值放行');
  }
  result.result = 'passed';
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (monitor || dbProbe) await stopMetrics();
  if (browser && browser.exitCode === null) browser.kill();
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000));
  const safeResult = JSON.parse(sanitize(JSON.stringify(result)));
  fs.writeFileSync(resultPath, `${JSON.stringify(safeResult, null, 2)}\n`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(`team acceptance HTTP/browser ${result.result}: ${requests.length} measured requests, real paid calls 0`);
}
