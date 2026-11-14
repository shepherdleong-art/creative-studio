// Run after a current production build:
// node scripts/server-performance-browser.acceptance.mjs --standalone <payload> --evidence <new-directory>
// Real authenticated app, real batch executor, synthetic H.264, held loopback vision provider.
// All writes use mkdtemp data; Node and browser deny external connections. No paid calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import { createUiAcceptanceApi } from './team-server/ui-acceptance-fixtures.mjs';

const repo = process.cwd();
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const payload = path.resolve(arg('--standalone', '.next/standalone'));
const evidence = path.resolve(arg('--evidence', 'outputs/05-日志与排查/2026-11-15-server-performance-browser-acceptance'));
assert.ok(fs.existsSync(path.join(payload, 'server.js')), 'Build the current standalone payload first');
assert.ok(!fs.existsSync(path.join(evidence, 'result.json')), 'Use a fresh evidence directory; keep previous results');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-combined-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
register(pathToFileURL(path.join(repo, 'scripts/typescript-extension-loader.mjs')).href, import.meta.url);
const fromRepo = (file) => import(pathToFileURL(path.join(repo, file)).href);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const result = {
  sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
  fixtureScriptSha256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
  payloadBuildId: fs.readFileSync(path.join(payload, '.next/BUILD_ID'), 'utf8').trim(),
  startedAt: new Date().toISOString(), timezone: 'Asia/Singapore', assertions: [], requests: [],
  seeks: [], pageErrors: [], networkFailures: [], mediaRequests: [], realPaidProviderCalls: 0,
  fixture: { cards: 100, historyRecords: 600, snapshotBytes: 65536, mockProvider: 'held loopback vision response' },
  isolatedDataRoot: true, cleanup: {}, viewport: { width: 1536, height: 864 },
};
const log = [];
let server, browser, context, previewPage, tasksPage, db, held;
let mockCalls = 0;
const mock = http.createServer((request, response) => {
  request.resume();
  mockCalls += 1;
  held = response;
  response.on('close', () => { if (held === response) held = null; });
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockUrl = 'http://127.0.0.1:' + mock.address().port;
const reserving = net.createServer();
await new Promise(resolve => reserving.listen(0, '127.0.0.1', resolve));
const port = reserving.address().port;
await new Promise(resolve => reserving.close(resolve));
const baseUrl = 'http://127.0.0.1:' + port;
const childEnv = {
  ...process.env, NEXT_TELEMETRY_DISABLED: '1',
  NODE_OPTIONS: '--require "' + path.join(repo, 'scripts/team-server/no-external-network.cjs').replaceAll('\\', '/') + '"',
  CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: String(port), CREATIVE_STUDIO_DEPLOYMENT_ID: 'combined-browser-acceptance',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl, CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  CREATIVE_STUDIO_CANVAS_ENABLE: '0', HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
};
for (const key of Object.keys(childEnv)) {
  if (/^(CREATIVE_STUDIO_COS_|COS_|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)/.test(key)) delete childEnv[key];
}
async function until(check, description, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('Timeout: ' + description);
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? null, max: sorted.at(-1) ?? null };
}
const pass = (message) => { result.assertions.push(message); console.log('PASS: ' + message); };
try {
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'combo-admin'], {
    cwd: repo, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(credential, 'Isolated admin credential must be available');
  server = spawn(process.execPath, [path.join(payload, 'server.js')], {
    cwd: payload, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.writeFileSync(path.join(evidence, 'process-state.json'), JSON.stringify({ serverPid: server.pid, dataRoot: root, baseUrl }, null, 2));
  server.stdout.on('data', chunk => { log.push(String(chunk)); fs.appendFileSync(path.join(evidence, 'live-server.log'), String(chunk).replaceAll(root, '[isolated-data-root]')); });
  server.stderr.on('data', chunk => { log.push(String(chunk)); fs.appendFileSync(path.join(evidence, 'live-server.log'), String(chunk).replaceAll(root, '[isolated-data-root]')); });
  await until(async () => {
    if (server.exitCode !== null) throw new Error('Standalone exited: ' + log.join(''));
    try { return (await fetch(baseUrl + '/api/team/health/ready', { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  }, 'isolated production readiness', 60_000);
  const api = createUiAcceptanceApi(baseUrl);
  const admin = await api.activate('combo-admin', credential, 'ComboAdmin-acceptance-2026!');
  const employee = await api.createEmployee(admin, { employeeId: 'combo-user', displayName: '组合验收员工' });
  const session = await api.activate('combo-user', employee.credential, 'ComboEmployee-acceptance-2026!');
  const imageProvider = await api.createProvider(admin, { name: '组合验收占位图片供应商' });
  const project = await api.createProject(session, { providerId: imageProvider.id, productCode: 'COMBO-ACCEPT' });
  const batch = await api.json(session, '/api/batch-production/batches', 'POST',
    { projectId: project.id, name: '性能组合验收 · 100 卡' }, 201);
  db = new Database(path.join(root, 'data/workbench.db'));
  db.pragma('foreign_keys = ON');
  const owner = db.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get('combo-user');
  const { upsertExecutionPool, updateActorPolicy, readActorPolicy } = await fromRepo('lib/media-core/execution/pools.ts');
  for (const poolKey of ['llm:remote', 'media:remote']) upsertExecutionPool(db, {
    poolKey, kind: poolKey.startsWith('llm') ? 'remote' : 'media', capacity: 1, enabled: true,
    mappingSnapshot: { providerId: 'combo-vision', fixture: 'loopback-only' }, expectedVersion: 0,
  });
  updateActorPolicy(db, { actorId: owner, monthlyLimitMinor: null, personalConcurrency: 1,
    concurrencyMode: 'fixed', paused: false, expectedVersion: readActorPolicy(db, owner).version });
  const mediaDir = path.join(root, 'storage/batch-media', project.id);
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaPath = path.join(mediaDir, 'eight-colors.mp4');
  const colors = ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan', 'white', 'orange'];
  const graph = colors.map((color, i) => 'color=c=' + color + ':s=384x512:r=24:d=1[v' + i + ']').join(';')
    + ';' + colors.map((_, i) => '[v' + i + ']').join('') + 'concat=n=8:v=1:a=0';
  const generated = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', graph, '-c:v', 'libx264',
    '-g', '192', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaPath],
  { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.equal(generated.status, 0, generated.stderr);
  const { registerReadyTeamFile } = await fromRepo('lib/team-service/files/registry.ts');
  registerReadyTeamFile(db, { storageRoot: path.join(root, 'storage'), absolutePath: mediaPath,
    mimeType: 'video/mp4', ownerUserId: owner, references: [{ resourceType: 'project', resourceId: project.id }] });
  const { createAsset, createAnalysisVersion, setAssetCurrentAnalysis } = await fromRepo('lib/batch-production/assets.ts');
  const { createProjectScript } = await fromRepo('lib/batch-production/scripts.ts');
  const at = new Date().toISOString();
  const fingerprint = 'sha256:' + createHash('sha256').update(fs.readFileSync(mediaPath)).digest('hex');
  const location = { kind: 'managed', relativePath: path.relative(root, mediaPath).replaceAll('\\', '/') };
  const assetId = createAsset(db, { projectId: project.id, sourceKind: 'managed', locationJson: location,
    contentFingerprint: fingerprint, mediaKind: 'video',
    mediaJson: { displayName: '组合验收八色素材', durationSec: 8, width: 384, height: 512 } });
  db.prepare("INSERT INTO batch_asset_sources (id,assetId,sourceKind,locationJson,health,createdAt) VALUES ('combo-source',?,'managed',?,'healthy',?)")
    .run(assetId, JSON.stringify(location), at);
  const analysisId = createAnalysisVersion(db, { assetId, analyzerVersion: 'combo-browser-fixture', providerId: imageProvider.id,
    model: 'fixture', analysisJson: { analysisLevel: 'content', durationUs: 8_000_000, usable: true,
      scenes: [{ startUs: 0, endUs: 8_000_000, qualityScore: .9, description: '八种颜色', labels: ['产品'] }] } });
  setAssetCurrentAnalysis(db, project.id, assetId, analysisId);
  const scriptId = createProjectScript(db, project.id, { sourceKind: 'script_draft', sourceId: 'combo-script',
    title: '组合验收脚本', bodyText: '用于验证批量运行中真实浏览器预览和任务列表。', sourceVersion: '1' });
  const bv = 'combo-bv';
  db.transaction(() => {
    db.prepare("INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES (?,?,1,100,?,'frozen',?,?)")
      .run(bv, batch.id, JSON.stringify({ outputPreset: '3:4', coverTitleMode: 'none' }), at, at);
    db.prepare("UPDATE batch_productions SET currentVersionId=?,status='running',controlState='running' WHERE id=?").run(bv, batch.id);
    db.prepare("INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,colorJson,createdAt) VALUES ('combo-pool',?,?,?,'selected',?,?)")
      .run(bv, assetId, analysisId, JSON.stringify({ lutId: null }), at);
    db.prepare("INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES ('combo-ss',?,?,'组合验收脚本','浏览器合成夹具','1',100,?)").run(bv, scriptId, at);
    const plan = db.prepare("INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,createdAt) VALUES (?,?,'combo-ss',?,'{}',?,?)");
    const version = db.prepare('INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,1,?,?)');
    for (let i = 1; i <= 100; i++) {
      const id = 'combo-plan-' + i, ov = 'combo-ov-' + i;
      plan.run(id, bv, i, ov, at);
      version.run(ov, id, JSON.stringify({ preset: '3:4', productionReady: false, editRevision: 0,
        clips: [{ clipId: 'clip-' + i, assetId, sourceStartUs: 0, sourceEndUs: 8_000_000, timelineStartUs: 0, timelineEndUs: 8_000_000 }],
        cover: { assetId, timeUs: 0 }, warnings: [], blockers: [] }), at);
    }
    db.prepare("INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,enabled,isBuiltin,supportsVision,executionScope) VALUES ('combo-vision','本地等待型视觉供应商','openai-compatible','openai-compatible',?,'fixture-not-a-real-key','combo-vision',1,0,1,'external')").run(mockUrl);
    const history = db.prepare("INSERT INTO execution_operations (id,operationKey,actorId,scopeType,scopeId,module,taskId,step,inputRevision,businessAttemptId,businessAttemptNo,inputHash,inputSnapshotJson,continuationKey,providerSnapshotJson,requiredPoolsJson,quoteJson,status,readySeq,createdAt,updatedAt) VALUES (?,?,?,'project',?,'batch',?,'analyze','1',?,1,'fixture',?,'batch.analyze',?,'[]','{}','succeeded',?,?,?)");
    const snapshot = JSON.stringify({ fixture: 'x'.repeat(65536) });
    for (let i = 0; i < 600; i++) {
      const id = 'combo-history-' + i, past = new Date(Date.now() - 60_000 - i * 1000).toISOString();
      history.run(id, id, owner, project.id, id, id, snapshot, JSON.stringify({ name: '历史夹具', model: 'combo-history' }), 10000 + i, past, past);
    }
  }).immediate();
  // Fixtures retain the frozen analysis in the pool while requesting a new live analysis.
  db.prepare('UPDATE batch_assets SET currentAnalysisId=NULL WHERE id=?').run(assetId);
  const { registerInheritedScope } = await fromRepo('lib/team-service/resource-scopes.ts');
  const inherit = (resourceType, resourceId, parentType, parentId) => registerInheritedScope(db, {
    resourceType, resourceId, parent: { resourceType: parentType, resourceId: parentId },
  });
  inherit('batch_asset', assetId, 'project', project.id);
  inherit('batch_analysis', analysisId, 'batch_asset', assetId);
  inherit('batch_script', scriptId, 'project', project.id);
  inherit('batch_version', bv, 'batch', batch.id);
  for (let i = 1; i <= 100; i++) {
    inherit('batch_plan', 'combo-plan-' + i, 'batch_version', bv);
    inherit('batch_output_version', 'combo-ov-' + i, 'batch_plan', 'combo-plan-' + i);
  }
  const queued = await api.json(session, '/api/batch-production/batches/' + batch.id + '/assets/analyze?projectId=' + project.id,
    'POST', { assetIds: [assetId], mode: 'content', providerId: 'combo-vision' });
  const taskId = queued.items[0].taskId;
  console.log('Isolated batch queued: ' + JSON.stringify(queued.items));
  await until(() => {
    const task = db.prepare('SELECT status,progressJson FROM batch_tasks WHERE id=?').get(taskId);
    if (task?.status === 'failed' || task?.status === 'cancelled') {
      throw new Error('Background task ended before provider: ' + JSON.stringify(db.prepare('SELECT status,errorCode,errorMessage FROM batch_task_attempts WHERE taskId=?').all(taskId)));
    }
    return mockCalls > 0;
  }, 'real batch analysis reaches held local provider', 25_000);
  assert.equal(db.prepare('SELECT status FROM batch_tasks WHERE id=?').pluck().get(taskId), 'running');
  pass('真实批量分析执行器已运行并到达本地模拟供应商；非伪造 running 状态');
  const active = () => {
    assert.equal(db.prepare('SELECT status FROM batch_tasks WHERE id=?').pluck().get(taskId), 'running', 'Background batch must remain running during browser checks');
    assert.ok(held && !held.destroyed, 'Mock provider must still be waiting');
  };
  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();
  context = await browser.newContext({ locale: 'zh-CN', viewport: result.viewport, recordHar: {
    path: path.join(evidence, 'network.har'), content: 'omit',
  } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    result.networkFailures.push({ external: url.origin });
    return route.abort('blockedbyclient');
  });
  function observe(page, label) {
    page.on('pageerror', error => result.pageErrors.push({ page: label, message: error.message }));
    page.on('requestfinished', async request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return;
      const timing = request.timing(), response = await request.response();
      result.requests.push({ page: label, path: url.pathname, status: response?.status(),
        startTime: timing.startTime, ttfbMs: timing.responseStart, durationMs: timing.responseEnd });
      if (/preview|\/media$/.test(url.pathname)) result.mediaRequests.push({ path: url.pathname,
        status: response?.status(), ttfbMs: timing.responseStart, durationMs: timing.responseEnd });
    });
  }
  previewPage = await context.newPage();
  previewPage.setDefaultTimeout(20_000);
  observe(previewPage, 'preview');
  await previewPage.goto(baseUrl + '/team/login', { waitUntil: 'networkidle' });
  await previewPage.locator('input[autocomplete="username"]').fill('combo-user');
  await previewPage.locator('input[autocomplete="current-password"]').fill('ComboEmployee-acceptance-2026!');
  await Promise.all([previewPage.waitForURL(url => url.pathname !== '/team/login'),
    previewPage.getByRole('button', { name: '登录', exact: true }).click()]);
  const entered = performance.now();
  await previewPage.goto(baseUrl + '/projects/' + project.id + '?tab=final-edit', { waitUntil: 'domcontentloaded' });
  await previewPage.getByRole('tab', { name: '批量生产', exact: true }).click();
  await previewPage.getByRole('button', { name: '检查成片', exact: true }).click();
  await previewPage.getByTestId('batch-unified-review-screen').waitFor();
  await previewPage.getByText('成片列表 (100)', { exact: true }).waitFor();
  const ruler = previewPage.locator('[class*="rulerTrack"]').first();
  const zoom = Number(await previewPage.getByLabel('时间轴缩放').inputValue());
  async function seek(target, drag = false) {
    const started = performance.now();
    const box = await ruler.boundingBox();
    assert.ok(box && zoom > 0);
    if (drag) {
      const handle = await previewPage.locator('[class*="globalPlayheadHandle"]').first().boundingBox();
      assert.ok(handle);
      await previewPage.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await previewPage.mouse.down();
      await previewPage.mouse.move(box.x + target * zoom, handle.y + handle.height / 2, { steps: 12 });
      await previewPage.mouse.up();
    } else await previewPage.mouse.click(box.x + target * zoom, box.y + box.height / 2);
    await previewPage.waitForFunction(target => [...document.querySelectorAll('[data-media-frame="成片预览"] > video')]
      .some(video => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - Math.floor(target * 24) / 24) < .05),
    target, { timeout: 10_000 });
    const color = await previewPage.evaluate(() => {
      const canvas = document.querySelector('[data-media-frame="成片预览"] > canvas');
      return Array.from(canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data);
    });
    const expectedColors = [[253, 0, 0], [0, 254, 0], [0, 0, 254], [253, 253, 0], [254, 0, 253], [0, 254, 254], [255, 255, 255], [254, 164, 0]];
    const expected = expectedColors[Math.floor(target)];
    await expect.poll(async () => previewPage.evaluate(expected => {
      const canvas = document.querySelector('[data-media-frame="成片预览"] > canvas');
      const pixel = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return expected.every((value, i) => Math.abs(value - pixel[i]) <= 5);
    }, expected)).toBe(true);
    active();
    result.seeks.push({ targetSec: target, gesture: drag ? 'playhead-drag' : 'ruler-click',
      durationMs: performance.now() - started, observedBeforePaintSettled: color, verifiedColor: colors[Math.floor(target)] });
  }
  await seek(1.25);
  result.firstVisibleBodyFrameMs = performance.now() - entered;
  await previewPage.evaluate(() => {
    window.__comboVideoElements = [...document.querySelectorAll('[data-media-frame="成片预览"] > video')];
    window.__comboLoadingFrames = 0;
    const check = () => {
      if ([...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('正在准备视频预览'))) window.__comboLoadingFrames++;
      window.__comboRaf = requestAnimationFrame(check);
    };
    check();
  });
  await previewPage.screenshot({ path: path.join(evidence, '01-running-preview.png'), fullPage: true });
  tasksPage = await context.newPage();
  observe(tasksPage, 'tasks');
  const listStart = performance.now();
  await tasksPage.goto(baseUrl + '/team/tasks', { waitUntil: 'domcontentloaded' });
  await expect(tasksPage.getByTestId('task-row')).toHaveCount(25);
  await tasksPage.getByText('combo-vision', { exact: true }).first().waitFor();
  result.taskListVisibleMs = performance.now() - listStart;
  await tasksPage.getByTestId('task-row').filter({ hasText: 'combo-vision' }).first().click();
  await tasksPage.getByTestId('task-detail').waitFor();
  await tasksPage.getByTestId('task-detail').getByText('本地等待型视觉供应商', { exact: false }).first().waitFor();
  await tasksPage.screenshot({ path: path.join(evidence, '02-running-tasks-detail.png'), fullPage: true });
  active();
  pass('批量运行中真实任务列表显示 25 行、当前分析操作及详情，覆盖 600 条大快照历史');
  await previewPage.bringToFront();
  for (let i = 0; i < 20; i++) await seek([1.25, 4.25, 2.25, 6.25, 3.25, 5.25][i % 6], i % 3 === 2);
  await previewPage.getByRole('button', { name: '播放', exact: true }).click();
  await previewPage.waitForFunction(() => [...document.querySelectorAll('[data-media-frame="成片预览"] > video')].some(v => !v.paused && v.currentTime > .5));
  await previewPage.getByRole('button', { name: '暂停', exact: true }).click();
  const identity = await previewPage.evaluate(() => ({
    reused: window.__comboVideoElements.every((v, i) => v === document.querySelectorAll('[data-media-frame="成片预览"] > video')[i]),
    loadingFrames: window.__comboLoadingFrames, visible: !document.hidden,
  }));
  assert.equal(identity.reused, true);
  assert.equal(identity.loadingFrames, 0);
  result.previewIdentity = identity;
  pass('20 次标尺跳转/播放头拖动逐次验证八色视频像素；播放暂停成功，轮询期间不重建 video、不闪加载');
  let slowEnabled = true;
  result.routeErrors = [];
  const slow = { tasks: { active: 0, max: 0, completed: 0 }, workspace: { active: 0, max: 0, completed: 0 } };
  await previewPage.route('**/api/batch-production/batches/*/*?projectId=*', async route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!(key in slow) || !slowEnabled) return route.fallback();
    const state = slow[key]; state.active++; state.max = Math.max(state.max, state.active);
    try {
      const started = performance.now(), response = await route.fetch();
      result.requests.push({ page: 'slow-server-response', kind: key, durationMs: performance.now() - started, injectedDelayMs: 3500 });
      await sleep(3500);
      await route.fulfill({ response });
      state.completed++;
    } catch (error) {
      result.routeErrors.push({ kind: key, error: error.message });
    } finally { state.active--; }
  });
  for (let i = 0; i < 4; i++) {
    await seek(i % 2 ? 5.25 : 2.25, true);
    await sleep(2200);
  }
  await until(() => slow.tasks.completed >= 2 && slow.workspace.completed >= 2, 'two slow polling cycles');
  assert.equal(slow.tasks.max, 1); assert.equal(slow.workspace.max, 1);
  result.singleFlight = slow;
  pass('tasks/workspace 各注入 3.5 秒真实响应延迟时，同类最多一个在途，拖动仍实际出帧');
  slowEnabled = false;
  await until(() => slow.tasks.active === 0 && slow.workspace.active === 0, 'slow handlers drain');
  assert.deepEqual(result.routeErrors, []);
  await previewPage.unrouteAll({ behavior: 'wait' });
  await previewPage.screenshot({ path: path.join(evidence, '03-after-drags-and-slow-poll.png'), fullPage: true });
  active();
  const previewBeforeListRefresh = result.seeks.length;
  await Promise.all([seek(6.25, true), tasksPage.reload({ waitUntil: 'domcontentloaded' })]);
  await expect(tasksPage.getByTestId('task-row')).toHaveCount(25);
  assert.equal(result.seeks.length, previewBeforeListRefresh + 1);
  active();
  pass('任务列表重新加载与预览拖动并行成功，后台分析在全部组合操作期间持续 running');
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.networkFailures, []);
  result.seekTimingMs = stats(result.seeks.slice(1).map(item => item.durationMs));
  result.mockProviderCalls = mockCalls;
  result.backgroundRunning = db.prepare('SELECT id,status,attemptCount FROM batch_tasks WHERE id=?').get(taskId);
  result.teamTaskCount = db.prepare('SELECT COUNT(*) FROM execution_operations WHERE actorId=?').pluck().get(owner);
  const controlled = await api.json(session, '/api/batch-production/batches/' + batch.id + '/control?projectId=' + project.id,
    'POST', { action: 'stop' });
  result.stopResponse = controlled;
  assert.equal(controlled.controlState, 'stopped');
  await until(() => db.prepare('SELECT status FROM batch_tasks WHERE id=?').pluck().get(taskId) !== 'running', 'background task stops');
  result.backgroundAfterStop = db.prepare('SELECT status,expectedState FROM batch_tasks WHERE id=?').get(taskId);
  assert.equal(result.backgroundAfterStop.status, 'cancelled');
  assert.equal(mockCalls, 1, 'Only one controlled mock-provider submission is allowed');
  const observedApiErrors = result.requests.filter(request => request.path
    && /\/(?:tasks|workspace)$/.test(request.path) && request.status >= 400);
  assert.deepEqual(observedApiErrors, [], 'Task/workspace endpoints must not hide HTTP errors');
  pass('隔离批次通过正式停止接口结束，未触发重复供应商提交');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.stack ?? String(error);
  if (db?.open) result.backgroundDiagnostics = {
    tasks: db.prepare('SELECT id,status,expectedState,progressJson FROM batch_tasks').all(),
    attempts: db.prepare('SELECT status,errorCode,errorMessage FROM batch_task_attempts').all(),
    operations: db.prepare("SELECT id,status,waitReason FROM execution_operations WHERE id NOT LIKE 'combo-history-%'").all(),
  };
  if (previewPage) {
    await previewPage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-body.txt'), await previewPage.locator('body').innerText().catch(() => 'unavailable'));
  }
  process.exitCode = 1;
  console.error(result.error);
} finally {
  if (context) {
    await context.tracing.stop({ path: path.join(evidence, 'trace.zip') }).catch(() => {});
    await context.close().catch(() => {});
  }
  await browser?.close().catch(() => {});
  held?.destroy();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(10_000)]);
    if (server.exitCode === null) {
      spawnSync('taskkill.exe', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
  }
  db?.close();
  result.finishedAt = new Date().toISOString();
  if (fs.existsSync(path.join(evidence, 'process-state.json'))) fs.rmSync(path.join(evidence, 'process-state.json'));
  result.cleanup.serverExited = !server || server.exitCode !== null || server.signalCode !== null;
  assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('studio-combined-browser-'));
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); result.cleanup.dataRootRemoved = true; }
  catch (error) { result.cleanup.error = error.message; result.status = 'failed'; process.exitCode = 1; }
  fs.writeFileSync(path.join(evidence, 'server.log'), log.join('').replaceAll(root, '[isolated-data-root]'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Combined browser acceptance: ' + result.status + '; evidence: ' + evidence);
}
