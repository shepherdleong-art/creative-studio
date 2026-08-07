import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// Real Windows post-install smoke. It never calls the shutdown endpoint: cleanup uses
// exact process ownership checks and the sidecar's own stop controller.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_PASSWORD = 'smoke-password-20260807';
const SECRETS = [SMOKE_PASSWORD, 'smoke-only-gateway-token-20260807', 'smoke-only-doubao-token-20260807', 'smoke-only-cos-id-20260807', 'smoke-only-cos-token-20260807', 'smoke-only-upstream-token-20260807'];
const TEMP_PREFIX = 'creative-studio-managed-installer-';
const PROXY_PORT = 4000;
const MAX_OUTPUT = 128 * 1024;
const SAFE_ENV_KEYS = [
  'SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PROGRAMDATA', 'USERPROFILE', 'SystemDrive', 'OS',
  'ALLUSERSPROFILE', 'PUBLIC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROCESSOR_ARCHITEW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramFiles',
  'ProgramFiles(x86)',
];
const SECRET_FIELD_NAMES = new Set([
  'apikey', 'secretkey', 'gatewayapikey', 'authorization', 'accesstoken',
  'accesskey', 'secretid', 'password', 'clientsecret', 'apisecret', 'bearertoken', 'token',
]);

function minimalEnv(extra = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

function assertNoSecretFields(value, pathText = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, pathText + '[' + index + ']'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
    assert.equal(SECRET_FIELD_NAMES.has(normalizedKey), false, 'response exposed secret field ' + pathText + '.' + key);
    assertNoSecretFields(child, pathText + '.' + key);
  }
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--installer' || !argv[1]) throw new Error('用法：node scripts/windows-managed-installer-smoke.test.mjs --installer <path>');
  return path.resolve(argv[1]);
}
function isWindows() { return process.platform === 'win32'; }
function normalized(value) { return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase(); }
function inside(parent, child, equal = false) {
  const p = normalized(parent); const c = normalized(child);
  if (equal && p === c) return true;
  const relative = path.relative(p, c);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function assertInside(parent, child, label) { assert.ok(inside(parent, child), `${label} escaped ${parent}: ${child}`); }
function redact(value) {
  let text = String(value || '');
  for (const secret of SECRETS) text = text.split(secret).join('[redacted]');
  return text.length > 4000 ? `${text.slice(-4000)}\n[truncated]` : text;
}
function run(command, args, options = {}) {
  const { cwd = REPO_ROOT, env = minimalEnv(), timeoutMs = 60_000, ignoreStdio = false } = options;
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ignoreStdio ? 'ignore' : ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ error, code: null, signal: null, stdout: '', stderr: '', timedOut: false }); return; }
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const append = (current, chunk) => { const value = current + chunk.toString('utf8'); return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value; };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* best effort */ }
      // A survived grandchild (e.g. the installed server) can inherit and hold
      // the pipes, which would otherwise keep 'close' pending forever.
      try { child.stdout?.destroy(); } catch { /* best effort */ }
      try { child.stderr?.destroy(); } catch { /* best effort */ }
      if (isWindows() && child.pid) {
        try { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: minimalEnv() }); killer.unref(); } catch { /* best effort */ }
      }
    }, timeoutMs);
    const finish = (error, code, signal) => { if (done) return; done = true; clearTimeout(timer); resolve({ error, code, signal, stdout, stderr, timedOut }); };
    child.once('error', (error) => finish(error, null, null));
    child.once('close', (code, signal) => finish(null, code, signal));
  });
}
function powershellPath() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
function runPsFile(file, args, options = {}) { return run(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], options); }
function expectZero(result, command, args = []) {
  const detail = `${command} ${args.join(' ')}\n${redact(result.stderr)}\n${redact(result.stdout)}`;
  assert.equal(result.error, null, `${command} failed to start: ${redact(result.error?.message)}`);
  assert.equal(result.timedOut, false, `${detail}\n(timeout)`);
  assert.equal(result.code, 0, detail);
}
function makeTempRoot() {
  const osTemp = path.resolve(os.tmpdir()); const root = fs.mkdtempSync(path.join(osTemp, TEMP_PREFIX));
  assertInside(osTemp, root, 'temporary root');
  const marker = path.join(root, '.smoke-owner');
  fs.writeFileSync(marker, `${process.pid}:${Date.now()}:${createHash('sha256').update(root).digest('hex')}\n`, 'utf8');
  return { osTemp, root, marker };
}
function cleanTempRoot(temp) {
  assert.ok(temp?.root && temp?.marker, 'refusing cleanup without an owned temporary root');
  assert.ok(inside(temp.osTemp || os.tmpdir(), temp.root), 'refusing cleanup outside the OS temporary directory');
  assert.ok(inside(temp.root, temp.marker), 'refusing cleanup with a marker outside the temporary root');
  const marker = fs.readFileSync(temp.marker, 'utf8').trim();
  const fields = marker.split(':');
  assert.equal(fields.length, 3, 'temporary root ownership marker is malformed');
  assert.equal(fields[0], String(process.pid), 'temporary root ownership marker belongs to another process');
  assert.match(fields[1], /^\d+$/, 'temporary root ownership marker has no timestamp');
  assert.equal(fields[2], createHash('sha256').update(temp.root).digest('hex'), 'temporary root ownership marker does not match its path');
  fs.rmSync(temp.root, { recursive: true, force: true });
  assert.equal(fs.existsSync(temp.root), false, 'temporary root still exists after cleanup');
}

