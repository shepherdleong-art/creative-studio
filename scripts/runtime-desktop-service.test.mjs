// scripts/runtime-desktop-service.test.mjs
// desktop-service.mjs 单测：本地 http server 模拟 /api/desktop/health 与 /api/shutdown，
// 验证 health 核身、instance 不匹配不误杀、完整停机链走通。直接调函数测，不 spawn CLI。
// 红线断言：instance 不匹配时绝不请求 shutdown、绝不杀进程；origin 非法绝不请求。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchHealthInstance,
  readServiceState,
  stopDesktopService,
  validateOrigin,
} from './runtime/desktop-service.mjs';

/** 起一个回环测试服务，跟踪 socket 以便关闭时彻底断开（让后续探测连接被拒）。 */
function startServer(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      let closed = false;
      const close = () =>
        new Promise((done) => {
          if (closed) return done();
          closed = true;
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        });
      resolve({ server, port, close });
    });
  });
}

function writeServiceState(rootDir, state) {
  const file = path.join(rootDir, 'storage', 'run', 'electron-service.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
}

// ── 1. instance 匹配 → 完整停机链走通：POST /api/shutdown 后服务下线 ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-1-'));
  const hits = [];
  const { port, close } = await startServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/desktop/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instanceId: 'instance-1' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      res.end('bye');
      // 模拟 /api/shutdown 结束自身进程：稍等响应发出后关闭服务并断开连接。
      setTimeout(() => {
        close();
      }, 50);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  writeServiceState(rootDir, {
    version: 1,
    origin: `http://127.0.0.1:${port}`,
    instanceId: 'instance-1',
    pid: 999_999_998, // 服务正常下线，强杀分支不会走到。
  });
  const result = await stopDesktopService(rootDir, { shutdownBudgetMs: 2_000, pollTimeoutMs: 5_000 });
  assert.equal(result.stopped, true, '匹配实例应完整停止');
  assert.equal(result.reason, 'stopped');
  assert.equal(result.origin, `http://127.0.0.1:${port}`);
  assert.ok(hits.some((h) => h === 'POST /api/shutdown'), '应发出优雅停机请求');
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── 2. instance 不匹配 → 不请求 shutdown、不杀、reason=instance-mismatch ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-2-'));
  const hits = [];
  const { port, close } = await startServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/desktop/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instanceId: 'other-instance' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  writeServiceState(rootDir, {
    version: 1,
    origin: `http://127.0.0.1:${port}`,
    instanceId: 'expected-id',
  });
  const result = await stopDesktopService(rootDir);
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'instance-mismatch');
  assert.equal(hits.some((h) => h.startsWith('POST')), false, 'instance 不匹配时绝不请求 shutdown');
  assert.equal(hits.filter((h) => h.startsWith('GET /api/desktop/health')).length, 1);
  await close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── 3. 状态文件无记录 → no-state ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-3-'));
  const result = await stopDesktopService(rootDir);
  assert.deepEqual(result, { stopped: false, reason: 'no-state' });
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── 4. origin 非法（非 127.0.0.1）→ invalid-origin，绝不请求 ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-4-'));
  writeServiceState(rootDir, { version: 1, origin: 'http://localhost:9999', instanceId: 'x' });
  const result = await stopDesktopService(rootDir);
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'invalid-origin');
  assert.equal(validateOrigin('http://localhost:3000'), null);
  assert.equal(validateOrigin('https://127.0.0.1:3000'), null);
  assert.equal(validateOrigin('http://127.0.0.1:65536'), null);
  assert.equal(validateOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── 5. 服务一直在线 + 状态无 pid → poll-timeout 后只报告 unknown-owner ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-5-'));
  const hits = [];
  const { port, close } = await startServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/desktop/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instanceId: 'ins-5' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      res.end('ok'); // 响应在线，不关闭：模拟优雅停机失败。
      return;
    }
    res.writeHead(404);
    res.end();
  });
  writeServiceState(rootDir, { version: 1, origin: `http://127.0.0.1:${port}`, instanceId: 'ins-5' });
  const result = await stopDesktopService(rootDir, { shutdownBudgetMs: 1_000, pollTimeoutMs: 800 });
  assert.equal(result.stopped, false, '没有可归属 pid 时绝不强杀：unknown-owner');
  assert.equal(result.reason, 'unknown-owner');
  assert.equal(result.pid, null);
  assert.ok(hits.some((h) => h === 'POST /api/shutdown'), '应先请求优雅停机');
  await close();
  fs.rmSync(rootDir, { recursive: true, force: true });
}

// ── 6. fetchHealthInstance 直测：在线返回 instanceId；404 与超时返回 null ──
{
  const { port, close } = await startServer((req, res) => {
    if (req.url === '/api/desktop/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instanceId: 'ins-6' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  assert.equal(await fetchHealthInstance(`http://127.0.0.1:${port}`), 'ins-6');
  assert.equal(await fetchHealthInstance(`http://127.0.0.1:${port}/missing`), null, '404 应返回 null');
  await close();

  // 永不响应 → 超时返回 null。
  const hanging = await startServer(() => {
    // 故意不 res.end。
  });
  assert.equal(await fetchHealthInstance(`http://127.0.0.1:${hanging.port}`, 300), null, '超时应返回 null');
  await hanging.close();
}

// ── 7. readServiceState 直测：缺文件/非法 origin/正常三元组 ──
{
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ds-7-'));
  assert.deepEqual(readServiceState(rootDir), { found: false, reason: 'no-state' });
  writeServiceState(rootDir, { version: 1, origin: 'http://192.168.1.1:3000', instanceId: 'x' });
  assert.equal(readServiceState(rootDir).reason, 'invalid-origin');
  writeServiceState(rootDir, { version: 1, origin: 'http://127.0.0.1:8123', instanceId: 'abc-123' });
  assert.deepEqual(readServiceState(rootDir), {
    found: true,
    version: 1,
    origin: 'http://127.0.0.1:8123',
    instanceId: 'abc-123',
    pid: null,
  });
  // instanceId 格式非法（无法用于核身）→ 按不可用处理。
  writeServiceState(rootDir, { version: 1, origin: 'http://127.0.0.1:8123', instanceId: 'bad id!' });
  assert.equal(readServiceState(rootDir).reason, 'unreadable');
  assert.deepEqual(
    await stopDesktopService(rootDir),
    { stopped: false, reason: 'unreadable' },
    'instanceId 非法时不得请求/不得杀进程',
  );
  fs.rmSync(rootDir, { recursive: true, force: true });
}

console.log('runtime desktop-service test passed');
