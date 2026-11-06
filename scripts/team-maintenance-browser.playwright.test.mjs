import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import Database from 'better-sqlite3';
import { writeReleaseManifest } from './team-server/distribution.mjs';

// 仅隔离数据根：真实管理员 UI -> 业务 API -> 独立 worker -> 完整备份；不安装/停止 SCM。
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const nextBinary = createRequire(import.meta.url).resolve('next/dist/bin/next');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-browser-'));
const dataRoot = path.join(fixture, 'data-root');
const backupRoot = path.join(fixture, 'backup-root');
const deploymentRoot = path.join(fixture, 'deployment-root');
const releaseRoot = path.join(deploymentRoot, 'releases', 'release-maintenance-browser');
const configRoot = path.join(deploymentRoot, 'config');
const serviceRoot = path.join(deploymentRoot, 'service');
const deploymentId = 'deployment-maintenance-browser';
const password = `Admin-${randomBytes(12).toString('base64url')}`;
const children = new Set();
let browser;
let serverOutput = '';
function write(relative, content) {
  const target = path.join(releaseRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function releaseFixture() {
  write('app/server.js', '// fixture\n');
  write('runtime/process-tree.mjs', '// fixture\n');
  const node = write('runtimes/node/node.exe', 'fixture node');
  const caddy = write('tools/caddy/caddy.exe', 'fixture caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'fixture winsw');
  const lock = JSON.parse(fs.readFileSync(path.resolve('scripts/team-server/distribution-lock.json'), 'utf8'));
  const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  Object.assign(lock, { fixture: true, media: [] });
  lock.node.binarySha256 = sha256(node); lock.caddy.binarySha256 = sha256(caddy); lock.winsw.sha256 = sha256(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync(path.resolve('scripts/packaging/forbidden-paths.json'), 'utf8'));
  write('START-HERE.md', '# isolated fixture\n'); write('deployment.example.json', '{"schemaVersion":1}\n');
  writeReleaseManifest(releaseRoot, { releaseId: 'release-maintenance-browser', appVersion: '0.7.1', sourceCommit: 'fixture', fixture: true });
}
function launch(executable, args, env) {
  const child = spawn(executable, args, { cwd: repoRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
  child.stderr.on('data', (chunk) => { serverOutput += String(chunk); });
  return child;
}
async function stopChildren() {
  const exits = [];
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    exits.push(new Promise((resolve) => child.once('close', resolve)));
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  }
  await Promise.all(exits);
  children.clear();
}
async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, NEXT_TELEMETRY_DISABLED: '1', CREATIVE_STUDIO_DATA_ROOT: dataRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_PORT: String(port), CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
  CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl, CREATIVE_STUDIO_MAINTENANCE_DEPLOYMENT_ROOT: deploymentRoot,
  CREATIVE_STUDIO_MAINTENANCE_BACKUP_ROOT: backupRoot, CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
};
try {
  releaseFixture();
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(serviceRoot, { recursive: true });
  const configPath = path.join(configRoot, 'maintenance-deployment.json');
  const config = {
    schemaVersion: 1, deploymentId, releaseId: 'release-maintenance-browser', deploymentRoot, dataRoot, backupRoot,
    oldRoots: [path.join(fixture, 'old-root')], origin: 'https://studio.example.test', appPort: port, liteLLMPort: port + 1,
    servicePrefix: 'CreativeStudioMaintenanceTest', serviceAccount: 'NT AUTHORITY\\NetworkService',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'], enableLiteLLM: false, stopTimeoutSeconds: 240,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(serviceRoot, 'current-release.json'), JSON.stringify({
    schemaVersion: 1, releaseId: config.releaseId,
    packageSha256: createHash('sha256').update(fs.readFileSync(path.join(releaseRoot, 'release-manifest.json'))).digest('hex'),
    switchedAt: new Date().toISOString(),
  }));
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', '00042', '--name', '真实网页管理员'], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /一次性凭据/);
  const initializedCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)[1];
  const server = launch(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], env);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`隔离 Next 服务退出：${serverOutput.slice(-2000)}`);
    try { if ((await fetch(`${baseUrl}/api/team/health/ready`)).status === 200) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal((await fetch(`${baseUrl}/api/team/health/ready`)).status, 200, serverOutput.slice(-3000));
  launch(process.execPath, ['scripts/team-server/maintenance.mjs', 'worker', '--config', configPath, '--allow-fixture-release'], env);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('input[autocomplete="username"]').fill('00042');
  await page.locator('input[autocomplete="current-password"]').fill(initializedCredential);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '设置新密码', exact: true }).waitFor({ timeout: 60_000 });
  await page.locator('input[autocomplete="current-password"]').fill(initializedCredential);
  await page.locator('input[autocomplete="new-password"]').first().fill(password);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(password);
  await page.getByRole('button', { name: '保存新密码并进入' }).click();
  await page.getByText('密码已修改，请使用新密码重新登录。', { exact: true }).waitFor();
  await page.locator('input[autocomplete="username"]').fill('00042');
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 60_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await page.goto(`${baseUrl}/team/admin/operations`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: '备份与维护', exact: true }).waitFor();
  const employee = await page.evaluate(async () => {
    const csrf = await (await fetch('/api/team/auth/csrf')).json();
    const created = await fetch('/api/team/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
      body: JSON.stringify({ employeeId: '00001', displayName: '维护权限员工', role: 'employee' }),
    });
    return { status: created.status, body: await created.json() };
  });
  assert.equal(employee.status, 201);
  await page.getByRole('button', { name: '立即备份', exact: true }).click();
  await page.getByRole('region', { name: '立即备份', exact: true }).getByText('发起人：真实网页管理员', { exact: false }).waitFor({ timeout: 30_000 });
  await page.getByText('成功 · 备份完成', { exact: true }).waitFor({ timeout: 120_000 });
  const job = await page.evaluate(async () => (await (await fetch('/api/team/maintenance/jobs')).json()).jobs[0]);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.progress, null);
  const jobId = job.id;
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${baseUrl}/team/admin/operations`, { waitUntil: 'networkidle', timeout: 60_000 });
  await reopened.getByText('成功 · 备份完成', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal((await reopened.evaluate(async () => (await (await fetch('/api/team/maintenance/jobs')).json()).jobs[0].id)), jobId);
  const backups = await reopened.evaluate(async () => (await (await fetch('/api/team/maintenance/backups')).json()).backups);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].type, 'manual');
  assert.equal(backups[0].verification, 'verified');
  assert.equal(backups[0].restorable, true);
  const backupDb = new Database(path.join(backupRoot, 'manual', backups[0].id, 'data', 'workbench.db'), { readonly: true });
  try {
    assert.equal(backupDb.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(backupDb.prepare("SELECT displayName FROM team_users WHERE employeeId = '00042'").pluck().get(), '真实网页管理员');
  } finally { backupDb.close(); }
  const restorePanel = reopened.getByRole('region', { name: '整套业务还原', exact: true });
  await restorePanel.getByText('当前实际状态：当前业务数据', { exact: true }).waitFor();
  await restorePanel.locator('#restore-backup').selectOption(`manual/${backups[0].id}`);
  await restorePanel.getByText('还原点之后新增／修改的数据', { exact: false }).waitFor();
  await restorePanel.getByRole('checkbox').check();
  await restorePanel.getByRole('button', { name: '保存当前状态并准备隔离还原', exact: true }).click();
  await restorePanel.getByRole('heading', { name: '隔离还原已校验，等待管理员确认切换', exact: true }).waitFor({ timeout: 120_000 });
  const preparedJobs = await reopened.evaluate(async () => (await (await fetch('/api/team/maintenance/jobs')).json()).jobs);
  const prepared = preparedJobs.find((item) => item.action === 'restore.execute');
  assert.equal(prepared.status, 'awaiting_confirmation');
  assert.ok(prepared.result.preRestoreBackupId);
  assert.equal(prepared.result.reconciliation.scheduling, false);
  assert.equal(prepared.result.reconciliation.automaticRetries, 0);
  const preparedDb = new Database(path.join(dataRoot, 'data', 'workbench.db'), { readonly: true });
  try {
    assert.equal(preparedDb.prepare('SELECT maintenance, productionPaused FROM team_service_state WHERE id = 1').get().maintenance, 1);
    assert.equal(preparedDb.prepare('SELECT productionPaused FROM team_service_state WHERE id = 1').pluck().get(), 1);
  } finally { preparedDb.close(); }
  await reopened.reload({ waitUntil: 'networkidle' });
  await restorePanel.getByRole('heading', { name: '隔离还原已校验，等待管理员确认切换', exact: true }).waitFor();
  fs.writeFileSync(path.join(backupRoot, 'manual', backups[0].id, 'evidence', 'execution-journal.jsonl'), 'tampered');
  await reopened.reload({ waitUntil: 'networkidle' });
  await reopened.getByText('未通过，待核查', { exact: true }).waitFor({ timeout: 30_000 });
  const tampered = await reopened.evaluate(async () => (await (await fetch('/api/team/maintenance/backups')).json()).backups);
  assert.equal(tampered.find((item) => item.type === 'manual' && item.id === backups[0].id)?.restorable, false);
  assert.deepEqual(errors, []);
  const fixtureDb = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  try {
    const adminId = fixtureDb.prepare("SELECT id FROM team_users WHERE employeeId = '00042'").pluck().get();
    fixtureDb.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('cleanup-provider', '隔离供应商', 'http://127.0.0.1')").run();
    fixtureDb.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('cleanup-browser-project', '清理隔离项目', 'cleanup-provider', 'test', 'test')").run();
    fixtureDb.prepare(`INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility, rootType, rootId, createdAt, updatedAt
    ) VALUES ('project', 'cleanup-browser-project', ?, 'private', 'project', 'cleanup-browser-project', '2026-01-01', '2026-01-01')`).run(adminId);
    fixtureDb.prepare(`INSERT INTO team_uploads (
      id, userId, targetResourceType, targetResourceId, usage, relativeName, mimeType,
      expectedSize, expectedSha256, sourceFingerprint, partSize, idempotencyKey, state, fileId, createdAt, updatedAt
    ) VALUES ('browser-failed-upload', ?, 'project', 'cleanup-browser-project', 'input', 'failed.part', 'application/octet-stream',
      4, ?, 'browser-fingerprint', 1024, 'browser-upload', 'failed', 'browser-file', '2026-01-01', '2026-01-01')`)
      .run(adminId, '0'.repeat(64));
  } finally { fixtureDb.close(); }
  const temporaryDirectory = path.join(dataRoot, 'storage', 'team-staging', 'browser-failed-upload', 'parts');
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  fs.writeFileSync(path.join(temporaryDirectory, '1.part'), '1234');
  await reopened.getByRole('button', { name: '扫描无用文件', exact: true }).click();
  await reopened.getByText('可清理 1 项 · 预计释放 4 B', { exact: true }).waitFor({ timeout: 30_000 });
  await reopened.getByRole('button', { name: '确认清理预览中的项目', exact: true }).click();
  await reopened.getByRole('dialog').getByRole('button', { name: '确认永久清理', exact: true }).click();
  await reopened.getByText('实际删除 1 个文件 · 实际释放 4 B · 跳过 0 项 · 失败 0 项', { exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(fs.existsSync(path.join(temporaryDirectory, '1.part')), false);
  const cleanupJob = await reopened.evaluate(async () => (await (await fetch('/api/team/maintenance/jobs')).json()).jobs.find((job) => job.action === 'cleanup.execute'));
  await reopened.reload({ waitUntil: 'networkidle' });
  await reopened.getByText(`发起人：真实网页管理员 · 作业：${cleanupJob.id}`, { exact: true }).waitFor({ timeout: 30_000 });
  assert.deepEqual(errors, []);
  const employeeContext = await browser.newContext({ locale: 'zh-CN' });
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle' });
  await employeePage.locator('input[autocomplete="username"]').fill('00001');
  await employeePage.locator('input[autocomplete="current-password"]').fill(employee.body.credential);
  await employeePage.getByRole('button', { name: '登录', exact: true }).click();
  await employeePage.getByRole('heading', { name: '设置新密码', exact: true }).waitFor();
  await employeePage.locator('input[autocomplete="current-password"]').fill(employee.body.credential);
  await employeePage.locator('input[autocomplete="new-password"]').first().fill('employee-password');
  await employeePage.locator('input[autocomplete="new-password"]').nth(1).fill('employee-password');
  await employeePage.getByRole('button', { name: '保存新密码并进入' }).click();
  await employeePage.getByText('密码已修改，请使用新密码重新登录。', { exact: true }).waitFor();
  await employeePage.locator('input[autocomplete="username"]').fill('00001');
  await employeePage.locator('input[autocomplete="current-password"]').fill('employee-password');
  await employeePage.getByRole('button', { name: '登录', exact: true }).click();
  await employeePage.waitForURL((url) => url.pathname !== '/team/login');
  await employeePage.goto(`${baseUrl}/team/admin/operations`, { waitUntil: 'networkidle' });
  assert.equal(new URL(employeePage.url()).pathname, '/', '员工必须被管理员维护页重定向');
  const denied = await employeePage.evaluate(async () => {
    const response = await fetch('/api/team/maintenance/jobs');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'admin_required');
  await employeeContext.close();
  console.log(`team maintenance real browser to worker passed; job=${jobId}; isolated backup verified, tamper rejected, employee denied`);
} catch (error) {
  try {
    const jobStore = new Database(path.join(backupRoot, 'maintenance-control', 'jobs.db'), { readonly: true });
    console.error('isolated maintenance jobs', jobStore.prepare('SELECT id,status,stage,errorJson,reviewReason FROM maintenance_jobs').all());
    jobStore.close();
  } catch (stateError) { console.error('job state unavailable', stateError); }
  console.error(serverOutput.slice(-5000));
  throw error;
} finally {
  if (browser) await browser.close();
  await stopChildren();
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