async function pickPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function portFree(port) {
  return await new Promise((resolve) => {
    const server = createServer(); server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function parseNetstat(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/); if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(fields[1]) || /^(.+):(\d+)$/.exec(fields[1]);
    const port = match ? Number(match[2]) : NaN; const pid = Number(fields[4]);
    if (!match || !Number.isInteger(port) || !Number.isInteger(pid)) continue;
    rows.push({ address: match[1], port, state: fields[3].toUpperCase(), pid });
  }
  return rows;
}
async function listeners(port) {
  const result = await run('netstat.exe', ['-ano', '-p', 'tcp'], { timeoutMs: 5000 });
  assert.equal(result.error, null, 'netstat failed: ' + redact(result.error?.message));
  assert.equal(result.code, 0, 'netstat exited with code ' + result.code + ': ' + redact(result.stderr));
  return parseNetstat(result.stdout).filter((row) => row.port === port && ['LISTENING', 'LISTEN'].includes(row.state));
}
async function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const quote = String.fromCharCode(39);
  const command = '$p=Get-CimInstance Win32_Process -Filter ' + quote + 'ProcessId = ' + String(pid) + quote + '; if ($null -eq $p) { exit 1 }; ConvertTo-Json -InputObject ([ordered]@{ ProcessId=$p.ProcessId; ParentProcessId=$p.ParentProcessId; ExecutablePath=$p.ExecutablePath; CommandLine=$p.CommandLine }) -Compress';
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: 5000 });
  if (result.error || result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}
