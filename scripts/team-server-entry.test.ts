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
  // Production keeps private provider/COS settings in the data root, outside releases.
  const privateRoot = path.join(fixtureRoot, 'private-data');
  fs.mkdirSync(privateRoot, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, '.env.local'), [
    'CREATIVE_STUDIO_COS_SECRET_ID=fixture-id',
    'CREATIVE_STUDIO_COS_SECRET_KEY="fixture-secret"',
    'CREATIVE_STUDIO_COS_DOMAIN=https://media.example.test',
    'CREATIVE_STUDIO_CANVAS_EXECUTOR=company',
    'CREATIVE_STUDIO_PORT=9999',
    'HOSTNAME=0.0.0.0',
  ].join('\n'));
  const envProbe = path.join(fixtureRoot, 'env-probe.cjs');
  fs.writeFileSync(envProbe, `
    const assert = require('node:assert/strict');
    assert.equal(process.env.CREATIVE_STUDIO_COS_SECRET_ID, 'fixture-id');
    assert.equal(process.env.CREATIVE_STUDIO_COS_SECRET_KEY, 'fixture-secret');
    assert.equal(process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR, 'company');
    assert.equal(process.env.PORT, '3300');
    assert.equal(process.env.HOSTNAME, '127.0.0.1');
  `);
  const privateEnv = await runEntry({ serverRoot: fixtureRoot, env: {
    CREATIVE_STUDIO_DATA_ROOT: privateRoot,
    CREATIVE_STUDIO_STANDALONE_SERVER: envProbe,
    CREATIVE_STUDIO_COS_SECRET_ID: undefined,
    CREATIVE_STUDIO_COS_SECRET_KEY: undefined,
    CREATIVE_STUDIO_CANVAS_EXECUTOR: undefined,
  } });
  assert.equal(privateEnv.code, 0, privateEnv.stderr);

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

  // Separate process: a slow synchronous snapshot can defer Node's socket-close
  // notification after the proxy has already expired its idle connection.
  let paidPosts = 0;
  const proxySockets = new Set<net.Socket>();
  const proxy = net.createServer(socket => {
    proxySockets.add(socket);
    socket.on('close', () => proxySockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(300, () => socket.destroy());
    let incoming = '';
    socket.on('data', chunk => {
      incoming += String(chunk);
      const boundary = incoming.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = incoming.slice(0, boundary);
      const length = Number(/content-length: (\d+)/i.exec(header)?.[1] || 0);
      if (Buffer.byteLength(incoming.slice(boundary + 4)) < length) return;
      incoming = '';
      const post = header.startsWith('POST ');
      if (post) paidPosts += 1;
      const body = post ? '{"ok":true}' : '{}';
      const response = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '
        + Buffer.byteLength(body) + '\r\n\r\n' + body;
      // Like Uvicorn: no Keep-Alive timeout hint in the response.
      if (/connection: close/i.test(header)) socket.end(response);
      else socket.write(response);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address();
    assert.ok(address && typeof address === 'object');
    const probePath = path.join(fixtureRoot, 'idle-proxy-probe.cjs');
    fs.writeFileSync(probePath, `
      const assert = require('node:assert/strict');
      (async () => {
        const base = 'http://127.0.0.1:${address.port}';
        await fetch(base + '/health').then(r => r.text());
        await fetch(base + '/health').then(r => r.text());
        await new Promise(resolve => setImmediate(resolve));
        const deadline = Date.now() + 650;
        while (Date.now() < deadline) {}
        const result = await fetch(base + '/complete', {
          method: 'POST', body: '{"fixture":true}',
          headers: { 'Content-Type': 'application/json' },
        }).then(r => r.json());
        assert.deepEqual(result, { ok: true });
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const idleResult = await runEntry({serverRoot, env:{CREATIVE_STUDIO_STANDALONE_SERVER:probePath}});
    assert.equal(idleResult.code, 0, `代理已回收空闲连接时，新的模型 POST 不能复用失效连接：${idleResult.stderr}`);
    assert.equal(paidPosts, 1, '通过新连接预防失败，不得通过自动重提 POST 掩盖失败');
  } finally {
    for (const socket of proxySockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }

  const fetchPreload = path.join(fixtureRoot, 'fetch-preload.cjs');
  fs.writeFileSync(fetchPreload, `
    globalThis.__fetchCalls = [];
    globalThis.fetch = async (input, init) => {
      globalThis.__fetchCalls.push({input, init});
      return new Response('{}', {status: 200});
    };
  `);
  const fetchProbe = path.join(fixtureRoot, 'fetch-probe.cjs');
  fs.writeFileSync(fetchProbe, `
    const assert = require('node:assert/strict');
    (async () => {
      const controller = new AbortController();
      const headers = new Headers({'Authorization':'fixture', 'Content-Type':'application/json'});
      const init = {method:'POST', body:'{"fixture":true}', signal:controller.signal, headers};
      await fetch('http://127.0.0.1:4300/v1/chat/completions', init);
      const call = globalThis.__fetchCalls.at(-1);
      assert.equal(call.init.headers.get('connection'), 'close');
      assert.equal(call.init.headers.get('authorization'), 'fixture');
      assert.equal(call.init.body, init.body);
      assert.equal(call.init.signal, controller.signal);
      assert.equal(headers.has('connection'), false);
      const request = new Request('http://[::1]:4000/health', {headers:{'x-fixture':'request'}});
      await fetch(request);
      assert.equal(globalThis.__fetchCalls.at(-1).init.headers.get('x-fixture'), 'request');
      for (const url of ['https://127.0.0.1:4300/test','https://provider.example.test/v1','http://127.0.0.1.example.test/test']) {
        await fetch(url, init);
        assert.equal(globalThis.__fetchCalls.at(-1).init, init);
      }
      await fetch(new URL('http://localhost:4000/health'));
      assert.equal(globalThis.__fetchCalls.at(-1).init.headers.get('connection'), 'close');
      assert.equal(globalThis.__fetchCalls.length, 6);
    })().catch(error => {console.error(error); process.exitCode=1;});
  `);
  const fetchResult = await runEntry({serverRoot,preload:fetchPreload,env:{CREATIVE_STUDIO_STANDALONE_SERVER:fetchProbe}});
  assert.equal(fetchResult.code, 0, fetchResult.stderr);

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
