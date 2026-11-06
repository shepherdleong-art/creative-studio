import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(root, 'scripts', 'team-server', 'preflight.ps1');

function validConfig() {
  return {
    schemaVersion: 1,
    ports: [
      { name: 'app', host: '127.0.0.1', port: 3300 },
      { name: 'litellm', host: '127.0.0.1', port: 4300 },
    ],
    directories: [
      { name: 'deployment', path: 'C:\\new\\deployment', requiredAccess: 'read', isOld: false },
      { name: 'data', path: 'D:\\new\\data', requiredAccess: 'modify', isOld: false },
      { name: 'backup', path: 'E:\\backup', requiredAccess: 'modify', isOld: false },
      { name: 'old-data', path: 'F:\\old\\data', requiredAccess: 'read', isOld: true },
    ],
  };
}

function validSnapshot(config = validConfig()) {
  return {
    observedAt: '2026-01-02T03:04:05.000Z',
    windows: { caption: 'fixture Windows Server', version: '10.0.0', buildNumber: '0000', osArchitecture: '64-bit' },
    cpu: [{ name: 'fixture CPU', cores: 8, logicalProcessors: 16 }],
    memory: { totalBytes: 64000000000, freeBytes: 32000000000 },
    gpus: [{ name: 'fixture NVIDIA GPU', driverVersion: '0.0', adapterRamBytes: 12000000000, status: 'OK' }],
    logicalDisks: [{ deviceId: 'C:', fileSystem: 'NTFS', sizeBytes: 1000, freeBytes: 500 }],
    physicalDisks: [{ deviceId: '\\\\.\\PHYSICALDRIVE0', model: 'fixture disk', mediaType: 'SSD', sizeBytes: 1000, interfaceType: 'NVMe', status: 'OK' }],
    networkAdapters: [{ description: 'fixture adapter', ipAddresses: ['192.0.2.10'], subnets: ['255.255.255.0'], gateways: ['192.0.2.1'], dnsServers: ['192.0.2.2'], dhcpEnabled: false }],
    tcpListeners: [{ address: '127.0.0.1', port: 4999 }],
    directoryAccess: config.directories.map((directory) => ({
      path: directory.path,
      exists: true,
      readAllowed: true,
      modifyAllowed: directory.requiredAccess === 'modify',
    })),
  };
}

function runPreflight(t, { config = validConfig(), snapshot = validSnapshot(config), outputDirectory: requestedOutputDirectory } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'deployment.json');
  const snapshotPath = path.join(dir, 'snapshot.json');
  const outputDirectory = requestedOutputDirectory ?? path.join(dir, 'run');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-ConfigPath', configPath,
    '-OutputDirectory', outputDirectory,
    '-ProbeSnapshotPath', snapshotPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, CREATIVE_STUDIO_TEST_SECRET: 'DO-NOT-PRINT-ENV' },
  });
  const reportPath = path.join(outputDirectory, 'preflight-report.json');
  const reportBytes = fs.existsSync(reportPath) ? fs.readFileSync(reportPath) : null;
  const report = reportBytes ? JSON.parse(reportBytes.toString('utf8')) : null;
  return { result, report, reportBytes, outputDirectory };
}

test('fixture 预检只报告快照事实并生成无 BOM JSON', { skip: process.platform !== 'win32' }, (t) => {
  const { result, report, reportBytes } = runPreflight(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(reportBytes[0], 123);
  assert.notDeepEqual([...reportBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(report.status, 'passed');
  assert.equal(report.collection.source, 'fixture');
  assert.equal(report.collection.observedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(report.host.windows.caption, 'fixture Windows Server');
  assert.ok(report.ports.every((port) => port.status === 'available'));
  assert.ok(report.directories.every((directory) => directory.status === 'ok'));
  assert.deepEqual(report.diagnostics, []);
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(report)).includes('DO-NOT-PRINT-ENV'));
});

test('无 GPU、端口占用、目录权限不足与新旧目录重叠都有明确诊断', { skip: process.platform !== 'win32' }, (t) => {
  const config = validConfig();
  config.directories[1].path = 'F:\\old\\data\\server';
  const snapshot = validSnapshot(config);
  snapshot.gpus = [];
  snapshot.tcpListeners.push({ address: '0.0.0.0', port: 3300 });
  snapshot.directoryAccess.find((entry) => entry.path === config.directories[1].path).modifyAllowed = false;
  const { result, report } = runPreflight(t, { config, snapshot });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(report.status, 'failed');
  for (const code of ['GPU_NOT_DETECTED', 'PORT_OCCUPIED', 'DIRECTORY_PERMISSION_INSUFFICIENT', 'DIRECTORY_OVERLAP']) {
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === code), `缺少 ${code}: ${JSON.stringify(report.diagnostics)}`);
  }
  assert.equal(report.ports.find((port) => port.name === 'app').status, 'occupied');
  assert.equal(report.directories.find((directory) => directory.name === 'data').status, 'permission-denied');
});

