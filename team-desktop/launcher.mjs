import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findListenerPids, waitPortReleased } from '../scripts/runtime/ports.mjs';

const execFileAsync = promisify(execFile);
const launcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(launcherRoot, '..');
const stateRelativePath = path.join('run', 'team-desktop.json');
const credentialRelativePath = path.join('run', 'control-credential.json');

export function resolveLocalTeamConfig(env = process.env) {
  const portText = env.CREATIVE_STUDIO_TEAM_LOCAL_PORT?.trim() || '3400';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CREATIVE_STUDIO_TEAM_LOCAL_PORT 必须是 1–65535 的端口');
  }
  const dataRoot = path.resolve(env.CREATIVE_STUDIO_TEAM_LOCAL_DATA_ROOT?.trim()
    || path.join(launcherRoot, 'data-root'));
  if (dataRoot === path.parse(dataRoot).root || dataRoot === repoRoot || dataRoot === launcherRoot) {
    throw new Error('本地团队数据根必须是独立子目录');
  }
  const deploymentId = env.CREATIVE_STUDIO_TEAM_LOCAL_DEPLOYMENT_ID?.trim() || 'mac-local-team';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deploymentId)) {
    throw new Error('CREATIVE_STUDIO_TEAM_LOCAL_DEPLOYMENT_ID 无效');
  }
  return {
    dataRoot,
    deploymentId,
    port,
    origin: `http://127.0.0.1:${port}`,
    statePath: path.join(dataRoot, stateRelativePath),
    credentialPath: path.join(dataRoot, credentialRelativePath),
  };
}

function loadEnvFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return {}; }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.status ?? '未知'}）`);
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, filePath);
}

function removeIfPresent(filePath) {
  try { fs.unlinkSync(filePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function serverEnvironment(config) {
  const dataEnv = loadEnvFile(path.join(config.dataRoot, '.env.local'));
  const fileEnv = Object.keys(dataEnv).length > 0 ? dataEnv : loadEnvFile(path.join(repoRoot, '.env.local'));
  return {
    ...process.env,
    ...fileEnv,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(config.port),
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_NODE: process.execPath,
    CREATIVE_STUDIO_DATA_ROOT: config.dataRoot,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(config.port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: config.deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: config.origin,
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
    CREATIVE_STUDIO_SERVER_RELEASE_ID: `mac-local-${JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version}`,
    CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE: config.credentialPath,
  };
}

function ensureHost() {
  if (process.platform !== 'darwin') throw new Error('这个启动器目前只支持 macOS');
  const major = Number(process.versions.node.split('.', 1)[0]);
  if (major !== 22 || process.arch !== 'arm64') {
    throw new Error(`本地团队构建要求 arm64 Node.js 22.x；当前为 ${process.version} ${process.arch}`);
  }
}

function ensureDependenciesAndBuild(rebuild) {
  if (!fs.existsSync(path.join(repoRoot, 'node_modules', 'better-sqlite3'))) {
    run('npm', ['ci', '--include=dev'], { cwd: repoRoot });
  }
  const electronBinary = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!fs.existsSync(electronBinary)) {
    run(process.execPath, [path.join(repoRoot, 'node_modules', 'electron', 'install.js')], {
      cwd: path.join(repoRoot, 'node_modules', 'electron'),
    });
  }
  const stamp = path.join(repoRoot, '.next', 'standalone', '.build-stamp');
  const stampCheck = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'runtime', 'build-stamp.mjs'), 'check', stamp], {
    cwd: repoRoot, stdio: 'inherit',
  });
  if (rebuild || stampCheck.status !== 0) {
    if (stampCheck.status === 2) run('npm', ['install'], { cwd: repoRoot });
    run('npm', ['run', 'build'], { cwd: repoRoot });
  }
  run('npm', ['run', 'build:desktop'], { cwd: repoRoot });
  const entry = path.join(repoRoot, '.next', 'standalone', 'runtime', 'team-server-entry.cjs');
  if (!fs.existsSync(entry)) throw new Error('团队服务器构建产物缺失');
  return { electronBinary, serverEntry: entry };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitReady(config, server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error('团队服务器提前退出，请查看 storage/logs/team-desktop-service.log');
    }
    try {
      const response = await fetch(`${config.origin}/api/team/health/ready`, {
        cache: 'no-store', signal: AbortSignal.timeout(2000),
      });
      if (response.status === 200) return;
    } catch { /* 启动期间继续等待。 */ }
    await sleep(500);
  }
  throw new Error('团队服务器 120 秒内未就绪');
}

function readCredential(config) {
  const credential = JSON.parse(fs.readFileSync(config.credentialPath, 'utf8'));
  if (credential.schemaVersion !== 1 || credential.deploymentId !== config.deploymentId
    || typeof credential.token !== 'string' || credential.token.length < 32) {
    throw new Error('本地团队控制凭据无效');
  }
  return credential.token;
}

async function operationRequest(config, action, body) {
  const token = readCredential(config);
  const response = await fetch(`${config.origin}/api/team/operations/${action}`, {
    method: action === 'shutdown' ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(action === 'shutdown' ? 130_000 : 10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`团队服务${action}失败（HTTP ${response.status}）`);
  return result;
}

async function controlledServerStop(config, expectedPid) {
  const status = await operationRequest(config, 'status');
  if (status.deploymentId !== config.deploymentId || (expectedPid && status.pid !== expectedPid)) {
    throw new Error('团队服务身份与启动记录不一致，未请求停机');
  }
  const result = await operationRequest(config, 'shutdown', { instanceId: status.instanceId });
  if (result.deploymentId !== config.deploymentId || result.instanceId !== status.instanceId) {
    throw new Error('团队服务停机响应身份不一致');
  }
  return result;
}

function stopLiteLLM(config) {
  if (!fs.existsSync(path.join(config.dataRoot, 'storage', 'run', 'stack.json'))) return;
  const result = spawnSync('bash', [path.join(repoRoot, 'scripts', 'stop-litellm.sh')], {
    cwd: repoRoot, env: serverEnvironment(config), stdio: 'inherit',
  });
  if (result.status !== 0) console.error('LiteLLM 未正常停止，请检查启动终端输出。');
}

async function signalClient(state) {
  if (!state.clientPid) return;
  const { stdout } = await execFileAsync('ps', ['-p', String(state.clientPid), '-o', 'command=']);
  const command = stdout.trim();
  if (!command.startsWith(state.clientExecutable)) {
    throw new Error('客户端 PID 已不属于本次启动，未结束该进程');
  }
  process.kill(state.clientPid, 'SIGTERM');
}

async function start(config, rebuild) {
  ensureHost();
  const { electronBinary, serverEntry } = ensureDependenciesAndBuild(rebuild);
  const listeners = await findListenerPids(config.port);
  if (listeners.length > 0) {
    throw new Error(`端口 ${config.port} 已被占用；请先运行 team-desktop/stop.command，或更换 CREATIVE_STUDIO_TEAM_LOCAL_PORT`);
  }
  fs.mkdirSync(path.join(config.dataRoot, 'storage', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(config.dataRoot, 'run'), { recursive: true });
  const env = serverEnvironment(config);

  if (!fs.existsSync(path.join(config.dataRoot, 'data', 'workbench.db'))) {
    console.log('首次运行：正在初始化本机管理员。一次性凭据只显示本次，登录后请立即修改密码。');
    run(process.execPath, [path.join(repoRoot, 'scripts', 'team-server', 'init-admin.mjs'),
      '--employee-id', '0001', '--name', '系统管理员'], { cwd: repoRoot, env });
  }

  let sidecarStarted = false;
  if (fs.existsSync(path.join(repoRoot, '.venv-litellm', 'bin', 'litellm')) && fs.existsSync(path.join(repoRoot, 'config.yaml'))) {
    const sidecar = spawnSync('bash', [path.join(repoRoot, 'scripts', 'start-litellm.sh')], {
      cwd: repoRoot, env, stdio: 'inherit',
    });
    sidecarStarted = sidecar.status === 0;
    if (!sidecarStarted) console.error('LiteLLM 未启动，公司供应商暂不可用；本地团队工作台继续启动。');
  }

  writeJson(config.credentialPath, {
    schemaVersion: 1, deploymentId: config.deploymentId, token: crypto.randomBytes(32).toString('base64url'),
  });
  const logPath = path.join(config.dataRoot, 'storage', 'logs', 'team-desktop-service.log');
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const server = spawn(process.execPath, [serverEntry], {
    cwd: path.dirname(path.dirname(serverEntry)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const state = {
    schemaVersion: 1, deploymentId: config.deploymentId, port: config.port,
    serverPid: server.pid, clientPid: null, clientExecutable: electronBinary,
  };
  writeJson(config.statePath, state);

  let client;
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      if (server.exitCode === null && server.signalCode === null) {
        try { await controlledServerStop(config, server.pid); }
        catch (error) {
          console.error(`团队服务优雅停机失败，正在结束本次启动的子进程：${error.message}`);
          server.kill('SIGTERM');
        }
      }
      if (sidecarStarted) stopLiteLLM(config);
      removeIfPresent(config.statePath);
      removeIfPresent(config.credentialPath);
    } finally {
      log.end();
    }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.once(signal, () => {
      if (client && client.exitCode === null && client.signalCode === null) client.kill('SIGTERM');
      else void cleanup().then(() => { process.exit(0); });
    });
  }

  try {
    console.log(`正在启动 Mac 本地团队服务器：${config.origin}`);
    await waitReady(config, server);
    const clientEnv = {
      ...process.env,
      CREATIVE_STUDIO_CLIENT_MODE: 'local-team',
      CREATIVE_STUDIO_SERVER_ORIGIN: config.origin,
      CREATIVE_STUDIO_CLIENT_STATE_ROOT: path.join(config.dataRoot, 'client-state'),
    };
    delete clientEnv.ELECTRON_RUN_AS_NODE;
    delete clientEnv.CREATIVE_STUDIO_CLIENT_INSTALL_ROOT;
    delete clientEnv.CREATIVE_STUDIO_CLIENT_RELEASE_ID;
    client = spawn(electronBinary, ['.'], { cwd: repoRoot, env: clientEnv, stdio: 'inherit' });
    state.clientPid = client.pid;
    writeJson(config.statePath, state);
    server.once('exit', () => {
      if (!cleaning && client && client.exitCode === null && client.signalCode === null) {
        console.error('团队服务器已退出，客户端将随之关闭。');
        client.kill('SIGTERM');
      }
    });
    console.log('团队客户端已启动。关闭客户端窗口或按 Ctrl+C 会停止本次本地服务。');
    await new Promise(resolve => client.once('exit', resolve));
  } finally {
    await cleanup();
  }
}

async function stop(config) {
  if (!fs.existsSync(config.statePath)) {
    console.log('本地团队工作台没有运行记录。');
    return;
  }
  const state = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  if (state.schemaVersion !== 1 || state.deploymentId !== config.deploymentId) {
    throw new Error('运行记录不属于当前本地团队工作台');
  }
  if (state.clientPid) {
    try { await signalClient(state); }
    catch (error) { console.error(`客户端未接受停止信号：${error.message}`); }
  }
  await controlledServerStop(config, state.serverPid);
  const released = await waitPortReleased(config.port, 15_000);
  if (!released) throw new Error('团队服务停机后端口仍未释放，未执行强制清理');
  stopLiteLLM(config);
  removeIfPresent(config.statePath);
  removeIfPresent(config.credentialPath);
  console.log('本地团队工作台已停止。');
}

async function recoverAdmin(config, args) {
  const index = args.indexOf('--employee-id');
  const employeeId = index >= 0 ? args[index + 1]?.trim() : '0001';
  if (!employeeId) throw new Error('管理员工号不能为空');
  if ((await findListenerPids(config.port)).length > 0) {
    throw new Error('请先运行 team-desktop/stop.command，再恢复管理员');
  }
  run(process.execPath, [path.join(repoRoot, 'scripts', 'team-server', 'recover-admin.mjs'),
    '--employee-id', employeeId], { cwd: repoRoot, env: serverEnvironment(config) });
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  const config = resolveLocalTeamConfig();
  if (command === 'print-config') {
    const safe = { ...config };
    delete safe.credentialPath;
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  if (command === 'start') {
    assert.ok(args.every(arg => arg === '--rebuild'), 'start 只支持 --rebuild');
    await start(config, args.includes('--rebuild'));
    return;
  }
  if (command === 'stop') {
    assert.equal(args.length, 0, 'stop 不接受参数');
    await stop(config);
    return;
  }
  if (command === 'recover-admin') {
    await recoverAdmin(config, args);
    return;
  }
  throw new Error('用法：launcher.mjs start [--rebuild] | stop | recover-admin [--employee-id 工号] | print-config');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`本地团队工作台：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
