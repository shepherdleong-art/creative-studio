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
  if (body.model === 'qiniuyun/kling-4.0' && body.size === '1080x1440') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'invalid_kling_v4_request', message: 'Kling v4 does not support aspect_ratio "3:4" for this operation' }));
    return;
  }
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
${['qiniuyun/kling-3.0', 'qiniuyun/kling-4.0', 'minimax-h3', 'wan-3.0'].map(model => `  - model_name: ${model}
    litellm_params:
      model: openai/${model}
      api_base: http://127.0.0.1:${server.address().port}/v1
      api_key: local-fake-key
`).join('')}
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
  for (const [model, resolution, durationSec] of [['minimax-h3', '2K', 15], ['wan-3.0', '1080P', 30]]) {
    for (const tail of [false, true]) {
      const result = await openaiVideoAdapter.submit({
        model, prompt: 'native forwarding fixture', sourceImagePath: imagePath, sourceMimeType: 'image/png', durationSec,
        ...(tail ? { tailImagePath: imagePath, tailMimeType: 'image/png' } : {}),
      }, 'local-fake-key', `http://127.0.0.1:${port}`);
      assert.ok(result.providerTaskId);
      const forwarded = captured.at(-1);
      const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
      assert.equal(forwarded.model, model);
      assert.equal(String(forwarded.seconds), String(durationSec));
      assert.deepEqual(decode(forwarded.OutputConfig), {
        Duration: durationSec, Resolution: resolution, ...(model === 'wan-3.0' ? { AspectRatio: '4:3' } : {}),
      });
      const frames = decode(forwarded.FileInfos);
      assert.deepEqual(frames.map(frame => frame.Usage), tail ? ['FirstFrame', 'LastFrame'] : ['FirstFrame']);
      assert.ok(frames.every(frame => frame.Url.startsWith('https://cos-fixture.example.com/')));
      for (const field of ['images', 'multi_shot', 'shot_type', 'size']) assert.equal(forwarded[field], undefined);
    }
  }
  for (const { width, tail, middle } of [
    { width: 800, tail: false, middle: false },
    { width: 900, tail: true, middle: false },
    { width: 900, tail: true, middle: true },
  ]) {
    const portraitPath = path.join(temp, `portrait-${width}.png`);
    await sharp({ create: { width, height: 1200, channels: 3, background: '#336699' } }).png().toFile(portraitPath);
    const middlePath = path.join(temp, 'portrait-middle.png');
    if (middle) await sharp({ create: { width, height: 1200, channels: 3, background: '#aa7755' } }).png().toFile(middlePath);
    const result = await openaiVideoAdapter.submit({
      model: 'qiniuyun/kling-4.0', prompt: 'portrait forwarding fixture',
      sourceImagePath: portraitPath, sourceMimeType: 'image/png', durationSec: 5, resolution: '1080p',
      ...(tail ? { tailImagePath: portraitPath, tailMimeType: 'image/png' } : {}),
      ...(middle ? { middleFrames: [{ id: 'middle', kind: 'image', path: middlePath, mimeType: 'image/png',
        byteSize: fs.statSync(middlePath).size }] } : {}),
    }, 'local-fake-key', `http://127.0.0.1:${port}`);
    assert.ok(result.providerTaskId);
    const forwarded = captured.at(-1);
    assert.equal(forwarded.model, 'qiniuyun/kling-4.0');
    assert.equal(forwarded.resolution, '1080p');
    assert.equal(Number(forwarded.duration), 5);
    assert.equal(forwarded.size, undefined);
    assert.equal(forwarded.aspect_ratio, undefined);
    assert.ok(forwarded.start_image_url.startsWith('https://cos-fixture.example.com/'));
    assert.equal(Boolean(forwarded.end_image_url), tail);
    if (middle) {
      const middleUrls = typeof forwarded.middle_image_urls === 'string'
        ? JSON.parse(forwarded.middle_image_urls) : forwarded.middle_image_urls;
      assert.equal(middleUrls.length, 1);
      assert.ok(middleUrls[0].startsWith('https://cos-fixture.example.com/'));
      assert.notEqual(middleUrls[0], forwarded.start_image_url);
    } else {
      assert.equal(forwarded.middle_image_urls, undefined);
    }
  }
  const referenceUrl = 'https://cos-fixture.example.com/reference.png';
  const reference = await openaiVideoAdapter.submitReference({
    model: 'qiniuyun/kling-4.0', prompt: 'single reference forwarding fixture', durationSec: 5,
    aspectRatio: '9:16', resolution: '1080p', references: [{ kind: 'image', mimeType: 'image/png', url: referenceUrl }],
  }, 'local-fake-key', `http://127.0.0.1:${port}`);
  assert.ok(reference.providerTaskId);
  const forwardedReference = captured.at(-1);
  const imageUrls = typeof forwardedReference.image_urls === 'string'
    ? JSON.parse(forwardedReference.image_urls) : forwardedReference.image_urls;
  assert.deepEqual(imageUrls, [referenceUrl]);
  assert.equal(forwardedReference.aspect_ratio, '9:16');
  assert.equal(forwardedReference.resolution, '1080p');
  assert.equal(forwardedReference.start_image_url, undefined);
  assert.equal(forwardedReference.end_image_url, undefined);
  assert.equal(captured.length, 10);
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
