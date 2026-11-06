import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-http-'));
const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const selected = probe.address().port;
    probe.close(() => resolve(selected));
  });
});
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: String(port),
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'isolated-release-http',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: origin,
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'current-test',
  CREATIVE_STUDIO_TEAM_RELEASE_FIXTURE_UPLOAD: '1',
  CREATIVE_STUDIO_CANVAS_ENABLE: '0',
};
let child;
let logs = '';
try {
  const admin = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', '00001', '--name', '隔离管理员'], {
    env, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(admin.status, 0, admin.stdout + admin.stderr);
  const credential = admin.stdout.match(/一次性凭据（仅显示本次）：([^\s]+)/)?.[1];
  assert.ok(credential);
  const validZip = path.join(root, 'isolated-valid-release.zip');
  const fixture = path.join(root, 'fixture');
  const standalone = path.join(fixture, 'standalone');
  for (const [relative, content] of Object.entries({
    'server.js': '// isolated test server\n',
    'runtime/team-server-entry.cjs': '// isolated test runtime\n',
  })) {
    const target = path.join(standalone, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const node = path.join(fixture, 'node');
  fs.mkdirSync(node, { recursive: true });
  fs.writeFileSync(path.join(node, 'node.exe'), 'isolated test node');
  const caddy = path.join(fixture, 'caddy.exe');
  const winsw = path.join(fixture, 'winsw.exe');
  fs.writeFileSync(caddy, 'isolated test caddy');
  fs.writeFileSync(winsw, 'isolated test winsw');
  const lock = JSON.parse(fs.readFileSync('scripts/team-server/distribution-lock.json', 'utf8'));
  const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  lock.fixture = true; lock.media = [];
  lock.node.binarySha256 = sha256(path.join(node, 'node.exe'));
  lock.caddy.binarySha256 = sha256(caddy);
  lock.winsw.sha256 = sha256(winsw);
  const lockPath = path.join(fixture, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const release = path.join(fixture, 'release');
  const built = spawnSync(process.execPath, ['scripts/build-team-server.mjs',
    '--output', release, '--release-id', 'test-release', '--standalone', standalone,
    '--node-runtime', node, '--caddy-exe', caddy, '--winsw-exe', winsw, '--lock', lockPath,
    '--without-litellm', '--skip-build', '--fixture'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const directories = [release];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(absolute);
      else zip.file(path.relative(release, absolute).split(path.sep).join('/'), fs.readFileSync(absolute));
    }
  }
  fs.writeFileSync(validZip, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const next = path.resolve('node_modules/next/dist/bin/next');
  child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { logs += String(data); });
  child.stderr.on('data', (data) => { logs += String(data); });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/team/health/ready`);
      if (response.ok) break;
    } catch {}
    if (attempt === 239) throw new Error(`测试服务启动失败：${logs.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const csrfResponse = await fetch(`${origin}/api/team/auth/csrf`);
  const csrfCookie = csrfResponse.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await csrfResponse.json();
  const login = await fetch(`${origin}/api/team/auth/login`, {
    method: 'POST', headers: { Cookie: csrfCookie, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: '00001', password: credential }),
  });
  assert.equal(login.status, 200, await login.text());
  const adminSession = `${csrfCookie}; ${login.headers.get('set-cookie').split(';')[0]}`;
  const changed = await fetch(`${origin}/api/team/auth/change-password`, {
    method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: credential, newPassword: 'isolated-admin-password-11' }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const employeeCreated = await fetch(`${origin}/api/team/users`, {
    method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: '00002', displayName: '隔离员工', role: 'employee' }),
  });
  assert.equal(employeeCreated.status, 201, await employeeCreated.clone().text());
  const employee = await employeeCreated.json();
  const get = async (session = adminSession) => fetch(`${origin}/api/team/release-candidates`, {
    headers: { Cookie: session },
  });
  let response = await get('');
  assert.equal(response.status, 401, `${await response.clone().text()}\n${logs.slice(-5000)}`);
  response = await get();
  assert.equal(response.status, 200, await response.clone().text());
  const preview = await response.json();
  assert.equal(preview.current.appVersion, '0.7.1');
  assert.deepEqual(preview.candidates, []);
  assert.equal(preview.executableUpgrade, false);
  response = await fetch(`${origin}/api/team/release-candidates`, {
    method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/zip' },
    body: fs.readFileSync(path.resolve('package.json')),
  });
  assert.equal(response.status, 422, await response.clone().text());
  const failure = await response.json();
  assert.equal(failure.error, 'release_upload_rejected');
  response = await get();
  const afterFailure = await response.json();
  assert.equal(afterFailure.failures.length, 1);
  assert.equal(afterFailure.candidates.length, 0);
  response = await fetch(`${origin}/api/team/release-candidates`, {
    method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken,
      'Content-Type': 'application/zip' },
    body: Buffer.from('truncated ZIP'),
  });
  assert.notEqual(response.status, 200);
  const employeeLogin = await fetch(`${origin}/api/team/auth/login`, {
    method: 'POST', headers: { Cookie: csrfCookie, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: '00002', password: employee.credential }),
  });
  assert.equal(employeeLogin.status, 200);
  const employeeSession = `${csrfCookie}; ${employeeLogin.headers.get('set-cookie').split(';')[0]}`;
  const employeePassword = await fetch(`${origin}/api/team/auth/change-password`, {
    method: 'POST', headers: { Cookie: employeeSession, Origin: origin, 'x-csrf-token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: employee.credential, newPassword: 'isolated-employee-password-11' }),
  });
  assert.equal(employeePassword.status, 200);
  assert.equal((await get(employeeSession)).status, 403);
  assert.equal((await fetch(`${origin}/api/team/release-candidates`, {
    method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': 'forged-csrf', 'Content-Type': 'application/zip' },
    body: Buffer.from('forged'),
  })).status, 403);
  {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(validZip)], { type: 'application/zip' }), 'isolated-server-release.zip');
    response = await fetch(`${origin}/api/team/release-candidates`, {
      method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken }, body: form,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const uploaded = (await response.json()).candidate;
    assert.equal(uploaded.release.releaseId, 'test-release');
    assert.equal(uploaded.status, 'ready');
    const afterReload = await (await get()).json();
    assert.equal(afterReload.candidates[0].candidateId, uploaded.candidateId);
    assert.equal(afterReload.current.appVersion, '0.7.1');
    const duplicateForm = new FormData();
    duplicateForm.append('file', new Blob([fs.readFileSync(validZip)], { type: 'application/zip' }), 'duplicate.zip');
    response = await fetch(`${origin}/api/team/release-candidates`, {
      method: 'POST', headers: { Cookie: adminSession, Origin: origin, 'x-csrf-token': csrfToken }, body: duplicateForm,
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).candidate.duplicate, true);
    assert.equal((await (await get()).json()).candidates.length, 1, '重复上传不得新增候选');
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { logs += String(data); });
    child.stderr.on('data', (data) => { logs += String(data); });
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const restarted = await get().catch(() => null);
      if (restarted?.status === 200) {
        const restored = await restarted.json();
        assert.equal(restored.candidates[0].candidateId, uploaded.candidateId);
        assert.equal(restored.current.appVersion, '0.7.1');
        assert.equal(fs.existsSync(path.join(root, 'deployment', 'service', 'current-release.json')), false);
        break;
      }
      if (attempt === 239) throw new Error(`隔离服务重启后候选未恢复：${logs.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const page = await fetch(`${origin}/team/admin/operations`, { headers: { Cookie: adminSession } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /上传服务器升级包/);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', (error) => console.error('isolated browser error', error));
      await page.goto(`${origin}/team/login`);
      await page.getByLabel('工号').fill('00001');
      await page.getByLabel('密码或 6 位一次性密码').fill('isolated-admin-password-11');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL((url) => !url.pathname.includes('/team/login'));
      await page.goto(`${origin}/team/admin/operations`, { waitUntil: 'networkidle' });
      await page.getByLabel('选择服务器升级包').setInputFiles(validZip);
      await page.getByRole('button', { name: '上传并校验' }).click();
      await page.getByText('候选包已准备完成；尚未执行升级，当前运行版本不变。').waitFor({ timeout: 120_000 });
      assert.match(await page.locator('main').innerText(), /test-release/);
      assert.match(await page.locator('main').innerText(), /校验通过，可供后续升级复核/);
      const damaged = path.join(root, 'damaged.zip');
      const bytes = fs.readFileSync(validZip);
      bytes[bytes.length - 22] ^= 0xff;
      fs.writeFileSync(damaged, bytes);
      await page.getByLabel('选择服务器升级包').setInputFiles(damaged);
      await page.getByRole('button', { name: '上传并校验' }).click();
      await page.getByRole('alert').filter({ hasText: /ZIP|校验|损坏/ }).waitFor({ timeout: 120_000 });
      await page.reload();
      await page.getByText('校验通过，可供后续升级复核').waitFor();
      assert.match(await page.locator('main').innerText(), /最近失败的上传/);
    } finally {
      await browser.close();
    }
  }
  console.log('team release candidate HTTP permission, preview and rejection tests passed');
} catch (error) {
  console.error('HTTP assertions or fixture failed:', error, logs.slice(-6000));
  throw error;
} finally {
  const { closeDb } = await import('../lib/db.ts');
  closeDb();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