async function ownedRootProcesses(root) {
  const quote = String.fromCharCode(39);
  const rootLiteral = normalized(root).replaceAll(quote, quote + quote);
  const command = '$root=' + quote + rootLiteral + quote + '; $rootLower=$root.ToLowerInvariant(); $rows=Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($rootLower)) -or ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($rootLower)) } | Select-Object ProcessId,ExecutablePath,CommandLine; if ($null -eq $rows) { exit 0 }; ConvertTo-Json -InputObject $rows -Compress';
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: 10_000 });
  assert.equal(result.error, null, 'owned-process scan failed to start');
  assert.equal(result.code, 0, 'owned-process scan failed: exit ' + result.code);
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function ownedProcess(pid, root) {
  const rootText = normalized(root); const seen = new Set(); let current = pid;
  for (let depth = 0; depth < 12 && Number.isInteger(current) && current > 0 && !seen.has(current); depth += 1) {
    seen.add(current); const info = await processInfo(current); if (!info) return false;
    const executable = normalized(String(info.ExecutablePath || '')); const commandLine = String(info.CommandLine || '').toLowerCase();
    if ((executable && (executable === rootText || executable.startsWith(rootText + '\\'))) || commandLine.includes(rootText)) return true;
    current = Number(info.ParentProcessId);
  }
  return false;
}
async function assertLoopback(port, label) {
  const rows = await listeners(port); assert.ok(rows.length > 0, `${label} is not listening on ${port}`);
  assert.ok(rows.every((row) => row.address === '127.0.0.1'), `${label} is not loopback-only: ${JSON.stringify(rows)}`);
}
async function waitUntil(label, check, timeoutMs = 120_000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs; let lastError = null;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await sleep(intervalMs);
  }
  throw new Error(`${label} 超时${lastError ? `：${redact(lastError.message)}` : ''}`);
}
async function fetchJson(baseUrl, pathname, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: controller.signal, redirect: 'error' });
    const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch { /* opaque */ }
    return { response, text, body };
  } finally { clearTimeout(timer); }
}
async function providerList(baseUrl, pathname, expected, label) {
  const result = await fetchJson(baseUrl, pathname);
  assert.equal(result.response.status, 200, `${label} HTTP ${result.response.status}: ${redact(result.text)}`);
  assert.ok(Array.isArray(result.body), `${label} must return an array`);
  assert.deepEqual(result.body.map((item) => item?.id).sort(), [...expected].sort(), `${label} returned unexpected providers`);
  assertNoSecretFields(result.body);
  for (const secret of SECRETS) assert.equal(result.text.includes(secret), false, `${label} leaked credential value`);
}
function smokeProfile() {
  return {
    schemaVersion: 1, profileName: 'Windows managed installer smoke', gatewayApiKey: SECRETS[1],
    image: { id: 'smoke-company-image', name: 'Smoke 公司图片', type: 'gateway-task-image', apiStyle: 'openai-compatible', baseUrl: `http://127.0.0.1:${PROXY_PORT}`, model: 'smoke-image-model', enabled: true },
    script: { id: 'smoke-company-script', name: 'Smoke 公司脚本', type: 'openai-compatible', apiStyle: 'openai-compatible', baseUrl: `http://127.0.0.1:${PROXY_PORT}`, model: 'smoke-script-model', enabled: true, executionScope: 'company', supportsVision: true, maxTokens: 4096 },
    videos: [{ id: 'smoke-company-video', name: 'Smoke 公司视频', type: 'openai-video', apiStyle: 'openai-compatible', baseUrl: `http://127.0.0.1:${PROXY_PORT}`, model: 'smoke-video-model', enabled: true, defaultDurationSec: 5 }],
    tts: { id: 'doubao-seed-tts-2', name: 'Smoke 豆包语音', type: 'doubao-http-chunked', apiStyle: 'doubao-http-chunked', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', model: 'seed-tts-2.0', enabled: true, apiKey: SECRETS[2] },
    // example.* is rejected by the schema; this synthetic domain is never contacted.
    cos: { secretId: SECRETS[3], secretKey: SECRETS[4], domain: 'smoke.invalid', prefix: 'smoke/', ttlSec: 300 },
  };
}
function smokeYaml() {
  const unicodeLabel = String.fromCodePoint(20264, 26684, 32, 8364, 32, 47, 32, 20013, 25991);
  return 'model_list:\n'
    + '  - model_name: ' + JSON.stringify(unicodeLabel) + '\n'
    + '    litellm_params:\n      model: openai/smoke-model\n      api_base: https://upstream.invalid\n      api_key: ' + SECRETS[5] + '\n';
}
async function createProvision(tempRoot) {
  const profilePath = path.join(tempRoot, 'smoke-profile.local.json'); const configPath = path.join(tempRoot, 'smoke-config.yaml'); const outputPath = path.join(tempRoot, 'smoke.provision');
  for (const target of [profilePath, configPath, outputPath]) assertInside(tempRoot, target, 'provision artifact');
  const yaml = smokeYaml();
  fs.writeFileSync(profilePath, `${JSON.stringify(smokeProfile(), null, 2)}\n`, 'utf8'); fs.writeFileSync(configPath, yaml, 'utf8');
  const generator = path.join(REPO_ROOT, 'scripts', 'create-provision-package.ts');
  const result = await run(process.execPath, [generator, profilePath, configPath, outputPath], { cwd: REPO_ROOT, env: minimalEnv({ PROVISION_PASSWORD: SMOKE_PASSWORD }), timeoutMs: 30_000 });
  expectZero(result, process.execPath, [generator]);
  const encrypted = fs.readFileSync(outputPath);
  assert.equal(encrypted.includes(Buffer.from(SECRETS[1])), false); assert.equal(encrypted.includes(Buffer.from(yaml)), false);
  return { outputPath, configPath, yaml };
}
async function verifyPayload(root) {
  const required = ['CreativeStudio.exe', 'server.js', 'runtime\\node.exe', 'runtime-litellm\\python.exe', 'runtime-litellm\\python312._pth', 'runtime-litellm\\manifest.json', 'runtime-litellm\\Lib\\site-packages\\litellm', 'scripts\\start-installed.ps1', 'scripts\\stop-installed.ps1', 'scripts\\start-company-sidecar.ps1', 'scripts\\stop-company-sidecar.ps1', 'scripts\\restart-company-sidecar.ps1'];
  for (const relative of required) {
    const target = path.join(root, relative); assertInside(root, target, `bundled payload ${relative}`); assert.equal(fs.existsSync(target), true, `missing bundled payload: ${target}`);
  }
  const uninstallArtifacts = fs.readdirSync(root).filter((name) => /^unins\d+\.(?:dat|exe)$/i.test(name));
  assert.deepEqual(uninstallArtifacts, [], 'managed smoke install unexpectedly created an uninstaller');
  const nodeExe = path.join(root, 'runtime', 'node.exe');
  const node = await run(nodeExe, ['-p', 'process.version + String.fromCharCode(32) + process.platform + String.fromCharCode(32) + process.arch'], { cwd: root, timeoutMs: 20_000 });
  expectZero(node, nodeExe, ['-p']); assert.match(node.stdout, /^v22\.22\.3 win32 x64\s*$/m);
  const pythonExe = path.join(root, 'runtime-litellm', 'python.exe');
  const python = await run(pythonExe, ['-c', 'import struct,sys; print(sys.version_info[:3]); print(struct.calcsize(chr(80)))'], { cwd: root, timeoutMs: 30_000 });
  expectZero(python, pythonExe, ['-c']); assert.match(python.stdout, /\(3, 12, 10\)/); assert.match(python.stdout, /(^|\n)8\s*$/m);
  const litellm = await run(pythonExe, ['-c', 'import importlib.metadata; print(importlib.metadata.version(chr(108)+chr(105)+chr(116)+chr(101)+chr(108)+chr(108)+chr(109)))'], { cwd: root, timeoutMs: 30_000 });
  expectZero(litellm, pythonExe, ['-c']); assert.match(litellm.stdout, /1\.89\.2/);
}
function installerAppId() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'installer', 'windows', 'CreativeStudio.iss'), 'utf8');
  const match = /^\s*AppId\s*=\s*\{\{([^}\r\n]+)\}/mi.exec(source);
  assert.ok(match?.[1], 'CreativeStudio.iss must define an AppId for registry isolation');
  return match[1];
}
// Registry isolation is deliberately read-only: reg.exe query snapshots existing
// uninstall metadata in both registry views, and the smoke never writes or restores it.
function registrySnapshotTargets(appId) {
  const appIds = [appId, '{' + appId + '}'];
  const relativePaths = [
    'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const targets = [];
  for (const hive of ['HKCU', 'HKLM']) {
    for (const view of ['default', '32', '64']) {
      for (const relative of relativePaths) {
        for (const id of appIds) {
          const keyPath = hive + '\\' + relative + '\\' + id + '_is1';
          targets.push({ label: hive + '|' + view + '|' + keyPath, keyPath, view });
        }
      }
    }
  }
  return targets;
}
async function snapshotInstallerRegistry(appId) {
  const snapshot = {};
  for (const target of registrySnapshotTargets(appId)) {
    const args = ['query', target.keyPath, '/s'];
    if (target.view !== 'default') args.push('/reg:' + target.view);
    const result = await run('reg.exe', args, { timeoutMs: 5000 });
    assert.equal(result.error, null, 'registry snapshot failed to start for ' + target.label);
    assert.ok(result.code === 0 || result.code === 1, 'registry snapshot failed for ' + target.label + ': exit ' + result.code);
    snapshot[target.label] = {
      present: result.code === 0,
      output: result.code === 0 ? result.stdout.replace(/\r\n?/g, '\n').trim() : '',
    };
  }
  return snapshot;
}
function assertRegistryUnchanged(before, after, phase) {
  const labels = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = labels.filter((label) => JSON.stringify(before[label]) !== JSON.stringify(after[label]));
  assert.equal(changed.length, 0, phase + ' changed AppId uninstall registry metadata: ' + changed.slice(0, 8).join(', '));
}
async function managedStatus(baseUrl) {
  const result = await fetchJson(baseUrl, '/api/managed-deployment/status');
  assert.equal(result.response.status, 200, 'managed status HTTP ' + result.response.status + ': ' + redact(result.text));
  assert.equal(result.body?.managed, true, 'installed app must advertise managed deployment');
  assertNoSecretFields(result.body);
  for (const secret of SECRETS) assert.equal(result.text.includes(secret), false, 'managed status leaked credential value');
  return result.body;
}
async function pollReady(baseUrl, phases, timeoutMs = 150_000) {
  await waitUntil('LiteLLM managed phase ready', async () => {
    const status = await managedStatus(baseUrl); phases.push(status.phase);
    if (status.phase === 'failed') throw new Error('LiteLLM phase failed: ' + (status.reason || 'unknown'));
    return status.phase === 'ready';
  }, timeoutMs);
}
function ownedStack(root) {
  const stackPath = path.join(root, 'storage', 'run', 'stack.json');
  if (!inside(root, stackPath) || !fs.existsSync(stackPath)) return null;
  try {
    const stack = JSON.parse(fs.readFileSync(stackPath, 'utf8'));
    if (stack?.sidecarKind !== 'company-litellm' || String(stack.runtimeRelativePath).replaceAll('/', '\\') !== 'runtime-litellm\\python.exe' || String(stack.configRelativePath).replaceAll('/', '\\') !== 'config.yaml' || Number(stack.proxyPort) !== PROXY_PORT || !Number.isInteger(Number(stack.litellmPid)) || Number(stack.litellmPid) <= 0) return null;
    return stack;
  } catch { return null; }
}
async function stopSidecar(root) {
  if (!ownedStack(root)) return;
  const stopScript = path.join(root, 'scripts', 'stop-company-sidecar.ps1');
  const result = await runPsFile(stopScript, ['-Root', root], { cwd: root, timeoutMs: 20_000 }); expectZero(result, stopScript, ['-Root', root]);
  await waitUntil('owned LiteLLM stop', async () => !ownedStack(root) && (await listeners(PROXY_PORT)).length === 0, 20_000, 250);
}
async function restartSidecar(root, baseUrl, phases) {
  const script = path.join(root, 'scripts', 'restart-company-sidecar.ps1');
  const pending = runPsFile(script, ['-Root', root], { cwd: root, timeoutMs: 90_000 });
  await pollReady(baseUrl, phases, 120_000); expectZero(await pending, script, ['-Root', root]);
}
async function initialLocked(baseUrl) {
  const status = await managedStatus(baseUrl);
  assert.equal(status.phase, 'unconfigured'); assert.equal(status.configured, false); assert.equal(status.proxyAvailable, false);
  assert.equal(status.profileName, null); assert.equal(status.importedAt, null);
  const project = await fetchJson(baseUrl, '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'managed smoke should be locked', providerId: 'missing', size: '1024x1024' }) });
  assert.equal(project.response.status, 423, 'project write should be locked: ' + redact(project.text)); assert.equal(project.body?.code, 'managed_workbench_locked'); assert.equal(project.body?.phase, 'unconfigured');
  await providerList(baseUrl, '/api/providers', [], 'initial image providers');
  await providerList(baseUrl, '/api/providers/script', [], 'initial script providers');
  await providerList(baseUrl, '/api/providers/video?all=1', [], 'initial video providers');
  await providerList(baseUrl, '/api/providers/tts', [], 'initial TTS providers');
}
async function importProvision(baseUrl, packagePath) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(packagePath)], { type: 'application/octet-stream' }), 'smoke.provision');
  form.append('password', SMOKE_PASSWORD);
  const result = await fetchJson(baseUrl, '/api/provisioning', { method: 'POST', body: form }, 30_000);
  assert.equal(result.response.status, 200, 'provision import failed: ' + redact(result.text)); assert.equal(result.body?.configured, true);
  assert.equal(result.body?.message, '统一配置已导入，正在启动公司模型服务');
  assertNoSecretFields(result.body);
  for (const secret of SECRETS) assert.equal(result.text.includes(secret), false, 'provision import leaked credential value');
}
async function stopApp(root, port) {
  const pidPath = path.join(root, 'storage', 'run', 'server.pid'); let pid = 0;
  try { pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').replace(/\uFEFF/g, '').trim(), 10); } catch { /* no pid file */ }
  const rows = await listeners(port);
  const ownedPid = Number.isInteger(pid) && pid > 0 && await ownedProcess(pid, root) ? pid : 0;
  if (rows.length === 0 && !ownedPid) return;
  if (ownedPid) {
    const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
    assert.ok(result.error === null && (result.code === 0 || result.code === 128), 'owned Node process could not be stopped');
  } else {
    throw new Error('missing owned server.pid; refusing to kill an unknown process');
  }
  await waitUntil('owned Node stop', async () => (await listeners(port)).length === 0, 20_000, 250);
}
async function ownedAppStillRunning(root, port) {
  for (const row of await listeners(port)) if (await ownedProcess(row.pid, root)) return true;
  const pidPath = path.join(root, 'storage', 'run', 'server.pid');
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').replace(/\uFEFF/g, '').trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && await ownedProcess(pid, root)) return true;
  } catch { /* no pid file */ }
  for (const info of await ownedRootProcesses(root)) {
    const executable = normalized(String(info.ExecutablePath || ''));
    const commandLine = String(info.CommandLine || '').toLowerCase();
    if (executable.endsWith('\\node.exe') || commandLine.includes('server.js')) return true;
  }
  return false;
}
async function ownedSidecarStillRunning(root, sidecarPid = 0) {
  const stackPid = Number(ownedStack(root)?.litellmPid || sidecarPid || 0);
  if (Number.isInteger(stackPid) && stackPid > 0 && await ownedProcess(stackPid, root)) return true;
  for (const row of await listeners(PROXY_PORT)) if (await ownedProcess(row.pid, root)) return true;
  for (const info of await ownedRootProcesses(root)) {
    const executable = normalized(String(info.ExecutablePath || ''));
    const commandLine = String(info.CommandLine || '').toLowerCase();
    if (executable.includes('\\runtime-litellm\\') || commandLine.includes('litellm')) return true;
  }
  return false;
}
async function main() {
  const installerArgument = parseCli(process.argv.slice(2));
  if (!isWindows()) { console.log('windows managed installer smoke skipped: requires Windows'); return; }
  const installerPath = path.resolve(installerArgument);
  assert.equal(path.extname(installerPath).toLowerCase(), '.exe'); assert.equal(fs.statSync(installerPath).isFile(), true);
  const appId = installerAppId();
  const registryBefore = await snapshotInstallerRegistry(appId);
  const temp = makeTempRoot(); const installRoot = path.join(temp.root, 'install'); const dataRoot = installRoot;
  assertInside(temp.root, installRoot, 'install root'); fs.mkdirSync(installRoot, { recursive: true });
  assert.notEqual(normalized(installRoot), normalized(temp.root));
  let appPort = await pickPort(); if (appPort === PROXY_PORT) appPort = await pickPort(); let appLaunchAttempted = false; let sidecarMayRun = false; let sidecarPid = 0; const phases = [];
  try {
    assert.equal(await portFree(PROXY_PORT), true, 'LiteLLM port 4000 is occupied; refusing to touch another process');
    assert.equal(await portFree(appPort), true, 'chosen app port became occupied; refusing to touch another process');
    const installer = await run(installerPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCLOSEAPPLICATIONS', '/NOICONS', '/MANAGEDSMOKE=1', '/DIR=' + installRoot], { cwd: temp.root, timeoutMs: 180_000 });
    expectZero(installer, installerPath, ['/VERYSILENT', '/NOCLOSEAPPLICATIONS', '/NOICONS', '/MANAGEDSMOKE=1', '/DIR=' + installRoot]); assert.equal(fs.existsSync(installRoot), true);
    await verifyPayload(installRoot);
    const registryAfterInstall = await snapshotInstallerRegistry(appId);
    assertRegistryUnchanged(registryBefore, registryAfterInstall, 'post-install smoke check');
    assert.equal(fs.existsSync(path.join(dataRoot, 'config.yaml')), false); assert.equal(fs.existsSync(path.join(dataRoot, 'data', 'provisioning', 'state.json')), false);
    const launcherExe = path.join(installRoot, 'CreativeStudio.exe');
    const baseUrl = 'http://127.0.0.1:' + appPort;
    appLaunchAttempted = true; sidecarMayRun = true;
    const started = await run(launcherExe, [], { cwd: installRoot, env: minimalEnv({ CREATIVE_STUDIO_PORT: String(appPort), CREATIVE_STUDIO_DATA_ROOT: dataRoot }), timeoutMs: 30_000, ignoreStdio: true });
    expectZero(started, launcherExe, []);
    await waitUntil('installed Node HTTP listener', async () => { try { const response = await fetch(baseUrl + '/', { redirect: 'error' }); return response.status >= 200 && response.status < 500; } catch { return false; } }, 60_000, 300);
    await assertLoopback(appPort, 'Creative Studio'); await initialLocked(baseUrl);
    const provision = await createProvision(temp.root); await importProvision(baseUrl, provision.outputPath);
    assert.equal(fs.readFileSync(provision.configPath, 'utf8').includes(String.fromCodePoint(20264, 26684, 32, 8364, 32, 47, 32, 20013, 25991)), true);
    await pollReady(baseUrl, phases);
    if (!phases.includes('starting')) { await stopSidecar(installRoot); await restartSidecar(installRoot, baseUrl, phases); }
    assert.ok(phases.includes('starting'), 'LiteLLM phase history missed starting: ' + phases.join(', ')); assert.ok(phases.includes('ready'), 'LiteLLM phase history missed ready: ' + phases.join(', '));
    await assertLoopback(PROXY_PORT, 'LiteLLM'); sidecarPid = Number(ownedStack(installRoot)?.litellmPid || 0); const finalStatus = await managedStatus(baseUrl); assert.equal(finalStatus.phase, 'ready'); assert.equal(finalStatus.proxyAvailable, true);
    await providerList(baseUrl, '/api/providers', ['smoke-company-image'], 'ready image providers');
    await providerList(baseUrl, '/api/providers/script', ['smoke-company-script'], 'ready script providers');
    await providerList(baseUrl, '/api/providers/video?all=1', ['smoke-company-video'], 'ready video providers');
    await providerList(baseUrl, '/api/providers/tts', ['doubao-seed-tts-2'], 'ready TTS providers');
    assert.equal(fs.readFileSync(path.join(installRoot, 'config.yaml'), 'utf8').includes(String.fromCodePoint(20264, 26684, 32, 8364, 32, 47, 32, 20013, 25991)), true);
    assert.equal(fs.readFileSync(path.join(installRoot, 'config.yaml'), 'utf8').includes('UnicodeDecodeError'), false);
    await stopSidecar(installRoot);
    await stopApp(installRoot, appPort);
    const secondPhases = [];
    appLaunchAttempted = true; sidecarMayRun = true;
    const restarted = await run(launcherExe, [], { cwd: installRoot, env: minimalEnv({ CREATIVE_STUDIO_PORT: String(appPort), CREATIVE_STUDIO_DATA_ROOT: dataRoot }), timeoutMs: 30_000, ignoreStdio: true });
    expectZero(restarted, launcherExe, []);
    await waitUntil('restarted installed Node HTTP listener', async () => {
      try {
        const response = await fetch(baseUrl + '/', { redirect: 'error' });
        return response.status >= 200 && response.status < 500;
      } catch { return false; }
    }, 60_000, 300);
    await assertLoopback(appPort, 'Creative Studio second launch');
    await pollReady(baseUrl, secondPhases);
    assert.ok(secondPhases.includes('ready'), 'second launch did not reach LiteLLM ready: ' + secondPhases.join(', '));
    await assertLoopback(PROXY_PORT, 'LiteLLM second launch');
    const secondStatus = await managedStatus(baseUrl);
    assert.equal(secondStatus.phase, 'ready'); assert.equal(secondStatus.proxyAvailable, true);
    const secondStack = ownedStack(installRoot);
    assert.ok(secondStack, 'second launch did not publish an owned LiteLLM stack record');
    assert.ok(Number.isInteger(Number(secondStack.litellmPid)) && Number(secondStack.litellmPid) > 0, 'second launch stack record has no LiteLLM PID');
    sidecarPid = Number(secondStack.litellmPid);
    const serverPid = Number.parseInt(fs.readFileSync(path.join(installRoot, 'storage', 'run', 'server.pid'), 'utf8').replace(/\uFEFF/g, '').trim(), 10);
    assert.ok(Number.isInteger(serverPid) && serverPid > 0 && await ownedProcess(serverPid, installRoot), 'second launch server PID is not owned');
    await providerList(baseUrl, '/api/providers', ['smoke-company-image'], 'second launch image providers');
  } finally {
    const cleanupErrors = [];
    try { await stopSidecar(installRoot); } catch (error) { const message = '受控 LiteLLM 清理失败：' + redact(error.message); cleanupErrors.push(message); console.error(message); }
    if (appLaunchAttempted) { try { await stopApp(installRoot, appPort); } catch (error) { const message = '受控 Node 清理失败：' + redact(error.message); cleanupErrors.push(message); console.error(message); } }
    if (sidecarMayRun) {
      const ownedPid = Number(ownedStack(installRoot)?.litellmPid || sidecarPid || 0);
      if (Number.isInteger(ownedPid) && ownedPid > 0 && await ownedProcess(ownedPid, installRoot)) { try { await run('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], { timeoutMs: 10_000 }); } catch { /* best effort */ } }
    }
    if (appLaunchAttempted || sidecarMayRun) {
      try {
        for (const info of await ownedRootProcesses(installRoot)) {
          const pid = Number(info.ProcessId);
          const executable = normalized(String(info.ExecutablePath || ''));
          const commandLine = String(info.CommandLine || '').toLowerCase();
          const ownedRuntime = executable.endsWith('\\node.exe') || executable.includes('\\runtime-litellm\\') || commandLine.includes('server.js') || commandLine.includes('litellm');
          if (!ownedRuntime || !Number.isInteger(pid) || pid <= 0) continue;
          const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
          if (result.error || ![0, 128].includes(result.code)) cleanupErrors.push('owned process kill failed for PID ' + pid);
        }
      } catch (error) {
        const message = 'owned-process cleanup scan failed: ' + redact(error.message);
        cleanupErrors.push(message);
        console.error(message);
      }
    }
    let cleanupSafe = true;
    if (appLaunchAttempted && await ownedAppStillRunning(installRoot, appPort)) {
      cleanupSafe = false;
      cleanupErrors.push('owned Node process still running');
      console.error('保留临时根：未确认受控 Node 进程已退出：' + installRoot);
    }
    if (sidecarMayRun && await ownedSidecarStillRunning(installRoot, sidecarPid)) {
      cleanupSafe = false;
      cleanupErrors.push('owned LiteLLM process still running');
      console.error('保留临时根：未确认受控 LiteLLM 进程已退出：' + installRoot);
    }
    try {
      const registryAfterCleanup = await snapshotInstallerRegistry(appId);
      assertRegistryUnchanged(registryBefore, registryAfterCleanup, 'final cleanup smoke check');
    } catch (error) {
      const message = 'final registry isolation check failed: ' + redact(error.message);
      cleanupErrors.push(message);
      console.error(message);
    }
    if (cleanupErrors.length) throw new Error('managed installer smoke cleanup failed: ' + cleanupErrors.join('; '));
    if (cleanupSafe) cleanTempRoot(temp);
    else console.error('已跳过临时根删除，请在确认受控进程退出后手动清理：' + temp.root);
  }
  console.log('windows managed installer smoke passed: ' + installerPath);
}
main().catch((error) => { console.error('windows managed installer smoke failed: ' + redact(error?.stack || error?.message || error)); process.exitCode = 1; });
