import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const litellm = path.join(projectRoot, '.venv-litellm', 'bin', 'litellm');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntilReady(url, child, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`LiteLLM 提前退出：${stderr().slice(-1200)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`LiteLLM 30 秒内未就绪：${stderr().slice(-1200)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-litellm-timeout-'));
const upstreamPort = await freePort();
const proxyPort = await freePort();
let received = 0;
let closedBeforeResponse = 0;
let resolveClosed;
const closed = new Promise((resolve) => { resolveClosed = resolve; });

const upstream = http.createServer((request, response) => {
  received += 1;
  request.resume();
  response.on('close', () => {
    if (!response.writableEnded) {
      closedBeforeResponse += 1;
      resolveClosed();
    }
  });
  // 故意不响应：由 LiteLLM Router 的 1 秒上游超时负责取消连接。
});
await new Promise((resolve, reject) => {
  upstream.once('error', reject);
  upstream.listen(upstreamPort, '127.0.0.1', resolve);
});

const configPath = path.join(tempRoot, 'config.yaml');
fs.writeFileSync(configPath, `model_list:
  - model_name: local-timeout-probe
    litellm_params:
      model: openai/local-timeout-probe
      api_base: http://127.0.0.1:${upstreamPort}/v1
      api_key: local-test-key

router_settings:
  routing_strategy: simple-shuffle
  num_retries: 0
  timeout: 1

litellm_settings:
  drop_params: true
`);

const childEnv = { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True', PYTHONUTF8: '1' };
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete childEnv[name];
}
let stderrText = '';
const child = spawn(litellm, [
  '--config', configPath,
  '--host', '127.0.0.1',
  '--port', String(proxyPort),
], {
  cwd: projectRoot,
  env: childEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderrText += chunk; });

try {
  await waitUntilReady(`http://127.0.0.1:${proxyPort}/health/liveliness`, child, () => stderrText);
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'local-timeout-probe',
      messages: [{ role: 'user', content: 'timeout probe' }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.text();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.ok, false, 'Router 上游超时必须返回失败');
  assert.ok(elapsedMs >= 800 && elapsedMs < 5_000, `Router 超时应在约 1 秒生效，实际 ${elapsedMs}ms`);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('上游连接未在 Router 超时后关闭')), 3_000)),
  ]);
  assert.equal(received, 1, 'num_retries=0 时只允许一次上游请求');
  assert.equal(closedBeforeResponse, 1, 'Router 超时必须主动关闭仍在推理的上游连接');
  console.log(`litellm-router-timeout.test.mjs: ok (${elapsedMs}ms, upstream requests=${received})`);
} finally {
  await stopChild(child);
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
