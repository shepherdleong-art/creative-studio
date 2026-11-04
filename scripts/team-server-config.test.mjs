import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(root, 'scripts', 'team-server', 'generate-config.mjs');

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deploymentRoot = path.join(directory, 'deployment');
  const config = {
    schemaVersion: 1,
    deploymentId: 'studio-prod',
    releaseId: '2026.11.02',
    deploymentRoot,
    dataRoot: path.join(directory, 'data'),
    backupRoot: path.join(directory, 'backup'),
    oldRoots: [path.join(directory, 'old-workbench')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudio',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: {
      certPath: 'C:\\controlled\\certs\\studio.crt',
      keyPath: 'C:\\controlled\\certs\\studio.key',
    },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: true,
    maxRequestBytes: 64 * 1024 * 1024,
    stopTimeoutSeconds: 240,
    ...overrides,
  };
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, config, configPath, deploymentRoot };
}

function generate(t, overrides = {}, extraArgs = []) {
  const context = fixture(t, overrides);
  const output = path.join(context.deploymentRoot, 'service');
  const result = spawnSync(process.execPath, [generator, '--config', context.configPath, '--output', output, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ...context, output, result };
}

function readJson(file) {
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  return JSON.parse(bytes.toString('utf8'));
}

test('安装器 resolve-only 输出包含更新目录，与实际生成的托管目录一致', (t) => {
  const context = fixture(t, { serviceAccount: 'NT AUTHORITY\\LocalService' });
  const result = spawnSync(process.execPath, [generator, '--config', context.configPath, '--resolve-only'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.clientUpdatesRoot, path.join(context.deploymentRoot, 'client-updates'));
  assert.equal(fs.existsSync(resolved.clientUpdatesRoot), false, '解析不得创建系统目录');
  assert.equal(resolved.serviceAccount, 'NT AUTHORITY\\LocalService');
  const output = path.join(context.deploymentRoot, 'service');
  const generated = spawnSync(process.execPath, [generator, '--config', context.configPath, '--output', output], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(readJson(path.join(output, 'resolved-services.json')).clientUpdatesRoot, resolved.clientUpdatesRoot);
});

test('生成三个 SCM 服务、固定回环入口、环境文件、日志轮换和受控停机合同', (t) => {
  const { output, result, config } = generate(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['CreativeStudioCaddy.xml', 'CreativeStudioApp.xml', 'CreativeStudioLiteLLM.xml']) {
    assert.ok(fs.existsSync(path.join(output, name)), name);
  }
  const app = fs.readFileSync(path.join(output, 'CreativeStudioApp.xml'), 'utf8');
  assert.match(app, /<id>CreativeStudioApp<\/id>/);
  assert.match(app, /<user>svc_studio\$<\/user>/);
  assert.match(app, /<domain>CONTOSO<\/domain>/);
  assert.match(app, /--env-file=/);
  assert.match(app, /team-server-entry\.cjs/);
  assert.match(app, /<stopexecutable>.*node\.exe<\/stopexecutable>/);
  assert.match(app, /service-control\.mjs/);
  assert.match(app, /<stoptimeout>240 sec<\/stoptimeout>/);
  assert.match(app, /<log mode="roll-by-size">/);
  assert.match(app, /<onfailure action="restart" delay="10 sec"\/>/);
  assert.doesNotMatch(app, /stop-stack|stop-litellm|taskkill \/IM/i);
  assert.ok(app.indexOf('service-control.mjs') < app.indexOf('--force-after-timeout'));

  const caddy = fs.readFileSync(path.join(output, 'CreativeStudioCaddy.xml'), 'utf8');
  assert.match(caddy, /caddy\.exe/);
  assert.match(caddy, /Caddyfile/);
  const proxy = fs.readFileSync(path.join(output, 'Caddyfile'), 'utf8');
  assert.match(proxy, /https:\/\/studio\.example\.test/);
  assert.match(proxy, /127\.0\.0\.1:3300/);
  assert.match(proxy, /tls C:\\controlled\\certs\\studio\.crt C:\\controlled\\certs\\studio\.key/);
  for (const route of ['/api/team/operations/*', '/api/shutdown', '/api/desktop/*', '/client-updates/*']) {
    assert.ok(proxy.includes(route), `Caddy 必须覆盖 ${route}`);
  }
  assert.ok(proxy.includes('file_server'), 'Caddy 必须同源托管更新包');
  assert.doesNotMatch(proxy, /127\.0\.0\.1:4300/);

  const lite = fs.readFileSync(path.join(output, 'CreativeStudioLiteLLM.xml'), 'utf8');
  assert.match(lite, /--host/, 'LiteLLM 必须显式传 host');
  assert.match(lite, /127\.0\.0\.1/);
  assert.match(lite, /4300/);
  assert.doesNotMatch(app, /<depend>CreativeStudioLiteLLM<\/depend>/, '代理故障不得阻塞 app');

  const env = fs.readFileSync(path.join(output, 'app.env'), 'utf8');
  for (const expected of [
    'CREATIVE_STUDIO_DEPLOYMENT_MODE=server',
    'CREATIVE_STUDIO_PORT=3300',
    `CREATIVE_STUDIO_DEPLOYMENT_ID=${config.deploymentId}`,
    'CREATIVE_STUDIO_TRUSTED_ORIGIN=https://studio.example.test',
    'CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE=',
  ]) assert.ok(env.includes(expected), expected);
  assert.doesNotMatch(env, /TOKEN=|PASSWORD=|SECRET=|API_KEY=/i);
  const network = readJson(path.join(output, 'network-plan.json'));
  assert.deepEqual(network.allowedNetworks, ['192.0.2.0/24']);
  assert.equal(network.httpsOnly, true);
  assert.deepEqual(network.loopbackOnlyPorts, [3300, 4300]);
  assert.equal(network.applyPerformed, false);
  assert.equal(readJson(path.join(output, 'resolved-services.json')).dryRun, true);
});

test('可选 LiteLLM 不生成第三个服务且仍保留其回环端口隔离计划', (t) => {
  const { output, result } = generate(t, { enableLiteLLM: false });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(output, 'CreativeStudioLiteLLM.xml')), false);
  assert.deepEqual(readJson(path.join(output, 'resolved-services.json')).services.map((service) => service.id), [
    'CreativeStudioCaddy', 'CreativeStudioApp',
  ]);
});

test('releaseId 必须与包内 manifest 一致，且 app.env 写入发布身份与模块开关', (t) => {
  const context = fixture(t);
  const releaseRoot = path.join(context.deploymentRoot, 'releases', context.config.releaseId);
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1, releaseId: context.config.releaseId, sourceCommit: 'abc123',
  }));
  const output = path.join(context.deploymentRoot, 'service');
  const result = spawnSync(process.execPath, [generator, '--config', context.configPath, '--output', output], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = fs.readFileSync(path.join(output, 'app.env'), 'utf8');
  for (const expected of [
    `CREATIVE_STUDIO_SERVER_RELEASE_ID=${context.config.releaseId}`,
    'CREATIVE_STUDIO_MODULE_BATCH=1',
    'CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO=1',
    'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1',
    'CREATIVE_STUDIO_CANVAS_ENABLE=1',
  ]) assert.ok(env.includes(expected), expected);
  const resolved = readJson(path.join(output, 'resolved-services.json'));
  assert.equal(resolved.sourceCommit, 'abc123');
  assert.deepEqual(resolved.modules, { batch: true, scriptStudio: true, canvas: true, scriptStudioScheduler: true });

  fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1, releaseId: 'different-release', sourceCommit: 'abc123',
  }));
  const mismatchOutput = path.join(context.deploymentRoot, 'service-mismatch');
  const mismatch = spawnSync(process.execPath, [generator, '--config', context.configPath, '--output', mismatchOutput], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr + mismatch.stdout, /releaseId.*manifest|manifest.*releaseId/);
  assert.equal(fs.existsSync(mismatchOutput), false);
});