test('PS1 为 UTF-8 BOM、可由 PowerShell 5.1 解析且仅含指定只读采集面', { skip: process.platform !== 'win32' }, () => {
  const bytes = fs.readFileSync(scriptPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const source = bytes.toString('utf8').slice(1);
  const parse = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    "$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:PREFLIGHT_SCRIPT,[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}",
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PREFLIGHT_SCRIPT: scriptPath } });
  assert.equal(parse.status, 0, parse.stdout + parse.stderr);
  for (const required of [
    'Win32_OperatingSystem', 'Win32_Processor', 'Win32_VideoController',
    'Win32_LogicalDisk', 'Win32_DiskDrive', 'Win32_NetworkAdapterConfiguration',
    'IPGlobalProperties', 'Get-Acl',
  ]) {
    assert.ok(source.includes(required), `缺少只读采集：${required}`);
  }
  assert.doesNotMatch(source, /Get-ChildItem\s+.*Env:|GetEnvironmentVariable|Win32_Process(?:\s|['"]|$)|CommandLine/);
  assert.doesNotMatch(source, /\b(?:Start|Stop|Restart)-Service\b|\bsc\.exe\b|\btaskkill\b|\bStart-Process\b|\bRemove-Item\b|\bSet-Content\b|\bAdd-Content\b/);
  assert.doesNotMatch(source, /Invoke-(?:WebRequest|RestMethod)|Test-NetConnection/);
});

test('报告输出落在旧目录内时在写入前拒绝且不创建目录', { skip: process.platform !== 'win32' }, (t) => {
  const oldDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-old-root-'));
  t.after(() => fs.rmSync(oldDirectory, { recursive: true, force: true }));
  const config = validConfig();
  config.directories.find((directory) => directory.isOld).path = oldDirectory;
  const outputDirectory = path.join(oldDirectory, 'run');
  const { result } = runPreflight(t, { config, snapshot: validSnapshot(config), outputDirectory });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(fs.existsSync(outputDirectory), false);
  assert.deepEqual(fs.readdirSync(oldDirectory), []);
});

test('采集失败保持未知，不伪报无 GPU 或端口可用', { skip: process.platform !== 'win32' }, (t) => {
  const snapshot = validSnapshot();
  snapshot.gpus = null;
  snapshot.tcpListeners = null;
  snapshot.collectionDiagnostics = [
    { code: 'COLLECTION_INCOMPLETE', subject: 'gpu', message: 'fixture collection failure' },
    { code: 'COLLECTION_INCOMPLETE', subject: 'ports', message: 'fixture collection failure' },
  ];
  const { result, report } = runPreflight(t, { snapshot });
  assert.equal(result.status, 1);
  assert.ok(report.ports.every((port) => port.status === 'unknown'));
  assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.code === 'GPU_NOT_DETECTED'));
  assert.equal(report.diagnostics.filter((diagnostic) => diagnostic.code === 'COLLECTION_INCOMPLETE').length, 2);
});

test('目录 ACL 无法读取时保持权限未知而不是断言已授权', { skip: process.platform !== 'win32' }, (t) => {
  const snapshot = validSnapshot();
  snapshot.directoryAccess[0].readAllowed = null;
  snapshot.directoryAccess[0].modifyAllowed = null;
  const { result, report } = runPreflight(t, { snapshot });
  assert.equal(result.status, 1);
  assert.equal(report.directories[0].status, 'unknown');
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'DIRECTORY_PERMISSION_UNKNOWN'));
  assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.subject === 'deployment' && diagnostic.code === 'DIRECTORY_PERMISSION_INSUFFICIENT'));
});

test('全新目录待创建、HTTPS/Caddy 管理端口与 release/证书状态可诊断', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-preflight-fresh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deploymentRoot = path.join(directory, 'deployment');
  const releaseId = 'test-release';
  const releaseRoot = path.join(deploymentRoot, 'releases', releaseId);
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId, sourceCommit: 'abc123' }));
  const certPath = path.join(directory, 'studio.crt');
  const keyPath = path.join(directory, 'studio.key');
  fs.writeFileSync(certPath, 'fixture cert');
  fs.writeFileSync(keyPath, 'fixture key');
  const config = {
    schemaVersion: 1,
    deploymentId: 'studio-prod',
    releaseId,
    deploymentRoot,
    dataRoot: path.join(directory, 'data'),
    backupRoot: path.join(directory, 'backup'),
    oldRoots: [],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudio',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: { certPath, keyPath },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: false,
    stopTimeoutSeconds: 240,
  };
  const snapshot = {
    ...validSnapshot(),
    tcpListeners: [],
    directoryAccess: [
      { path: deploymentRoot, exists: false, readAllowed: null, modifyAllowed: null },
      { path: config.dataRoot, exists: false, readAllowed: null, modifyAllowed: null },
      { path: config.backupRoot, exists: false, readAllowed: null, modifyAllowed: null },
    ],
  };
  const { result, report } = runPreflight(t, { config, snapshot });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(report.status, 'passed');
  assert.ok(report.directories.every((item) => item.status === 'pending-create'));
  const httpsPort = report.ports.find((port) => port.name === 'https');
  assert.ok(httpsPort && httpsPort.port === 443, 'HTTPS 入口端口必须被检查');
  const adminPort = report.ports.find((port) => port.name === 'caddy-admin');
  assert.ok(adminPort && adminPort.port === 2019, 'Caddy 管理端口必须被检查');
  assert.equal(report.release.status, 'verified');
  assert.equal(report.release.sourceCommit, 'abc123');
  assert.equal(report.certificate.status, 'verified');

  const mismatched = { ...config, releaseId: 'other-release' };
  fs.mkdirSync(path.join(deploymentRoot, 'releases', 'other-release'), { recursive: true });
  fs.writeFileSync(path.join(deploymentRoot, 'releases', 'other-release', 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId }));
  const mismatchSnapshot = { ...snapshot, directoryAccess: snapshot.directoryAccess.map((item) => ({ ...item })) };
  const mismatch = runPreflight(t, { config: mismatched, snapshot: mismatchSnapshot });
  assert.equal(mismatch.result.status, 1);
  assert.ok(mismatch.report.diagnostics.some((diagnostic) => diagnostic.code === 'RELEASE_ID_MISMATCH'));
});
