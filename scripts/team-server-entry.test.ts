import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-entry-'));
const entryPath = fileURLToPath(new URL('../runtime/team-server-entry.cjs', import.meta.url));

interface EntryResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function runEntry(options: {
  serverRoot: string;
  env?: Record<string, string | undefined>;
  preload?: string;
}): Promise<EntryResult> {
  const env = { ...process.env };
  for (const key of [
    'CREATIVE_STUDIO_DEPLOYMENT_MODE',
    'CREATIVE_STUDIO_DATA_ROOT',
    'CREATIVE_STUDIO_PORT',
    'CREATIVE_STUDIO_DEPLOYMENT_ID',
    'CREATIVE_STUDIO_TRUSTED_ORIGIN',
    'CREATIVE_STUDIO_SERVER_ROOT',
    'CREATIVE_STUDIO_STANDALONE_SERVER',
    'PORT',
    'HOSTNAME',
  ]) delete env[key];
  Object.assign(env, {
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: path.join(fixtureRoot, 'data'),
    CREATIVE_STUDIO_PORT: '3300',
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-entry',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
    CREATIVE_STUDIO_SERVER_ROOT: options.serverRoot,
  }, options.env);
  if (options.preload) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(options.preload)}`.trim();
  }
  const child = spawn(process.execPath, [entryPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  const serverRoot = path.join(fixtureRoot, 'standalone');
  fs.mkdirSync(serverRoot, { recursive: true });
  const standaloneServer = path.join(serverRoot, 'server.js');
  fs.writeFileSync(standaloneServer, `
    const { startServer } = require('next/dist/server/lib/start-server');
    void startServer({ hostname: '0.0.0.0', port: 0 }).then((options) => {
      process.stdout.write(JSON.stringify({
        options,
        checks: globalThis.__entryChecks,
        portEnv: process.env.PORT,
        hostnameEnv: process.env.HOSTNAME,
      }) + '\\n');
    });
  `);
  const preload = path.join(fixtureRoot, 'mock-next.cjs');
  fs.writeFileSync(preload, `
    const http = require('node:http');
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'next/dist/server/lib/start-server') {
        return { startServer: (options) => new Promise((resolve, reject) => {
          const server = http.createServer((request, response) => {
            if (request.url?.startsWith('/api/team/health/ready')) {
              if (request.url.includes('fixtureReady=1')) {
                globalThis[Symbol.for('creative-studio.team-runtime-state')] = {
                  value: { live: true, ready: true, maintenance: false, phase: 'ready' },
                };
              }
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end('{}');
              return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ businessHandler: true }));
          });
          server.once('error', reject);
          server.listen(options.port, options.hostname, () => {
            void (async () => {
              const base = 'http://127.0.0.1:' + options.port;
              const businessBefore = await fetch(base + '/api/projects').then((res) => res.status);
              const live = await fetch(base + '/api/team/health/live').then((res) => res.status);
              const operationBefore = await fetch(base + '/api/team/operations/status').then((res) => res.status);
              await fetch(base + '/api/team/health/ready?fixtureReady=1');
              const businessAfter = await fetch(base + '/api/projects').then((res) => res.status);
              globalThis.__entryChecks = { businessBefore, live, operationBefore, businessAfter };
              server.close((error) => error ? reject(error) : resolve(options));
            })().catch(reject);
          });
        }) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `);

  const port = await availablePort();
  const success = await runEntry({
    serverRoot,
    preload,
    env: { CREATIVE_STUDIO_PORT: String(port) },
  });
  assert.equal(success.code, 0, success.stderr);
  const report = JSON.parse(success.stdout.trim().split('\n').at(-1) ?? '') as {
    options: { hostname: string; port: number };
    checks: { businessBefore: number; live: number; operationBefore: number; businessAfter: number };
    portEnv: string;
    hostnameEnv: string;
  };
  assert.deepEqual(report, {
    options: { hostname: '127.0.0.1', port },
    checks: { businessBefore: 503, live: 200, operationBefore: 200, businessAfter: 200 },
    portEnv: String(port),
    hostnameEnv: '127.0.0.1',
  }, '公共入口使用固定回环端口，且只在 team readiness 后开放业务处理器');

  let serverLoaded = false;
  const forbiddenServer = path.join(fixtureRoot, 'forbidden-server.cjs');
  fs.writeFileSync(forbiddenServer, `
    require('node:fs').writeFileSync(${JSON.stringify(path.join(fixtureRoot, 'loaded'))}, 'loaded');
  `);
  const invalid = await runEntry({
    serverRoot,
    env: {
      CREATIVE_STUDIO_STANDALONE_SERVER: forbiddenServer,
      CREATIVE_STUDIO_PORT: '0',
    },
  });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /CREATIVE_STUDIO_PORT/);
  serverLoaded = fs.existsSync(path.join(fixtureRoot, 'loaded'));
  assert.equal(serverLoaded, false, '固定端口配置无效时不得加载 standalone 业务服务');

  const missingMode = await runEntry({
    serverRoot,
    env: {
      CREATIVE_STUDIO_STANDALONE_SERVER: forbiddenServer,
      CREATIVE_STUDIO_DEPLOYMENT_MODE: undefined,
    },
  });
  assert.notEqual(missingMode.code, 0);
  assert.match(missingMode.stderr, /DEPLOYMENT_MODE/);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'loaded')), false);

  assert.equal(
    fs.existsSync(path.join(fixtureRoot, 'data', 'workbench.db')),
    false,
    '入口参数测试不得创建业务数据库',
  );
  console.log('team server entry tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
