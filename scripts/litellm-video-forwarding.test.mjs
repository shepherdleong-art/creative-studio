import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

// Real local LiteLLM -> loopback capture server. No company connection or real keys.
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-forwarding-'));
const python = process.platform === 'win32'
  ? path.join(root, '.venv-litellm', 'Scripts', 'python.exe')
  : path.join(root, '.venv-litellm', 'bin', 'python');
const captured = [];
const server = http.createServer(async (req, res) => {
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const raw = Buffer.concat(buffers);
  const contentType = String(req.headers['content-type']);
  let body;
  if (contentType.includes('application/json')) body = JSON.parse(raw.toString());
  else {
    const form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData();
    body = Object.fromEntries(form.entries());
  }
  captured.push(body);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'fake-video', object: 'video', status: 'queued', created_at: 1, model: body.model }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const config = path.join(temp, 'config.yaml');
fs.writeFileSync(config, `model_list:
  - model_name: qiniuyun/kling-3.0
    litellm_params:
      model: openai/qiniuyun/kling-3.0
      api_base: http://127.0.0.1:${server.address().port}/v1
      api_key: local-fake-key
router_settings:
  num_retries: 0
  timeout: 15
litellm_settings:
  drop_params: true
`);
const env = { ...process.env, PYTHONUTF8: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
const child = spawn(python, [path.join(root, 'scripts/start-litellm-proxy.py'), '--config', config, '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
const originalFetch = globalThis.fetch;
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`Proxy exited: ${stderr}`);
    try { ready = (await fetch(`http://127.0.0.1:${port}/health/liveliness`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Local test proxy did not start');
  process.env.CREATIVE_STUDIO_DATA_ROOT = temp;
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'fake-id';
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'fake-key';
  process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos-fixture.example.com';
  process.env.CREATIVE_STUDIO_COS_SIGN_HOST = 'cos-fixture.example.com';
  const { _setCompanyTailFrameRuntimeInspectorForTest } = await import('../lib/company-gateway-tail-frame.ts');
  _setCompanyTailFrameRuntimeInspectorForTest(async () => ({ status: 'ready', reason: '', proxyAvailable: true, cosConfigured: true, startedAt: null }));
  const { openaiVideoAdapter } = await import('../lib/video-providers/openai-video.ts');
  const imagePath = path.join(temp, 'source.png');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).png().toFile(imagePath);
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'cos-fixture.example.com') return Promise.resolve(new Response(null, { status: 200 }));
    assert.equal(url.origin, `http://127.0.0.1:${port}`, 'Application fixture must only contact the isolated proxy');
    return originalFetch(input, init);
  };
  for (const multiShot of [true, false]) {
    const result = await openaiVideoAdapter.submit({ model: 'qiniuyun/kling-3.0', prompt: 'local fixture', sourceImagePath: imagePath, sourceMimeType: 'image/png', durationSec: 5, multiShot }, 'local-fake-key', `http://127.0.0.1:${port}`);
    assert.ok(result.providerTaskId);
    const forwarded = captured.at(-1);
    console.log(JSON.stringify({ model: forwarded.model, multi_shot: forwarded.multi_shot, shot_type: forwarded.shot_type ?? null }));
    assert.equal(forwarded.shot_type, multiShot ? 'intelligence' : undefined);
    assert.ok([multiShot, String(multiShot)].includes(forwarded.multi_shot));
  }
  assert.equal(captured.length, 2);
  console.log('litellm video forwarding tests passed');
} finally {
  globalThis.fetch = originalFetch;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // The temporary directory is created by this test; no user paths are removed.
  fs.rmSync(temp, { recursive: true, force: true });
}
