import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isOwnedByRoot, killTree } from '../runtime/process-tree.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertIdentity(config, credential, status) {
  if (credential?.schemaVersion !== 1 || credential.deploymentId !== config.deploymentId
    || typeof credential.token !== 'string' || credential.token.length < 16) {
    throw new Error('本机控制凭据无效或部署 ID 不匹配');
  }
  if (status?.deploymentId !== config.deploymentId || typeof status.instanceId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(status.instanceId)
    || !Number.isSafeInteger(status.pid) || status.pid <= 0) {
    throw new Error('实例、部署 ID 或 PID 证据无效，已拒绝操作');
  }
}

async function requestJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, options); }
  catch { throw new Error('本机运维端点不可达；未尝试认领端口进程'); }
  if (!response.ok) throw new Error(`本机运维端点拒绝请求（HTTP ${response.status}）`);
  try { return await response.json(); }
  catch { throw new Error('本机运维端点返回了无法解析的响应'); }
}

async function getProcessTree(rootPid) {
  if (process.platform === 'win32') {
    const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const children = new Map();
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      const ppid = Number(row.ParentProcessId);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const result = [];
    const pending = [rootPid];
    const seen = new Set();
    while (pending.length) {
      const pid = pending.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return result;
  }
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid='], { timeout: 10_000 });
  const children = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

async function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!(await isAlive(pid))) return true;
    await sleep(250);
  }
  return !(await isAlive(pid));
}

const actualDependencies = {
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout ?? 150_000) }),
  process: {
    isOwnedByRoot,
    processTree: getProcessTree,
    waitForExit,
    isAlive,
    killTree,
  },
  sleep,
};

async function readStatus(options, dependencies, credential) {
  const { config } = options;
  const status = await requestJson(dependencies.fetch, `http://127.0.0.1:${config.appPort}/api/team/operations/status`, {
    method: 'GET',
    headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json' },
    timeout: 10_000,
  });
  assertIdentity(config, credential, status);
  if (!(await dependencies.process.isOwnedByRoot(status.pid, config.releaseRoot))) {
    throw new Error('应用 PID 不属于当前 release，归属不明时不得停止或强制结束');
  }
  const processTree = await dependencies.process.processTree(status.pid);
  if (processTree[0] !== status.pid || new Set(processTree).size !== processTree.length) {
    throw new Error('进程树证据无效，已拒绝操作');
  }
  return { status, processTree };
}

export async function runControlledServiceAction(options, injected = {}) {
  const dependencies = {
    ...actualDependencies,
    ...injected,
    process: { ...actualDependencies.process, ...(injected.process ?? {}) },
  };
  const { config, credential, action } = options;
  if (!config || config.stopTimeoutSeconds < 240 || !Number.isSafeInteger(config.appPort)) throw new Error('部署配置无效');
  if (!['status', 'stop'].includes(action)) throw new Error('未知运维动作');
  if (action === 'stop' && options.apply !== true) {
    return {
      schemaVersion: 1,
      action,
      dryRun: true,
      applyPerformed: false,
      wouldStopDeploymentId: config.deploymentId,
      appPort: config.appPort,
      note: 'Only the app instance would be drained; the independent LiteLLM SCM service is not touched by this helper.',
    };
  }
  const { status, processTree } = await readStatus(options, dependencies, credential);
  if (action === 'status') {
    return {
      schemaVersion: 1,
      action,
      dryRun: true,
      applyPerformed: false,
      deploymentId: status.deploymentId,
      instanceId: status.instanceId,
      pid: status.pid,
      ready: status.ready === true,
      maintenance: status.maintenance === true,
      phase: typeof status.phase === 'string' ? status.phase : 'unknown',
      ownedByRelease: true,
      processTree,
    };
  }

  const shutdown = await requestJson(dependencies.fetch, `http://127.0.0.1:${config.appPort}/api/team/operations/shutdown`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ instanceId: status.instanceId }),
    timeout: Math.max(130_000, (config.stopTimeoutSeconds - 20) * 1000),
  });
  if (shutdown.deploymentId !== status.deploymentId || shutdown.instanceId !== status.instanceId) {
    throw new Error('停机响应的部署或实例与请求不一致；不执行强制处置');
  }

  const exited = new Set();
  const exitResults = await Promise.all(processTree.map(async (pid) => ({
    pid,
    exited: await dependencies.process.waitForExit(pid, 15_000),
  })));
  for (const result of exitResults) {
    if (result.exited) exited.add(result.pid);
  }
  let forced = false;
  if (exited.size !== processTree.length && options.forceAfterTimeout === true) {
    if (!(await dependencies.process.isOwnedByRoot(status.pid, config.releaseRoot))) {
      throw new Error('超时后应用根 PID 已不属于当前 release，拒绝强制结束');
    }
    const currentTree = await dependencies.process.processTree(status.pid);
    if (currentTree.some((pid) => !processTree.includes(pid))) {
      throw new Error('超时后出现未记录的新子进程，拒绝扩大进程树终止范围');
    }
    for (const pid of currentTree.filter((pid) => !exited.has(pid))) {
      if (!(await dependencies.process.isOwnedByRoot(pid, config.releaseRoot))) {
        throw new Error('残留子进程不属于当前 release，拒绝强制结束');
      }
    }
    await dependencies.process.killTree(status.pid);
    forced = true;
  }
  const residual = [];
  for (const pid of processTree) {
    if (await dependencies.process.isAlive(pid)) residual.push(pid);
  }
  return {
    schemaVersion: 1,
    action,
    dryRun: false,
    applyPerformed: true,
    deploymentId: status.deploymentId,
    instanceId: status.instanceId,
    stopped: residual.length === 0,
    forced,
    gracefulStopped: shutdown.stopped === true,
    pendingTasks: Number.isSafeInteger(shutdown.pendingTasks) ? shutdown.pendingTasks : null,
    verifiedExitedPids: processTree.filter((pid) => !residual.includes(pid)),
    residualPids: residual,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readCredential(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('控制凭据必须是普通文件且受 ACL 保护');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action] = process.argv.slice(2);
    const configPath = argument('--config');
    const credentialPath = argument('--credential-file');
    if (!configPath || !credentialPath) throw new Error('必须提供 --config 与 --credential-file');
    const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8').replace(/^\uFEFF/, ''));
    if (path.resolve(credentialPath).toLowerCase() !== path.resolve(config.controlCredentialFile).toLowerCase()) {
      throw new Error('凭据路径必须与部署配置一致');
    }
    const credential = readCredential(path.resolve(credentialPath));
    const result = await runControlledServiceAction({
      action,
      config,
      credential,
      apply: process.argv.includes('--apply'),
      forceAfterTimeout: process.argv.includes('--force-after-timeout'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.stopped === false) process.exitCode = 1;
  } catch {
    process.stderr.write('受控运维操作失败；未输出凭据、响应正文或未知进程信息。\n');
    process.exitCode = 1;
  }
}
