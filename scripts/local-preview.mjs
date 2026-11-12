import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = path.join(root, 'outputs', 'local-preview');
const port = 3410;
const origin = 'http://127.0.0.1:' + port;
const deploymentId = 'windows-local-preview';
const credentialPath = path.join(previewRoot, 'run', 'control-credential.json');
const command = process.argv[2] || 'start';

const proxyPort = 4410;

function previewEnvironment() {
  const envFile = path.join(root, '.env.local');
  return {
    ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}),
    ...process.env,
    CREATIVE_STUDIO_DATA_ROOT: previewRoot,
    CREATIVE_STUDIO_LITELLM_PORT: String(proxyPort),
  };
}

function runGatewayScript(name, args = []) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', name), ...args,
  ], { cwd: root, env: previewEnvironment(), stdio: 'inherit', windowsHide: true, timeout: 120_000 });
}

function startGateway() {
  const configFile = path.join(root, 'config.yaml');
  if (!fs.existsSync(configFile) || !fs.existsSync(path.join(root, '.venv-litellm', 'Scripts', 'litellm.exe'))) {
    console.warn('公司网关组件缺失，请配置本机 config.yaml 和 .venv-litellm。');
    return;
  }
  // 健康门禁在数据根检查配置；预览副本始终跟随本机配置源。
  fs.copyFileSync(configFile, path.join(previewRoot, 'config.yaml'));
  const result = runGatewayScript('start-stack.ps1', ['-SkipApp', '-AppPort', String(port), '-ProxyPort', String(proxyPort)]);
  if (result.error || result.status !== 0) console.warn('公司网关启动失败，预览继续启动，请检查上方提示。');
}

function stopGateway() {
  if (!fs.existsSync(path.join(previewRoot, 'storage', 'run', 'stack.json'))) return;
  const result = runGatewayScript('stop-stack.ps1');
  if (result.error || result.status !== 0) throw new Error('本地预览的公司网关未正常停止，请重试停止入口。');
}


async function isListening() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function operation(action, body) {
  const credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (credential.deploymentId !== deploymentId || typeof credential.token !== 'string') {
    throw new Error('本地预览的控制凭据无效。');
  }
  const response = await fetch(origin + '/api/team/operations/' + action, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(body ? 130_000 : 30_000),
  });
  if (!response.ok) throw new Error('本地预览运维请求失败（HTTP ' + response.status + '）。');
  const result = await response.json();
  if (result.deploymentId !== deploymentId) throw new Error('端口被其他服务占用。');
  return result;
}

function openBrowser() {
  if (process.argv.includes('--no-open')) return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin + '/team/login'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  browser.on('error', () => console.error('请在浏览器打开 ' + origin + '/team/login'));
  browser.unref();
}

async function stop(expectedInstance) {
  if (!await isListening()) {
    stopGateway();
    console.log('本地预览已停止。');
    return;
  }
  const status = await operation('status');
  if (expectedInstance && status.instanceId !== expectedInstance) throw new Error('本地预览实例已变更。');
  await operation('shutdown', { instanceId: status.instanceId });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!await isListening()) {
      stopGateway();
      console.log('本地预览已停止。');
      return;
    }
    await delay(500);
  }
  throw new Error('本地预览正在退出，请稍后重试。');
}

function runAdminCommand(env, action) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'team-server', action + '-admin.mjs'),
    '--employee-id', '0001',
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('本地管理员初始化失败，请检查上方错误。');
}

async function start() {
  if (await isListening()) {
    await operation('status');
    console.log('本地预览已运行：' + origin);
    openBrowser();
    return;
  }
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(next)) throw new Error('缺少开发依赖，请在项目目录运行 npm ci --include=dev。');
  const instanceId = crypto.randomUUID();
  const env = {
    ...previewEnvironment(),
    CREATIVE_STUDIO_INSTANCE_ID: instanceId,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: previewRoot,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_TRUSTED_ORIGIN: origin,
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
    CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE: credentialPath,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'local-preview',
  };
  const { default: Database } = await import('better-sqlite3');
  const dbPath = path.join(previewRoot, 'data', 'workbench.db');
  let hasAdmin = false;
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_users'").get();
      hasAdmin = Boolean(table && db.prepare("SELECT 1 FROM team_users WHERE role='admin' LIMIT 1").get());
    } finally { db.close(); }
  }
  if (!hasAdmin) runAdminCommand(env, 'init');
  if (process.argv.includes('--recover-admin') && hasAdmin) runAdminCommand(env, 'recover');

  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, JSON.stringify({
    schemaVersion: 1, deploymentId, token: crypto.randomBytes(32).toString('base64url'),
  }), { mode: 0o600 });
  startGateway();
  console.log('COS：' + (['CREATIVE_STUDIO_COS_SECRET_ID', 'CREATIVE_STUDIO_COS_SECRET_KEY', 'CREATIVE_STUDIO_COS_DOMAIN'].every(key => env[key]?.trim()) ? '已配置' : '未配置完整'));
  console.log('豆包配音：' + (env.DOUBAO_TTS_API_KEY?.trim() ? '已配置' : '未配置'));
  console.log('\n林视 · 本地预览\n地址：' + origin + '\n本地管理员工号：0001\n数据目录：' + previewRoot);
  console.log('修改代码后刷新页面即可。保持此窗口开启，结束时双击“停止本地预览.cmd”。');
  console.log('忘记本地密码时，停止后运行：启动本地预览.cmd --recover-admin\n');
  const server = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  let startupError;
  server.on('error', error => { startupError = error; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await stop(instanceId);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
    }
    catch (error) { console.error(error.message); server.kill('SIGTERM'); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const deadline = Date.now() + 240_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('预览服务启动失败，请查看上方错误。');
      try {
        const response = await fetch(origin + '/api/team/health/ready', { signal: AbortSignal.timeout(5000) });
        ready = response.ok && (await response.json()).ready === true;
      } catch { /* Next 首次编译完成前继续等待。 */ }
      if (ready) break;
      await delay(1000);
    }
    if (!ready) throw new Error('预览服务在四分钟内未就绪，请检查上方错误。');
    const login = await fetch(origin + '/team/login', { signal: AbortSignal.timeout(120_000) });
    if (!login.ok) throw new Error('登录页加载失败（HTTP ' + login.status + '）。');
    await login.text();
    console.log('\n预览已就绪：' + origin + '/team/login');
    openBrowser();
    const exitCode = await exited;
    stopGateway();
    if (exitCode && !stopping) process.exitCode = exitCode;
  } catch (error) {
    await shutdown();
    throw error;
  }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('本地预览需要 Node.js 22 或更高版本。');
  if (command === 'stop') await stop();
  else if (['start', '--no-open', '--recover-admin'].includes(command)) await start();
  else throw new Error('用法：启动本地预览.cmd [--recover-admin]，或双击“停止本地预览.cmd”。');
} catch (error) {
  console.error('本地预览：' + error.message);
  process.exitCode = 1;
}
