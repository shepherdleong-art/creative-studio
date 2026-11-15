// Isolated shared-server load acceptance. No production data or provider credentials.
// node scripts/server-performance-load.acceptance.mjs --help
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
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
if (process.argv.includes('--help')) {
  console.log('node scripts/server-performance-load.acceptance.mjs --package <team-server-release> --evidence <fresh-directory> [--users 8] [--history 4000] [--assets-per-user 24] [--http-clients 24] [--duration 180] [--cold-samples 20] [--cold-concurrency 2]');
  console.log('Shared loopback production package, synthetic SQLite/media, real authenticated UI/executors, mock vision provider. Includes idle/load measurements, pause/resume, stop/late-result, crash/restart, and cleanup.');
  process.exit(0);
}
const release = path.resolve(arg('--package', 'outputs/01-服务器/发布包/team-server-performance-20261115-r1'));
const payload = path.join(release, 'app');
const evidence = path.resolve(arg('--evidence', 'outputs/05-日志与排查/2026-11-15-server-performance-load-acceptance/run-01'));
const config = { users: Number(arg('--users', 8)), history: Number(arg('--history', 4000)), assetsPerUser: Number(arg('--assets-per-user', 24)), httpClients: Number(arg('--http-clients', 24)), durationSec: Number(arg('--duration', 180)), cardsPerBatch: 100, snapshotBytes: 65536, mockDelayMs: 4000, remoteCapacity: 4, actorCapacity: 2, mediaCapacity: 2, coldSamples: Number(arg('--cold-samples', 20)), coldConcurrency: Number(arg('--cold-concurrency', 2)) };
for (const [key, value] of Object.entries(config)) assert.ok(Number.isSafeInteger(value) && value > 0, key);
assert.ok(config.coldSamples <= 40 && config.coldConcurrency <= 4);
assert.ok(config.users >= 2 && config.users <= 12 && config.httpClients <= 64 && config.durationSec <= 900 && config.history <= 12000 && config.assetsPerUser <= 64);
assert.ok(fs.existsSync(path.join(payload, 'server.js')) && fs.existsSync(path.join(release, 'release-manifest.json')));
assert.ok(!fs.existsSync(path.join(evidence, 'result.json')), 'Use a fresh result directory');
fs.mkdirSync(evidence, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
fs.copyFileSync(new URL(import.meta.url), path.join(evidence, 'executed-harness.mjs'));
for (const file of ['server-performance-load-preload.cjs', 'server-performance-load-sampler.ps1']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(evidence, file));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-acceptance-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
register(pathToFileURL(path.join(repo, 'scripts/typescript-extension-loader.mjs')).href, import.meta.url);
const fromRepo = file => import(pathToFileURL(path.join(repo, file)).href);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { startedAt: new Date().toISOString(), status: 'running', config, host: { platform: os.platform(), arch: os.arch(), node: process.version, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, sourceCommit: manifest.sourceCommit, releaseId: manifest.releaseId, manifestSha256: sha(fs.readFileSync(path.join(release, 'release-manifest.json'))), harnessSha256: sha(fs.readFileSync(new URL(import.meta.url))), assertions: [], findings: [], phases: [], browserActions: [], coldEntries: [], arrangementRequests: {}, errors: [], pageErrors: [], networkBlocks: [], controls: {}, cleanup: {}, realPaidProviderCalls: 0 };
const pass = text => { result.assertions.push(text); console.log('PASS: ' + text); };
const timings = [], samples = [], mockRecords = [], held = new Map(), workers = [], contexts = [], logs = [];
let server, sampler, browser, db, api, admin, phase = 'setup', currentHttp = 0, maxHttp = 0, maxMock = 0, mockActive = 0, round = 0;
let abortWork = false, holdInitial = true, progressTimer;
const sockets = new Set();
const mock = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(request.method, 'POST');
  const record = { id: randomUUID(), path: request.url, model: body.model, startedAt: Date.now(), delayMs: config.mockDelayMs, phase };
  mockRecords.push(record); mockActive++; maxMock = Math.max(maxMock, mockActive);
  let closed = false;
  response.on('close', () => { if (!closed) { closed = true; mockActive--; record.closedAt = Date.now(); } });
  const reply = () => {
    record.replyAttemptAt = Date.now(); record.connectionOpenAtReply = !response.destroyed;
    const output = { summary: '隔离模拟供应商：合成纯色片段', sellingPoints: ['合成素材'], semanticTags: ['产品'], scenes: [{ description: '纯色合成视频', labels: ['产品'], qualityScore: .9 }], coverFrameTimesUs: [0] };
    if (!response.destroyed) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: record.id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
      record.respondedAt = Date.now();
    }
  };
  if (/\/held-(?:stop|restart)/.test(request.url)) held.set(record.path, { response, reply, record });
  else { while (holdInitial && !response.destroyed) await sleep(100); record.delayStartedAt = Date.now(); await sleep(config.mockDelayMs + (mockRecords.length % 3) * 150); reply(); }
});
mock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockPort = mock.address().port;
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const baseUrl = 'http://127.0.0.1:' + port;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|PATH|USERPROFILE|APPDATA|LOCALAPPDATA|NUMBER_OF_PROCESSORS)$/i.test(key)));
Object.assign(childEnv, { NODE_OPTIONS: '--require "' + path.join(repo, 'scripts/server-performance-load-preload.cjs').replaceAll('\\', '/') + '"', STUDIO_LOAD_ALLOWED_PORTS: [port, mockPort].join(','), NEXT_TELEMETRY_DISABLED: '1', CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_DEPLOYMENT_ID: 'isolated-load-acceptance', CREATIVE_STUDIO_PORT: String(port), CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl, CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1', CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0', CREATIVE_STUDIO_MEDIA_CONCURRENCY: String(config.mediaCapacity), HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' });
async function until(check, label, timeout = 60_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { if (await check()) return; await sleep(100); }
  throw Error('Timeout: ' + label);
}
const batchPath = (worker, tail) => '/api/batch-production/batches/' + worker.batch.id + '/' + tail + '?projectId=' + worker.project.id;
const assetPath = (worker, asset, tail = 'preview') => '/api/batch-production/assets/' + asset + '/' + tail + '?projectId=' + worker.project.id;
function stats(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: ordered.length, p50: ordered[Math.floor(ordered.length * .5)] ?? null, p95: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * .95))] ?? null, max: ordered.at(-1) ?? null };
}
async function startServer() {
  round++;
  server = spawn(process.execPath, [path.join(payload, 'server.js')], { cwd: payload, env: { ...childEnv, STUDIO_LOAD_METRICS: path.join(evidence, 'runtime-' + round + '.jsonl') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { pid: server.pid, dataRoot: root, origin: baseUrl, mockOrigin: 'http://127.0.0.1:' + mockPort, round };
  fs.writeFileSync(path.join(evidence, 'process-state.json'), JSON.stringify(entry, null, 2));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { const text = String(bytes).replaceAll(root, '[isolated-data-root]'); logs.push(text); fs.appendFileSync(path.join(evidence, 'server-' + round + '.log'), text); });
  await until(async () => { if (server.exitCode !== null) throw Error('Isolated server exited'); try { return (await fetch(baseUrl + '/api/team/health/ready', { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 'isolated ready', 90_000);
  const stopFile = path.join(evidence, 'sampler-stop-' + round);
  sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts/server-performance-load-sampler.ps1'), '-ServerPid', String(server.pid), '-OutputPath', path.join(evidence, 'os-' + round + '.jsonl'), '-StopFile', stopFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  sampler.stderr.on('data', chunk => fs.appendFileSync(path.join(evidence, 'sampler-errors.log'), chunk));
}
async function stopServer(signal = 'SIGTERM') {
  if (sampler && sampler.exitCode === null) { fs.writeFileSync(path.join(evidence, 'sampler-stop-' + round), 'stop'); await Promise.race([new Promise(resolve => sampler.once('exit', resolve)), sleep(5000)]); if (sampler.exitCode === null) sampler.kill(); }
  if (server && server.exitCode === null) { server.kill(signal); await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(10000)]); assert.ok(server.exitCode !== null || server.signalCode !== null, 'Owned server must exit'); }
}
async function measure(session, pathname, options = {}, kind = pathname.split('?')[0]) {
  const begin = performance.now(); currentHttp++; maxHttp = Math.max(maxHttp, currentHttp);
  try {
    const response = await api.raw(session, pathname, { ...options, signal: AbortSignal.timeout(20000) });
    const ttfb = performance.now() - begin, bytes = Buffer.from(await response.arrayBuffer());
    const row = { at: Date.now(), phase, kind, status: response.status, ttfbMs: ttfb, durationMs: performance.now() - begin, bytes: bytes.length };
    timings.push(row);
    assert.ok([200, 206].includes(response.status), `${kind}: HTTP ${response.status}: ${bytes.toString('utf8', 0, 250)}`);
    return { response, bytes };
  } finally { currentHttp--; }
}
try {
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'load-admin'], { cwd: repo, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(credential);
  await startServer();
  api = createUiAcceptanceApi(baseUrl);
  admin = await api.activate('load-admin', credential, 'LoadAdmin-2026-acceptance!');
  db = new Database(path.join(root, 'data/workbench.db'));
  db.pragma('foreign_keys = ON');
  progressTimer = setInterval(() => { if (!db?.open) return; const progress = { at: new Date().toISOString(), phase, mockRequests: mockRecords.length, activeMock: mockActive, httpRequests: timings.length, browserActions: result.browserActions.length, tasks: db.prepare('SELECT status,COUNT(*) AS n FROM batch_tasks GROUP BY status').all() }; fs.writeFileSync(path.join(evidence, 'progress.json'), JSON.stringify(progress, null, 2)); console.log('PROGRESS: ' + JSON.stringify(progress)); }, 10000);
  progressTimer.unref();
  const { upsertExecutionPool, updateActorPolicy, readActorPolicy } = await fromRepo('lib/media-core/execution/pools.ts');
  const { registerReadyTeamFile } = await fromRepo('lib/team-service/files/registry.ts');
  const { createAsset, createAnalysisVersion, setAssetCurrentAnalysis } = await fromRepo('lib/batch-production/assets.ts');
  const { createProjectScript } = await fromRepo('lib/batch-production/scripts.ts');
  const { registerInheritedScope } = await fromRepo('lib/team-service/resource-scopes.ts');
  const inherit = (resourceType, resourceId, parentType, parentId) => registerInheritedScope(db, { resourceType, resourceId, parent: { resourceType: parentType, resourceId: parentId } });
  for (const poolKey of ['llm:remote', 'media:remote']) upsertExecutionPool(db, { poolKey, kind: poolKey.startsWith('llm') ? 'remote' : 'media', capacity: config.remoteCapacity, enabled: true, mappingSnapshot: { fixture: 'loopback-load-only' }, expectedVersion: 0 });
  const imageProvider = await api.createProvider(admin, { name: '隔离压测占位图片供应商' });
  const colors = ['red', 'lime', 'blue', 'yellow', 'magenta', 'cyan', 'white', 'orange'];
  const graph = colors.map((color, index) => 'color=c=' + color + ':s=384x512:r=24:d=1[v' + index + ']').join(';') + ';' + colors.map((_, index) => '[v' + index + ']').join('') + 'concat=n=8:v=1:a=0';
  const previewTemplate = path.join(root, 'eight-colors.mp4'), workTemplate = path.join(root, 'work.mp4');
  for (const [file, filter] of [[previewTemplate, graph], [workTemplate, 'color=c=red:s=160x160:r=24:d=1']]) {
    const generated = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-threads', '2', '-g', '192', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(generated.status, 0, generated.stderr);
  }
  const workBytes = fs.readFileSync(workTemplate);
  function addAsset(worker, name, preview = false) {
    const dir = path.join(root, 'storage/batch-media', worker.project.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.mp4');
    if (preview) fs.copyFileSync(previewTemplate, file);
    else { const label = Buffer.from(name + randomUUID()); const free = Buffer.alloc(8 + label.length); free.writeUInt32BE(free.length); free.write('free', 4); label.copy(free, 8); fs.writeFileSync(file, Buffer.concat([workBytes, free])); }
    const fingerprint = 'sha256:' + sha(fs.readFileSync(file));
    registerReadyTeamFile(db, { storageRoot: path.join(root, 'storage'), absolutePath: file, mimeType: 'video/mp4', ownerUserId: worker.owner, references: [{ resourceType: 'project', resourceId: worker.project.id }] });
    const location = { kind: 'managed', relativePath: path.relative(root, file).replaceAll('\\', '/') };
    const id = createAsset(db, { projectId: worker.project.id, sourceKind: 'managed', locationJson: location, contentFingerprint: fingerprint, mediaKind: 'video', mediaJson: { displayName: name, durationSec: preview ? 8 : 1, width: preview ? 384 : 160, height: preview ? 512 : 160 } });
    db.prepare('INSERT INTO batch_asset_sources (id,assetId,sourceKind,locationJson,health,createdAt) VALUES (?, ?,\'managed\',?,\'healthy\',?)').run(randomUUID(), id, JSON.stringify(location), new Date().toISOString());
    inherit('batch_asset', id, 'project', worker.project.id);
    return id;
  }
  function provider(id, endpoint) {
    db.prepare("INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,enabled,isBuiltin,supportsVision,executionScope) VALUES (?,?,'openai-compatible','openai-compatible',?,'fixture-not-a-real-key',?,1,0,1,'external')").run(id, '隔离模拟供应商 ' + id, 'http://127.0.0.1:' + mockPort + endpoint, id);
  }
  provider('held-stop', '/held-stop'); provider('held-restart', '/held-restart');
  for (let i = 0; i < config.users; i++) {
    const employeeId = 'load-user-' + i, password = 'LoadEmployee-' + i + '-2026!';
    const created = await api.createEmployee(admin, { employeeId, displayName: '隔离压测员工 ' + i });
    const session = await api.activate(employeeId, created.credential, password);
    const project = await api.createProject(session, { providerId: imageProvider.id, productCode: 'LOAD-' + i });
    const batch = await api.json(session, '/api/batch-production/batches', 'POST', { projectId: project.id, name: '隔离负载批次 ' + i }, 201);
    const owner = db.prepare('SELECT id FROM team_users WHERE employeeId=?').pluck().get(employeeId);
    const worker = { i, employeeId, password, session, project, batch, owner, assets: [], providerId: 'load-vision-' + i };
    workers.push(worker);
    updateActorPolicy(db, { actorId: owner, monthlyLimitMinor: null, personalConcurrency: config.actorCapacity, concurrencyMode: 'fixed', paused: false, expectedVersion: readActorPolicy(db, owner).version });
    provider(worker.providerId, '/worker-' + i);
    worker.previewAsset = addAsset(worker, '八色预览', true);
    const analysisId = createAnalysisVersion(db, { assetId: worker.previewAsset, analyzerVersion: 'load-preview-fixture', providerId: imageProvider.id, model: 'fixture', analysisJson: { analysisLevel: 'content', durationUs: 8000000, usable: true, scenes: [{ startUs: 0, endUs: 8000000, qualityScore: .9, description: '八色素材', labels: ['产品'] }] } });
    setAssetCurrentAnalysis(db, project.id, worker.previewAsset, analysisId);
    inherit('batch_analysis', analysisId, 'batch_asset', worker.previewAsset);
    const scriptId = createProjectScript(db, project.id, { sourceKind: 'script_draft', sourceId: 'load-script-' + i, title: '隔离负载脚本', bodyText: '合成媒体，用于隔离负载验收。', sourceVersion: '1' });
    inherit('batch_script', scriptId, 'project', project.id);
    const bv = 'load-bv-' + i, ss = 'load-ss-' + i, at = new Date().toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt) VALUES (?,?,1,100,?,'frozen',?,?)").run(bv, batch.id, JSON.stringify({ outputPreset: '3:4', coverTitleMode: 'none' }), at, at);
      db.prepare("UPDATE batch_productions SET currentVersionId=?,status='running',controlState='running' WHERE id=?").run(bv, batch.id);
      db.prepare("INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,colorJson,createdAt) VALUES (?,?,?,?,'selected',?,?)").run('load-pool-' + i, bv, worker.previewAsset, analysisId, JSON.stringify({ lutId: null }), at);
      db.prepare('INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt) VALUES (?,?,?,\'隔离负载脚本\',\'合成夹具\',\'1\',100,?)').run(ss, bv, scriptId, at);
      for (let j = 1; j <= config.cardsPerBatch; j++) {
        const plan = 'load-plan-' + i + '-' + j, version = 'load-ov-' + i + '-' + j;
        db.prepare("INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,createdAt) VALUES (?,?,?,?,'{}',?,?)").run(plan, bv, ss, j, version, at);
        db.prepare('INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,1,?,?)').run(version, plan, JSON.stringify({ preset: '3:4', productionReady: false, editRevision: 0, clips: [{ clipId: 'clip-' + i + '-' + j, assetId: worker.previewAsset, sourceStartUs: 0, sourceEndUs: 8000000, timelineStartUs: 0, timelineEndUs: 8000000 }], cover: { assetId: worker.previewAsset, timeUs: 0 }, warnings: [], blockers: [] }), at);
      }
    }).immediate();
    inherit('batch_version', bv, 'batch', batch.id);
    for (let j = 1; j <= config.cardsPerBatch; j++) { inherit('batch_plan', 'load-plan-' + i + '-' + j, 'batch_version', bv); inherit('batch_output_version', 'load-ov-' + i + '-' + j, 'batch_plan', 'load-plan-' + i + '-' + j); }
    for (let j = 0; j < config.assetsPerUser; j++) worker.assets.push(addAsset(worker, 'work-' + i + '-' + j));
  }
  const historyFingerprint = () => { const h = createHash('sha256'); for (const row of db.prepare("SELECT * FROM execution_operations WHERE id LIKE 'load-history-%' ORDER BY id").iterate()) h.update(JSON.stringify(row)); return h.digest('hex'); };
  const insertHistory = db.prepare("INSERT INTO execution_operations (id,operationKey,actorId,scopeType,scopeId,module,taskId,step,inputRevision,businessAttemptId,businessAttemptNo,inputHash,inputSnapshotJson,continuationKey,providerSnapshotJson,requiredPoolsJson,quoteJson,status,readySeq,createdAt,updatedAt) VALUES (?,?,?,'project',?,'batch',?,'analyze','1',?,1,'fixture',?,'batch.analyze',?,'[]','{}','succeeded',?,?,?)");
  const snapshot = JSON.stringify({ fixture: 'x'.repeat(config.snapshotBytes) });
  db.transaction(() => { for (let i = 0; i < config.history; i++) { const worker = workers[i % workers.length], id = 'load-history-' + i, at = new Date(Date.now() - 60000 - i * 1000).toISOString(); insertHistory.run(id, id, worker.owner, worker.project.id, id, id, snapshot, JSON.stringify({ name: '已完成隔离历史', model: 'fixture-history' }), 10000 + i, at, at); } }).immediate();
  result.historyFingerprintBefore = historyFingerprint();
  result.fixture = { users: workers.length, cards: config.users * config.cardsPerBatch, historicalOperations: config.history, historicalSnapshotBytes: Buffer.byteLength(snapshot) * config.history, queuedAssets: config.users * config.assetsPerUser, dataRoot: root, origin: baseUrl, mockOrigin: 'http://127.0.0.1:' + mockPort };
  pass('独立生产包、随机回环端口、临时数据根；隔离员工、卡片、大快照与合成媒体已准备');
  // Deliver pending socket-close events after synchronous SQLite/media fixture writes.
  await sleep(250);
  for (const worker of workers) { const response = await api.json(worker.session, '/api/team/tasks'); assert.ok(response.items.every(item => item.actorUserId === worker.owner)); assert.equal(response.pagination.total, Math.floor(config.history / config.users) + (worker.i < config.history % config.users ? 1 : 0)); }
  const denied = await api.raw(workers[0].session, batchPath(workers[1], 'workspace')); assert.ok([403, 404].includes(denied.status)); await denied.arrayBuffer();
  pass('每位员工完整历史计数准确，跨员工工作区访问被拒绝');
  const pauseWorker = { ...workers[0], batch: await api.json(workers[0].session, '/api/batch-production/batches', 'POST', { projectId: workers[0].project.id, name: '隔离暂停继续验收' }, 201) };
  await api.json(pauseWorker.session, batchPath(pauseWorker, 'control'), 'POST', { action: 'pause' });
  const pauseAssets = [addAsset(pauseWorker, 'pause-1'), addAsset(pauseWorker, 'pause-2')];
  const pauseQueued = await api.json(pauseWorker.session, batchPath(pauseWorker, 'assets/analyze'), 'POST', { assetIds: pauseAssets, mode: 'technical' });
  const pausedBefore = db.prepare('SELECT id,status,attemptCount FROM batch_tasks WHERE batchId=? ORDER BY id').all(pauseWorker.batch.id);
  await sleep(2200);
  assert.deepEqual(db.prepare('SELECT id,status,attemptCount FROM batch_tasks WHERE batchId=? ORDER BY id').all(pauseWorker.batch.id), pausedBefore);
  assert.ok(pausedBefore.every(task => task.status === 'queued' && task.attemptCount === 0));
  result.controls.pause = { queued: pauseQueued.items.length, noClaimWhilePaused: true };
  async function readKind(worker, index) {
    const kind = ['tasks', 'workspace', 'batch-tasks', 'counts', 'media-range', 'overview'][index % 6];
    const [session, pathname, options] = kind === 'tasks' ? [worker.session, '/api/team/tasks?page=1&pageSize=25', {}]
      : kind === 'workspace' ? [worker.session, batchPath(worker, 'workspace'), {}]
      : kind === 'batch-tasks' ? [worker.session, batchPath(worker, 'tasks'), {}]
      : kind === 'counts' ? [worker.session, '/api/team/workspace-counts', {}]
      : kind === 'media-range' ? [worker.session, '/api/batch-production/preview/' + worker.previewAsset + '?projectId=' + worker.project.id + '&batchId=' + worker.batch.id + '&batchVersionId=load-bv-' + worker.i, { headers: { Range: 'bytes=0-2047' } }]
      : [admin, '/api/team/console/overview', {}];
    const measured = await measure(session, pathname, options, kind);
    if (kind === 'tasks') assert.ok(JSON.parse(measured.bytes).items.every(item => item.actorUserId === worker.owner), 'Employee scope must hold under load');
    if (kind === 'media-range') { assert.equal(measured.response.status, 206); assert.equal(measured.bytes.length, 2048); }
  }
  phase = 'idle-baseline';
  const baselineStart = Date.now();
  for (let i = 0; i < 20; i++) for (let kind = 0; kind < 6; kind++) await readKind(workers[i % workers.length], kind);
  result.phases.push({ name: phase, start: baselineStart, end: Date.now() });
  pass('同一隔离数据集预热后完成各接口 20 次空闲基线采样');
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  result.browser = await browser.version();
  const polling = {}, tracked = new Map(), detailTracked = new Map();
  function observe(page, name) {
    page.on('pageerror', error => result.pageErrors.push({ page: name, error: error.message }));
    page.on('request', request => {
      if (/\/outputs\/[^/]+\/arrangement$/.test(new URL(request.url()).pathname)) {
        const detail = result.arrangementRequests[name] ??= { active: 0, max: 0, count: 0 };
        detail.active++; detail.max = Math.max(detail.max, detail.active); detail.count++; detailTracked.set(request, name);
      }
      const key = /\/api\/batch-production\/batches\/[^/]+\/(tasks|workspace)$/.exec(new URL(request.url()).pathname)?.[1];
      if (phase !== 'load' || !key) return;
      const label = name + ':' + key, state = polling[label] ??= { active: 0, max: 0, count: 0 };
      state.active++; state.max = Math.max(state.max, state.active); state.count++; tracked.set(request, label);
    });
    const finish = request => { const name = detailTracked.get(request); if (name) { result.arrangementRequests[name].active--; detailTracked.delete(request); } const label = tracked.get(request); if (label) { polling[label].active--; tracked.delete(request); } };
    page.on('requestfinished', finish); page.on('requestfailed', finish);
  }
  const expectedColors = [[253, 0, 0], [0, 254, 0], [0, 0, 254], [253, 253, 0], [254, 0, 253], [0, 254, 254], [255, 255, 255], [254, 164, 0]];
  async function seek(worker, index) {
    const target = [1.25, 4.25, 2.25, 6.25, 3.25, 5.25][index % 6], begin = performance.now(), page = worker.page;
    const ruler = page.locator('[class*="rulerTrack"]').first(), box = await ruler.boundingBox();
    const zoom = Number(await page.getByLabel('时间轴缩放').inputValue());
    assert.ok(box && zoom > 0);
    if (index % 2) {
      const handle = await page.locator('[class*="globalPlayheadHandle"]').first().boundingBox(); assert.ok(handle);
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + target * zoom, handle.y + handle.height / 2, { steps: 8 }); await page.mouse.up();
    } else await page.mouse.click(box.x + target * zoom, box.y + box.height / 2);
    await page.waitForFunction(({ target, expected }) => {
      const videos = [...document.querySelectorAll('[data-media-frame="成片预览"] > video')];
      const canvas = document.querySelector('[data-media-frame="成片预览"] > canvas');
      if (!canvas || !videos.some(video => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - Math.floor(target * 24) / 24) < .05)) return false;
      const pixel = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return expected.every((value, i) => Math.abs(value - pixel[i]) <= 5);
    }, { target, expected: expectedColors[Math.floor(target)] }, { timeout: 12000 });
    const action = { at: Date.now(), phase, employee: worker.i, target, gesture: index % 2 ? 'drag' : 'ruler-click', durationMs: performance.now() - begin, verifiedColor: colors[Math.floor(target)] };
    result.browserActions.push(action);
  }
  for (const worker of workers) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 }, recordHar: { path: path.join(evidence, 'user-' + worker.i + '.har'), content: 'omit' } }); contexts.push(context);
    if (worker.i < 2) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === baseUrl) return route.continue(); result.networkBlocks.push({ page: worker.i, origin: url.origin }); return route.abort('blockedbyclient'); });
    const page = await context.newPage(); worker.page = page; page.setDefaultTimeout(20000); observe(page, 'preview-' + worker.i);
    await page.goto(baseUrl + '/team/login', { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').fill(worker.employeeId); await page.locator('input[autocomplete="current-password"]').fill(worker.password);
    await Promise.all([page.waitForURL(url => url.pathname !== '/team/login'), page.getByRole('button', { name: '登录', exact: true }).click()]);
    const entered = performance.now();
    await page.goto(baseUrl + '/projects/' + worker.project.id + '?tab=final-edit', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '批量生产', exact: true }).click(); await page.getByRole('button', { name: '检查成片', exact: true }).click();
    await page.getByTestId('batch-unified-review-screen').waitFor(); await page.getByText('成片列表 (100)', { exact: true }).waitFor();
    await seek(worker, 0); worker.firstFrameMs = performance.now() - entered;
    await page.evaluate(() => { window.__loadVideos = [...document.querySelectorAll('[data-media-frame="成片预览"] > video')]; });
    if (worker.i < 2) { worker.tasksPage = await context.newPage(); observe(worker.tasksPage, 'tasks-' + worker.i); await worker.tasksPage.goto(baseUrl + '/team/tasks', { waitUntil: 'domcontentloaded' }); await expect(worker.tasksPage.getByTestId('task-row')).toHaveCount(25); await worker.tasksPage.getByTestId('task-row').first().click(); await worker.tasksPage.getByTestId('task-detail').waitFor(); await worker.tasksPage.screenshot({ path: path.join(evidence, 'tasks-detail-' + worker.i + '.png'), fullPage: true }); }
    await page.screenshot({ path: path.join(evidence, 'preview-start-' + worker.i + '.png'), fullPage: true });
  }
  phase = 'queue-and-warmup';
  for (const worker of workers) { worker.queuedAt = Date.now(); const queued = await api.json(worker.session, batchPath(worker, 'assets/analyze'), 'POST', { assetIds: worker.assets, mode: 'content', providerId: worker.providerId }); worker.taskIds = queued.items.map(item => item.taskId); assert.equal(worker.taskIds.length, config.assetsPerUser); }
  await until(() => mockActive >= 1, 'real analysis reaches held mock provider', 60000);
  result.initialHeldAnalysisRequests = mockActive;
  const firstProviderReply = () => mockRecords.some(record => record.respondedAt);
  assert.equal(firstProviderReply(), false, 'Initial mock gate should hold analysis lanes');
  const proxies = [];
  for (const worker of workers) { const response = await api.json(worker.session, assetPath(worker, worker.previewAsset, 'proxies'), 'POST', {}); proxies.push(response.requested[0]); }
  await until(() => proxies.some(proxy => db.prepare('SELECT attemptCount FROM batch_tasks WHERE id=?').pluck().get(proxy.taskId) > 0), 'general lane claims new proxy while analysis lanes held', 20000);
  await sleep(2500);
  result.generalLaneObservation = db.prepare('SELECT t.workType,t.status,t.attemptCount,a.status AS attemptStatus,a.progressJson FROM batch_tasks t LEFT JOIN batch_task_attempts a ON a.taskId=t.id WHERE t.workType=\'proxy_generate\'').all();
  const runtimeAtGate = fs.readFileSync(path.join(evidence, 'runtime-1.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.mediaResource).at(-1);
  result.generalLaneMediaResourceAtGate = runtimeAtGate?.mediaResource ?? null;
  assert.equal(firstProviderReply(), false);
  result.generalLaneClaimedWhileAnalysisHeld = true;
  // Each cold sample runs in a fresh browser context during the actual load
  // window, alongside the original eight workspaces and 24 HTTP clients.
  async function verifyColdEntries() {
    let nextSample = 0, coldFailed = false;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(config.coldConcurrency, config.coldSamples) }, async () => {
    while (!coldFailed) {
      const i = nextSample++;
      if (i >= config.coldSamples) return;
      const worker = workers[i % workers.length];
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 }, storageState: await contexts[worker.i].storageState(), recordHar: { path: path.join(evidence, 'cold-' + i + '.har'), content: 'omit' } });
      await context.route('**/*', route => { const url = new URL(route.request().url()); if (!['http:', 'https:'].includes(url.protocol) || url.origin === baseUrl) return route.continue(); result.networkBlocks.push({ page: 'cold-' + i, origin: url.origin }); return route.abort('blockedbyclient'); });
      const page = await context.newPage(); page.setDefaultTimeout(15000); observe(page, 'cold-' + i);
      const row = { sample: i, employee: worker.i, at: Date.now(), activeProviderRequests: mockActive, queuedAnalysisTasks: db.prepare("SELECT COUNT(*) FROM batch_tasks WHERE workType='asset_prepare' AND status IN ('queued','running')").pluck().get(), caching: 'fresh-context-routing-disables-http-cache' };
      result.coldEntries.push(row);
      try {
        const begin = performance.now();
        await page.goto(baseUrl + '/projects/' + worker.project.id + '?tab=final-edit', { waitUntil: 'domcontentloaded' });
        row.previewDocumentMs = performance.now() - begin;
        await page.getByRole('tab', { name: '批量生产', exact: true }).click();
        await page.getByRole('button', { name: '检查成片', exact: true }).click();
        await page.getByText('成片列表 (100)', { exact: true }).waitFor();
        await seek({ ...worker, page }, 0);
        row.previewFirstFrameMs = performance.now() - begin;
        const taskStart = performance.now();
        await page.goto(baseUrl + '/team/tasks', { waitUntil: 'domcontentloaded' });
        row.tasksDocumentMs = performance.now() - taskStart;
        await expect(page.getByTestId('task-row')).toHaveCount(25, { timeout: 15000 });
        row.taskListMs = performance.now() - taskStart;
        await page.getByTestId('task-row').first().click(); await page.getByTestId('task-detail').waitFor();
        row.taskDetailMs = performance.now() - taskStart;
        row.finishedAt = Date.now();
        assert.ok(row.finishedAt <= deadline, 'Cold-entry samples must finish within the actual load window');
        row.status = 'passed';
      } catch (error) {
        coldFailed = true; row.status = 'failed'; row.error = String(error);
        row.url = page.url(); row.body = await page.locator('body').innerText().catch(() => 'unavailable');
        await page.screenshot({ path: path.join(evidence, 'cold-failure-' + i + '.png') }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
  holdInitial = false;
  pass('真实分析请求等待模拟供应商时，通用 lane 已领取新代理；媒体等待与最终完成分别记录');
  await api.json(pauseWorker.session, batchPath(pauseWorker, 'control'), 'POST', { action: 'resume' });
  await until(() => db.prepare("SELECT COUNT(*) FROM batch_tasks WHERE batchId=? AND status='succeeded'").pluck().get(pauseWorker.batch.id) === 2, 'paused tasks resume and complete', 90000);
  result.controls.pause.resumedAndCompleted = true;
  pass('暂停期间未领取，正式继续后原排队任务完成');
  phase = 'load';
  const loadStart = Date.now(), deadline = loadStart + config.durationSec * 1000;
  const sampleTimer = setInterval(() => {
    try {
      const counts = db.prepare('SELECT status,COUNT(*) AS count FROM batch_tasks GROUP BY status').all();
      const remote = db.prepare("SELECT r.poolKey,COUNT(*) AS count FROM execution_reservations r WHERE r.kind='concurrency' AND r.state='held' GROUP BY r.poolKey").all();
      samples.push({ at: Date.now(), phase, counts, remote });
    } catch (error) { result.errors.push({ phase, sampler: error.message }); }
  }, 1000);
  const jobs = [verifyColdEntries()];
  for (let i = 0; i < config.httpClients; i++) jobs.push((async () => { let index = i; while (!abortWork && Date.now() < deadline) { await readKind(workers[i % workers.length], index++); await sleep(250); } })());
  for (const worker of workers) jobs.push((async () => { let index = 1; while (!abortWork && Date.now() < deadline) { await seek(worker, index++); if (worker.tasksPage && index % 3 === 0) { const start = performance.now(); await worker.tasksPage.goto(baseUrl + '/team/tasks', { waitUntil: 'domcontentloaded' }); await expect(worker.tasksPage.getByTestId('task-row')).toHaveCount(25, { timeout: 15000 }); result.browserActions.push({ at: Date.now(), phase, employee: worker.i, gesture: 'task-list-open', durationMs: performance.now() - start }); await worker.tasksPage.getByTestId('task-row').first().click(); await worker.tasksPage.getByTestId('task-detail').waitFor(); } await sleep(800); } })());
  const outcomes = await Promise.allSettled(jobs);
  clearInterval(sampleTimer);
  for (const outcome of outcomes) if (outcome.status === 'rejected') result.errors.push({ phase, error: outcome.reason.stack || String(outcome.reason) });
  if (result.errors.length) result.findings.push({ code: 'load_client_errors', errors: result.errors });
  result.coldEntryMetrics = { previewFirstFrameMs: stats(result.coldEntries.map(row => row.previewFirstFrameMs)), taskListMs: stats(result.coldEntries.map(row => row.taskListMs)), taskDetailMs: stats(result.coldEntries.map(row => row.taskDetailMs)) };
  if (result.coldEntries.length === config.coldSamples && result.coldEntries.every(row => row.status === 'passed')) pass('实际负载窗内，' + config.coldSamples + ' 个全新上下文冷进入预览、任务列表和详情通过');
  result.phases.push({ name: phase, start: loadStart, end: Date.now() });
  result.polling = polling; result.maxConcurrentHttpClients = maxHttp;
  if (!Object.values(polling).every(state => state.max <= 1)) result.findings.push({ code: 'overlapping_polling', polling });
  for (const worker of workers) {
    assert.equal(await worker.page.evaluate(() => window.__loadVideos.every((video, i) => video === document.querySelectorAll('[data-media-frame="成片预览"] > video')[i])), true);
    await worker.page.screenshot({ path: path.join(evidence, 'preview-after-load-' + worker.i + '.png'), fullPage: true });
  }
  if (result.pageErrors.length) result.findings.push({ code: 'browser_page_errors', errors: result.pageErrors });
  assert.deepEqual(result.networkBlocks, []);
  pass('共享实例多员工负载观察窗已结束；浏览器、接口和轮询异常另按 findings 记录');
  phase = 'drain';
  await until(() => {
    const failed = db.prepare("SELECT id,status FROM batch_tasks WHERE status IN ('failed','cancelled')").all();
    if (failed.length) throw Error('Unexpected load task failure: ' + JSON.stringify(failed));
    return db.prepare("SELECT COUNT(*) FROM batch_tasks WHERE status<>'succeeded'").pluck().get() === 0;
  }, 'all load tasks and proxies complete', 600000);
  assert.equal(mockRecords.filter(record => /\/worker-/.test(record.path)).length, config.users * config.assetsPerUser, 'Every main task must submit exactly once');
  assert.ok(maxMock <= config.remoteCapacity);
  result.perEmployeeExecution = workers.map(worker => { const requests = mockRecords.filter(record => record.path.startsWith('/worker-' + worker.i + '/')); return { employee: worker.i, submitted: requests.length, firstProviderRequestMsFromEnqueue: requests.length ? requests[0].startedAt - worker.queuedAt : null, sentBeforeLoadEnd: requests.filter(record => record.startedAt <= deadline).length, repliesBeforeLoadEnd: requests.filter(record => record.respondedAt && record.respondedAt <= deadline).length, completedAtMsFromEnqueue: requests.length ? Math.max(...requests.map(record => record.respondedAt ?? 0)) - worker.queuedAt : null }; });
  result.mainTasks = { submitted: config.users * config.assetsPerUser, completed: config.users * config.assetsPerUser, providerRequests: mockRecords.length, maxProviderConcurrent: maxMock, proxyTasksCompleted: proxies.length };
  pass('全部真实分析与代理任务完成，每个分析只提交一次，模拟供应商并发未超过 4');
  const stopWorker = { ...workers[0], batch: await api.json(workers[0].session, '/api/batch-production/batches', 'POST', { projectId: workers[0].project.id, name: '隔离停止迟到验收' }, 201) };
  const stopAsset = addAsset(stopWorker, 'stop-late');
  const stopQueued = await api.json(stopWorker.session, batchPath(stopWorker, 'assets/analyze'), 'POST', { assetIds: [stopAsset], mode: 'content', providerId: 'held-stop' });
  await until(() => [...held.keys()].some(key => key.startsWith('/held-stop/')), 'held stop request');
  const stopEntry = [...held.values()].find(entry => entry.record.path.startsWith('/held-stop/'));
  const stopStart = performance.now();
  const stopped = await api.json(stopWorker.session, batchPath(stopWorker, 'control'), 'POST', { action: 'stop' });
  assert.equal(stopped.controlState, 'stopped'); stopEntry.reply();
  await until(() => db.prepare('SELECT status FROM batch_tasks WHERE id=?').pluck().get(stopQueued.items[0].taskId) === 'cancelled', 'stop cancels running task');
  assert.equal(db.prepare('SELECT currentAnalysisId FROM batch_assets WHERE id=?').pluck().get(stopAsset), null);
  result.controls.stop = { cancelled: true, lateResultPublished: false, connectionOpenAtReply: stopEntry.record.connectionOpenAtReply, durationMs: performance.now() - stopStart, mockRequests: mockRecords.filter(record => record.path.startsWith('/held-stop/')).length };
  assert.equal(result.controls.stop.mockRequests, 1);
  pass('正式停止后尝试释放模拟迟到响应，任务取消且未发布分析结果');
  phase = 'restart';
  const restartWorker = { ...workers[1], batch: await api.json(workers[1].session, '/api/batch-production/batches', 'POST', { projectId: workers[1].project.id, name: '隔离重启防重验收' }, 201) };
  const restartAsset = addAsset(restartWorker, 'restart-held');
  const restartQueued = await api.json(restartWorker.session, batchPath(restartWorker, 'assets/analyze'), 'POST', { assetIds: [restartAsset], mode: 'content', providerId: 'held-restart' });
  await until(() => mockRecords.some(record => record.path.startsWith('/held-restart/')), 'restart request actually sent');
  const recoveryAssets = Array.from({ length: 16 }, (_, i) => addAsset(restartWorker, 'restart-unsent-' + i));
  const recoveryQueued = await api.json(restartWorker.session, batchPath(restartWorker, 'assets/analyze'), 'POST', { assetIds: recoveryAssets, mode: 'technical' });
  const beforeCrash = db.prepare('SELECT id,status,attemptCount FROM batch_tasks WHERE batchId=? ORDER BY id').all(restartWorker.batch.id);
  assert.ok(beforeCrash.some(task => task.status === 'queued'), 'Crash scenario needs persisted queued work');
  const oldPid = server.pid, restartStart = performance.now();
  server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); await stopServer();
  await sleep(1000);
  await startServer();
  await until(() => recoveryQueued.items.every(item => db.prepare('SELECT status FROM batch_tasks WHERE id=?').pluck().get(item.taskId) === 'succeeded'), 'persisted unsent tasks recover', 120000);
  await sleep(5000);
  const restartProviderRequests = mockRecords.filter(record => record.path.startsWith('/held-restart/')).length;
  const restartedTask = db.prepare('SELECT status,attemptCount FROM batch_tasks WHERE id=?').get(restartQueued.items[0].taskId);
  const recoveryOperation = db.prepare("SELECT o.id,o.taskId,o.status,o.inputRevision,o.businessAttemptId,o.businessAttemptNo,o.operationKey,o.currentAttemptId,a.submissionState FROM execution_operations o LEFT JOIN execution_attempts a ON a.id=o.currentAttemptId WHERE o.taskId=? ORDER BY o.createdAt").all(restartQueued.items[0].taskId);
  assert.ok(recoveryOperation.some(operation => operation.status === 'unknown'), 'Sent interrupted execution must retain uncertainty');
  assert.notEqual(restartedTask.status, 'succeeded');
  result.controls.restart = { oldPid, newPid: server.pid, durationMs: performance.now() - restartStart, queuedAtCrash: beforeCrash.filter(task => task.status === 'queued').length, unsentTasksCompleted: recoveryQueued.items.length, uncertainTask: restartedTask, uncertainOperations: recoveryOperation, providerRequestsBeforeAndAfter: restartProviderRequests, duplicateSubmissions: restartProviderRequests - 1 };
  // A second forced restart must still retain the original remote intent.
  server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); await stopServer();
  await startServer(); await sleep(5000);
  result.controls.restart.secondRestartPid = server.pid;
  result.controls.restart.providerRequestsAfterSecondRestart = mockRecords.filter(record => record.path.startsWith('/held-restart/')).length;
  assert.equal(result.controls.restart.providerRequestsAfterSecondRestart, 1, 'Two restarts must not create another provider request');
  const afterSecond = db.prepare('SELECT id,inputRevision,businessAttemptId,businessAttemptNo,operationKey,status FROM execution_operations WHERE taskId=?').all(restartQueued.items[0].taskId);
  assert.equal(afterSecond.length, 1);
  assert.equal(afterSecond[0].id, recoveryOperation[0].id);
  assert.equal(afterSecond[0].status, 'unknown');
  result.controls.restart.afterSecondRestart = afterSecond;
  await seek(workers[0], 5);
  const afterRestartList = await api.json(workers[0].session, '/api/team/tasks'); assert.ok(afterRestartList.items.every(item => item.actorUserId === workers[0].owner));
  if (restartProviderRequests !== 1) {
    result.findings.push({ code: 'restart_duplicate_provider_submission', severity: 'P1', taskId: restartQueued.items[0].taskId, providerRequests: restartProviderRequests, operations: recoveryOperation });
    console.error('FAIL: restart resubmitted the same uncertain task ' + restartProviderRequests + ' times in total');
  } else pass('重启后已发请求保留 unknown，未重复提交');
  pass('重启后未发送任务恢复完成，原浏览器重新取帧和列表成功');
  for (const worker of [stopWorker, restartWorker, ...workers]) await api.json(worker.session, batchPath(worker, 'control'), 'POST', { action: 'stop' });
  // Fetch abortion completes before Playwright receives requestfailed. A keyed
  // workspace remount may therefore show three current reads plus three retiring
  // reads in the transport event log; the loader regression checks three current.
  result.arrangementConcurrency = { currentLoaderLimit: 3, transportLimitIncludingRetiring: 6 };
  assert.ok(Object.values(result.arrangementRequests).every(row => row.max <= 6), 'Arrangement transport must remain bounded across aborted workspace replacements');
  result.integrity = db.pragma('integrity_check', { simple: true }); assert.equal(result.integrity, 'ok');
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_operations WHERE id LIKE 'load-history-%' AND status='succeeded' AND length(inputSnapshotJson)=?").pluck().get(Buffer.byteLength(snapshot)), config.history);
  result.historicalRecordsPreserved = config.history;
  result.historyFingerprintAfter = historyFingerprint(); assert.equal(result.historyFingerprintAfter, result.historyFingerprintBefore);
  result.firstFrameMs = stats(workers.map(worker => worker.firstFrameMs));
  result.metrics = {};
  for (const name of ['idle-baseline', 'load']) {
    const rows = timings.filter(row => row.phase === name), byKind = {};
    for (const kind of new Set(rows.map(row => row.kind))) { const matched = rows.filter(row => row.kind === kind); byKind[kind] = { ttfbMs: stats(matched.map(row => row.ttfbMs)), durationMs: stats(matched.map(row => row.durationMs)), responseBytes: matched.reduce((sum, row) => sum + row.bytes, 0), errors: matched.filter(row => row.status >= 400).length }; }
    const measuredPhase = result.phases.find(item => item.name === name);
    result.metrics[name] = { byKind, totalRequests: rows.length, requestsPerSec: rows.length / ((measuredPhase.end - measuredPhase.start) / 1000), totalResponseBytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
  }
  result.metrics.previewSeekMs = stats(result.browserActions.filter(action => action.phase === 'load' && action.verifiedColor).map(action => action.durationMs));
  result.metrics.taskListOpenMs = stats(result.browserActions.filter(action => action.gesture === 'task-list-open').map(action => action.durationMs));
  result.mockServiceMs = stats(mockRecords.filter(record => record.respondedAt && record.delayStartedAt).map(record => record.respondedAt - record.delayStartedAt));
  result.budgets = { apiReadP95Ms: 3000, previewSeekP95Ms: 5000, httpErrors: 0, duplicateProviderSubmissions: 0, note: 'Predefined acceptance budgets for this synthetic profile, not a production SLA.' };
  if (!Object.values(result.metrics.load.byKind).every(item => item.ttfbMs.n >= 20 && item.ttfbMs.p95 <= result.budgets.apiReadP95Ms && item.errors === 0)) result.findings.push({ code: 'read_api_budget_exceeded', metrics: result.metrics.load.byKind });
  if (!(result.metrics.previewSeekMs.n >= 20 && result.metrics.previewSeekMs.p95 <= result.budgets.previewSeekP95Ms)) result.findings.push({ code: 'seek_budget_exceeded', metrics: result.metrics.previewSeekMs });
  pass('指标与预设门槛已比较，完整历史哈希与数据库完整性保持');
  result.status = result.findings.length ? 'failed' : 'passed';
  if (result.status === 'failed') process.exitCode = 1;
} catch (error) {
  abortWork = true; result.status = 'failed'; result.error = error.stack || String(error); result.errorCause = error.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code } : null; result.serverAtFailure = server ? { pid: server.pid, exitCode: server.exitCode, signalCode: server.signalCode } : null; process.exitCode = 1; console.error(result.error);
  if (db?.open) {
    const diagnostics = { tasks: db.prepare('SELECT id,projectId,batchId,workType,status,expectedState,attemptCount,progressJson FROM batch_tasks').all(), attempts: db.prepare('SELECT taskId,status,errorCode,errorMessage FROM batch_task_attempts').all(), operations: db.prepare("SELECT id,taskId,status,waitReason,currentAttemptId FROM execution_operations WHERE id NOT LIKE 'load-history-%'").all() };
    fs.writeFileSync(path.join(evidence, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  }
  for (const worker of workers.slice(0, 2)) if (worker.page) { await worker.page.screenshot({ path: path.join(evidence, 'failure-' + worker.i + '.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(evidence, 'failure-body-' + worker.i + '.txt'), await worker.page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  clearInterval(progressTimer);
  for (let i = 0; i < contexts.length; i++) { if (i < 2) await contexts[i].tracing.stop({ path: path.join(evidence, 'trace-' + i + '.zip') }).catch(() => {}); await contexts[i].close().catch(() => {}); }
  await browser?.close().catch(() => {});
  await stopServer().catch(error => { result.cleanup.serverError = error.message; result.status = 'failed'; process.exitCode = 1; });
  for (const socket of sockets) socket.destroy(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  db?.close();
  result.cleanup.serverExited = !server || server.exitCode !== null || server.signalCode !== null;
  result.cleanup.browserClosed = !browser || !browser.isConnected();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('studio-load-acceptance-'));
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); result.cleanup.dataRootRemoved = true; } catch (error) { result.cleanup.dataRootRemoved = false; result.cleanup.error = error.message; result.status = 'failed'; process.exitCode = 1; }
  const runtime = [], operatingSystem = [];
  for (let i = 1; i <= round; i++) for (const [filename, destination] of [['runtime-' + i + '.jsonl', runtime], ['os-' + i + '.jsonl', operatingSystem]]) if (fs.existsSync(path.join(evidence, filename))) for (const line of fs.readFileSync(path.join(evidence, filename), 'utf8').trim().split(/\r?\n/)) if (line) destination.push(JSON.parse(line));
  result.runtime = { samples: runtime.length, peakNodeRssBytes: Math.max(0, ...runtime.filter(row => row.memory).map(row => row.memory.rss)), intervalEventLoopP95Ms: stats(runtime.filter(row => row.eventLoopMs).map(row => row.eventLoopMs.p95)), blockedConnections: runtime.filter(row => row.event === 'blocked-network') };
  result.osIo = { samples: operatingSystem.length, semantics: 'Windows per-process logical I/O transfer counters for the main server, includes native SQLite; excludes FFmpeg and browser child processes and is not physical disk bytes.', processes: [...new Set(operatingSystem.map(row => row.pid))].map(pid => { const rows = operatingSystem.filter(row => row.pid === pid); return { pid, samples: rows.length, readBytes: rows.at(-1).readBytes - rows[0].readBytes, writeBytes: rows.at(-1).writeBytes - rows[0].writeBytes, peakWorkingSetBytes: Math.max(...rows.map(row => row.workingSet)), cpuSec: ((rows.at(-1).kernel100ns + rows.at(-1).user100ns) - (rows[0].kernel100ns + rows[0].user100ns)) / 1e7 }; }) };
  if (result.status === 'passed' && (!result.osIo.samples || !result.runtime.samples)) { result.status = 'failed'; result.error = 'Required OS/runtime metrics were not captured'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(evidence, 'http-timings.json'), JSON.stringify(timings, null, 2)); fs.writeFileSync(path.join(evidence, 'task-samples.json'), JSON.stringify(samples, null, 2)); fs.writeFileSync(path.join(evidence, 'mock-requests.json'), JSON.stringify(mockRecords, null, 2));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');

  if (fs.existsSync(path.join(evidence, 'process-state.json'))) fs.unlinkSync(path.join(evidence, 'process-state.json'));
  console.log('Isolated load acceptance: ' + result.status + '; evidence: ' + evidence);
}