test('更新清单必须同源且落在受控 /client-updates/ 目录', (t) => {
  const valid = generate(t, { clientUpdateManifestUrl: '/client-updates/current.manifest.json' });
  assert.equal(valid.result.status, 0, valid.result.stdout + valid.result.stderr);
  const env = fs.readFileSync(path.join(valid.output, 'app.env'), 'utf8');
  assert.ok(env.includes('CREATIVE_STUDIO_CLIENT_UPDATE_MANIFEST_URL=https://studio.example.test/client-updates/current.manifest.json'));
  assert.ok(fs.readFileSync(path.join(valid.output, 'Caddyfile'), 'utf8').includes('/client-updates/*'));

  for (const overrides of [
    { clientUpdateManifestUrl: 'https://evil.example.test/client-updates/current.json' },
    { clientUpdateManifestUrl: '/updates/current.json' },
    { clientUpdateManifestUrl: 'https://studio.example.test/client-updates/current.json?token=x' },
  ]) {
    const invalid = generate(t, overrides);
    assert.notEqual(invalid.result.status, 0, JSON.stringify(overrides));
    assert.equal(fs.existsSync(invalid.output), false);
  }
});

test('拒绝新旧根重叠、非回环业务端口、HTTP origin 与普通口令账号', (t) => {
  for (const [overrides, message] of [
    [{ dataRoot: path.join('C:\\old', 'nested'), oldRoots: ['C:\\old'] }, /重叠|旧目录/],
    [{ appHost: '0.0.0.0' }, /127\.0\.0\.1|回环/],
    [{ origin: 'http://studio.example.test' }, /HTTPS/],
    [{ serviceAccount: 'CONTOSO\\ordinary-user' }, /gMSA|服务账号/],
  ]) {
    const { result, output } = generate(t, overrides);
    assert.notEqual(result.status, 0, `${JSON.stringify(overrides)} 应失败`);
    assert.match(result.stderr + result.stdout, message);
    assert.equal(fs.existsSync(output), false, '输入失败时不得留下部分配置');
  }
});

test('输出目录为链接或越出租赁 service 根时 fail closed', { skip: process.platform !== 'win32' }, (t) => {
  const context = fixture(t);
  fs.mkdirSync(context.deploymentRoot, { recursive: true });
  const outside = path.join(context.directory, 'outside');
  fs.mkdirSync(outside);
  const linked = path.join(context.deploymentRoot, 'service');
  fs.symlinkSync(outside, linked, 'junction');
  const result = spawnSync(process.execPath, [generator, '--config', context.configPath, '--output', linked], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /链接|越界/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
