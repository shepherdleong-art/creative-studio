// 第 16 票。npm run build 后运行 node scripts/one-click-film-employee.playwright.test.mjs。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import JSZip from 'jszip';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createUiAcceptanceApi } from './team-server/ui-acceptance-fixtures.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-click-film-employee-'));
const serverRoot = process.env.OCF_ACCEPTANCE_STANDALONE_DIR
  ? path.resolve(process.env.OCF_ACCEPTANCE_STANDALONE_DIR)
  : path.join(repo, '.next', 'standalone');
const useDev = process.env.OCF_ACCEPTANCE_DEV === '1';
const output = process.env.OCF_ACCEPTANCE_OUTPUT && path.resolve(process.env.OCF_ACCEPTANCE_OUTPUT);
const ffmpegPath = process.env.CREATIVE_STUDIO_FFMPEG || ffmpeg;
const ffprobePath = process.env.CREATIVE_STUDIO_FFPROBE || ffprobe.path;
const native = (exe, args) => execFileSync(exe, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const submitted = [];
const calls = new Map();
const localErrors = [];
let app, browser, fixture, page;
let serverLog = '';
let startupLog = '';
let stage = '启动';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function ff(args) { return native(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }
function colors(file, values, durations, frequency, size) {
  const segments = values.flatMap((color, index) => ['-f', 'lavfi', '-i', `color=c=${color}:size=${size}:rate=24:duration=${durations[index]}`]);
  const video = values.map((_, index) => `[${index}:v]`).join('');
  const duration = durations.reduce((sum, value) => sum + value, 0);
  ff([...segments, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
    '-filter_complex', `${video}concat=n=${values.length}:v=1:a=0[v]`, '-map', '[v]', '-map', `${values.length}:a`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file]);
}

function fixtureJson(request, response, json) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(json));
}

function fixtures() {
  const assets = new Map();
  for (const [name, size] of [['draft', '216x288'], ['hd', '270x360']]) {
    const original = path.join(root, `${name}.mp4`);
    const candidate = path.join(root, `${name}-candidate.mp4`);
    colors(original, ['0x102040', '0xf0f0f0', '0x205040'], [6, 3, 6], 330, size);
    colors(candidate, ['0x404040', '0x6040c0', '0x707070'], [1, 3, 1], 990, size);
    assets.set(`${name}.mp4`, original);
    assets.set(`${name}-candidate.mp4`, candidate);
  }
  const redraw = path.join(root, 'redraw.mp4');
  colors(redraw, ['0x904020', '0x40a0c0', '0x202020'], [3, 5, 7], 770, '216x288');
  assets.set('redraw.mp4', redraw);
  const music = path.join(root, 'fixture-bgm.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=18', music]);
  return { assets, music };
}

function mockProvider(media) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/media/')) {
        const file = media.assets.get(path.basename(url.pathname));
        if (!file) throw new Error('未知媒体样本');
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(file).size });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/contents/generations/tasks/')) {
        const id = path.basename(url.pathname);
        const job = calls.get(id);
        assert.ok(job, '轮询必须使用已提交的任务标识');
        fixtureJson(req, res, { id, model: 'doubao-seedance-2-5-260628', status: 'succeeded',
          content: { video_url: `http://127.0.0.1:${fixture.address().port}/media/${job.media}` } });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        fixtureJson(req, res, { text: '这是原片旁白。', words: [
          { word: '这是', start: 1, end: 1.3 }, { word: '原片旁白。', start: 1.3, end: 2.8 },
        ] });
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.method === 'POST' && url.pathname === '/contents/generations/tasks') {
        const id = `film-fixture-${submitted.length + 1}`;
        const prompt = body.content.find((item) => item.type === 'text')?.text;
        const draftId = body.content.find((item) => item.type === 'draft_task')?.draft_task?.id;
        const draft = calls.get(draftId);
        if (draftId) assert.ok(draft, '高清必须引用之前提交的供应商样片标识');
        const isCandidate = draft?.isCandidate ?? (typeof prompt === 'string' && prompt.includes('重新生成正文第'));
        const mediaName = prompt?.includes('整条重抽') ? 'redraw.mp4' : `${draftId ? 'hd' : 'draft'}${isCandidate ? '-candidate' : ''}.mp4`;
        const info = { id, media: mediaName, isCandidate, request: body, prompt, draftId };
        calls.set(id, info);
        submitted.push(info);
        fixtureJson(req, res, { id, status: 'queued' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const user = body.messages.find((message) => message.role === 'user')?.content;
        const text = typeof user === 'string' ? user : user.find((item) => item.type === 'text')?.text;
        if (text.includes('analyze_product_material_for_short_video')) {
          fixtureJson(req, res, { choices: [{ message: { content: JSON.stringify({
            productName: '云朵床', appearance: '米白布艺靠背和卧室', sceneClues: '窗边卧室',
            points: [{ text: '坐到床边放松', kind: 'usage', sourcePageIndex: 0, tileRefs: ['tile_1'] },
              { text: '软包靠背可倚靠', kind: 'claim', sourcePageIndex: 1, tileRefs: ['tile_1'] }],
          }) } }] });
        } else {
          const script = JSON.parse(text);
          assert.equal(script.task, 'write_one_click_film_script');
          const take = script.previous ? '重写稿' : '初稿';
          fixtureJson(req, res, { choices: [{ message: { content: JSON.stringify({
            title: `${script.entry} ${take}`, angle: script.structure,
            outline: `${script.entry} ${take}大纲，坐到云朵床边并倚靠。`,
            narration: `${script.entry} ${take}口播，我坐到床边，靠在软包上。`,
            shots: Array.from({ length: 6 }, (_, index) => `中近景｜侧跟｜${take}动作 ${index + 1}，自然倚靠床头。`),
          }) } }] });
        }
        return;
      }
      throw new Error(`未声明的样本请求 ${req.method} ${url.pathname}`);
    } catch (error) {
      localErrors.push(error.message);
      res.writeHead(500);
      res.end('invalid fixture request');
    }
  });
}

async function waitForReady(base) {
  let last = '';
  let errors = 0;
  for (let i = 0; i < 240; i++) {
    if (app.exitCode !== null) throw new Error(`团队服务提前退出 ${app.exitCode}`);
    try {
      const response = await fetch(`${base}/api/team/health/ready`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
      last = `HTTP ${response.status} ${(await response.text()).slice(0, 500)}`;
      if (response.status === 500) errors += 1;
    } catch { /* 等浏览器服务启动 */ }
    if (errors >= 3) throw new Error(`团队服务启动后无法读取健康检查。${last}`);
    await delay(500);
  }
  throw new Error(`隔离团队服务启动超时。${last}`);
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function responseBytes(url) {
  const response = await page.request.get(url);
  assert.equal(response.status(), 200, url);
  return response.body();
}
function metadata(file) {
  return JSON.parse(native(ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file]));
}
function pixelFrames(file) {
  return ff(['-i', file, '-an', '-vf', 'crop=8:8:4:120,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
}
function pixelsNear(left, right, tolerance = 6) {
  return left.length === right.length && [...left].every((value, index) => Math.abs(value - right[index]) <= tolerance);
}
function assertLocalEdit(original, edited) {
  const before = pixelFrames(original);
  const after = pixelFrames(edited);
  assert.equal(before.length, 360 * 3);
  assert.equal(after.length, before.length);
  for (let frame = 0; frame < 360; frame += 1) {
    const slice = (bytes) => bytes.subarray(frame * 3, frame * 3 + 3);
    assert.equal(pixelsNear(slice(before), slice(after)), frame < 144 || frame >= 216, `换镜帧 ${frame}`);
  }
}
function tone(file, start, frequency) {
  const samples = ff(['-ss', String(start), '-i', file, '-t', '0.12', '-vn', '-ac', '1', '-ar', '12000', '-f', 's16le', 'pipe:1']);
  let real = 0, imaginary = 0;
  for (let i = 0; i < samples.length / 2; i++) {
    const sample = samples.readInt16LE(i * 2);
    const radians = 2 * Math.PI * frequency * i / 12000;
    real += sample * Math.cos(radians);
    imaginary += sample * Math.sin(radians);
  }
  return Math.hypot(real, imaginary) / (samples.length / 2);
}
function assertContinuousAudio(file, offset, bgm = false) {
  for (const second of [5.6, 5.96, 6.5, 8.96, 9.1, 12.4, 14.72]) {
    const original = tone(file, second + offset, 330);
    assert.ok(original > 250, `原声在 ${second}s 丢失`);
    assert.ok(tone(file, second + offset, 990) < original / 25, `在 ${second}s 听到候选音轨`);
    if (bgm) assert.ok(tone(file, second + offset, 550) > 45, `在 ${second}s 没有配乐`);
  }
  for (const cut of [6, 9]) {
    const samples = ff(['-ss', String(cut + offset - 0.1), '-i', file, '-t', '0.2',
      '-vn', '-ac', '1', '-ar', '12000', '-f', 's16le', 'pipe:1']);
    assert.ok(samples.length >= 4800, `${cut}s 接缝缺少音频样本`);
    for (let start = 0; start < 2400; start += 120) {
      let power = 0;
      for (let sample = start; sample < start + 120; sample += 1) power += samples.readInt16LE(sample * 2) ** 2;
      assert.ok(Math.sqrt(power / 120) > 500, `${cut}s 接缝第 ${start / 12} ms 出现静音`);
    }
  }
}

function assertPackagedVisuals(file, code) {
  const width = 90;
  const height = 120;
  const gray = ff(['-i', file, '-an', '-vf', `scale=${width}:${height}`, '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(gray.length, width * height * 380);
  const changed = (left, right, top, bottom) => {
    let count = 0;
    for (let pixel = top * width; pixel < bottom * width; pixel += 1) {
      if (Math.abs(gray[left * width * height + pixel] - gray[right * width * height + pixel]) > 18) count += 1;
    }
    return count;
  };
  const coverPixels = changed(19, 20, 0, height);
  assert.ok(coverPixels > 250, `${code} 第 19 帧有封面，第 20 帧切回正文，变化像素 ${coverPixels}`);
  const captionPixels = changed(42, 52, 90, 116);
  assert.ok(captionPixels > 12, `${code} 对时后的字幕没有烧进画面，变化像素 ${captionPixels}`);
  const decorationPixels = code === 'F02' ? changed(113, 122, 19, 70) : changed(21, 38, 19, 70);
  if (code === 'F02') {
    assert.ok(changed(107, 113, 19, 70) < 10, 'F02 的第一条花字在 4 秒之前出现');
  }
  assert.ok(decorationPixels > 25, `${code} 的包装没有花字，变化像素 ${decorationPixels}`);
  return { coverPixels, captionPixels, decorationPixels };
}

async function assertPlayable(video) {
  await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate(async (element) => { element.muted = true; await element.play(); });
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.08);
  await video.evaluate((element) => element.pause());
}

async function assertReachable(...buttons) {
  for (const [width, height] of [[1536, 864], [1280, 720], [1024, 720]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
      for (const button of buttons) await button.click({ trial: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}×${height} ${theme}`);
    }
  }
  await page.setViewportSize({ width: 1536, height: 864 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function assertOtherSoundModes(media) {
  const priorRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
  process.env.CREATIVE_STUDIO_DATA_ROOT = root;
  try {
    register('./typescript-extension-loader.mjs', import.meta.url);
    const { renderFilmBody } = await import('../lib/one-click-film/composition.ts');
    const narrationPath = 'fixture-tts.wav';
    ff(['-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=15', path.join(root, 'storage', narrationPath)]);
    const local = { id: 'local', videoJobId: 'local', file: media.assets.get('draft-candidate.mp4'), start: 144, end: 216, trim: 24, whole: false };
    const whole = { id: 'redraw', videoJobId: 'redraw', file: media.assets.get('redraw.mp4'), start: 0, end: 360, trim: 0, whole: true };
    const { countFilmFrames } = await import('../lib/one-click-film/frames.ts');
    const short = path.join(root, 'two-picture-five-audio.mp4');
    ff(['-f', 'lavfi', '-i', 'color=white:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'anullsrc=d=5',
      '-c:v', 'libx264', '-c:a', 'aac', short]);
    assert.equal(await countFilmFrames(short), 48);
    await assert.rejects(renderFilmBody({
      originalVideoJobId: 'original', originalPath: media.assets.get('draft.mp4'), frames: 360, snapshot: {},
      edits: [{ ...local, file: short, trim: 0 }],
    }, path.join(root, 'short-edit.mp4')), /校验失败/);
    for (const [name, snapshot, edits, expected] of [
      ['tts-local', { soundMode: 'tts', narrationPath }, [local], [330, 660]],
      ['tts-redraw', { soundMode: 'tts', narrationPath }, [whole, local], [660, 770]],
      ['no-voice', { soundMode: 'none' }, [whole, local], [770]],
    ]) {
      const file = path.join(root, `${name}.mp4`);
      await renderFilmBody({
        entryId: 'fixture', entryCode: 'F01', jobId: 'fixture', originalVideoJobId: 'original',
        originalPath: media.assets.get('draft.mp4'), frames: 360, draft: false, approved: true,
        hdApproved: false, signature: 'fixture', snapshot, edits,
      }, file);
      for (const second of [0.2, 5.96, 6.5, 8.96, 9.2, 14.72]) {
        for (const hz of [330, 660, 770, 990]) {
          const power = tone(file, second, hz);
          assert.ok(expected.includes(hz) ? power > 500 : power < 80, `${name}: ${second}s / ${hz}Hz / ${power}`);
        }
      }
    }
  } finally {
    if (priorRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
    else process.env.CREATIVE_STUDIO_DATA_ROOT = priorRoot;
  }
}

try {
  const media = fixtures();
  fixture = mockProvider(media);
  const fixturePort = await listen(fixture);
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const vendor = `http://127.0.0.1:${fixturePort}`;
  const env = Object.fromEntries(['Path', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles']
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(repo, 'scripts', 'team-server', 'no-external-network.cjs'))}`,
    NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(port),
    CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port), CREATIVE_STUDIO_DEPLOYMENT_ID: 'one-click-film-employee',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: base, CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
    CREATIVE_STUDIO_LITELLM_PORT: String(fixturePort),
    CREATIVE_STUDIO_EXPORT_ENCODER: 'cpu', CREATIVE_STUDIO_FFMPEG: ffmpegPath, CREATIVE_STUDIO_FFPROBE: ffprobePath,
    FINAL_EDIT_ALIGNMENT_BASE_URL: vendor, FINAL_EDIT_ALIGNMENT_API_KEY: 'isolated-film-fixture',
  });
  const initial = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'film-admin', '--name', '验收管理员'],
    { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(initial.status, 0, initial.stderr);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initial.stdout)?.[1];
  assert.ok(credential);
  const args = useDev ? [fileURLToPath(import.meta.resolve('next/dist/bin/next')), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)]
    : [path.join(serverRoot, 'server.js')];
  app = spawn(process.execPath, args, { cwd: useDev ? repo : serverRoot, env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => {
    startupLog = (startupLog + chunk).slice(0, 9000);
    serverLog = (serverLog + chunk).slice(-9000);
  });
  await waitForReady(base);
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    db.prepare(`INSERT INTO video_providers (id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,baseUrl,apiKey)
      VALUES ('film-video','验收 Seedance 2.5','jimeng','','','','doubao-seedance-2-5-260628',?,'isolated-film-fixture')`).run(vendor);
    db.prepare(`INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,enabled,supportsVision,isBuiltin)
      VALUES ('film-vision','00 验收识图与脚本','openai-compatible','openai-compatible',?,'isolated-film-fixture','film-vision',1,1,0)`).run(vendor);
  } finally { db.close(); }
  const api = createUiAcceptanceApi(base);
  const admin = await api.activate('film-admin', credential, randomUUID());
  const pools = await api.json(admin, '/api/team/pools');
  const changes = ['llm:remote', 'tts:remote'].map((poolKey) => {
    const requirement = pools.requirements.find((item) => item.poolKey === poolKey);
    assert.ok(requirement?.mappingSnapshot, `缺少 ${poolKey} 的验收映射`);
    return { action: 'upsert', poolKey, kind: 'remote', capacity: 4, enabled: true,
      mappingSnapshot: requirement.mappingSnapshot, expectedVersion: requirement.poolVersion ?? 0 };
  });
  changes.push({ action: 'bind-media-upstream', entityType: 'video', entityId: 'film-video',
    poolKey: 'media:one-click-film-fixture', capacity: 4, expectedVersion: 0 });
  await api.json(admin, '/api/team/pools', 'POST', { changes });
  const employee = async (id, displayName) => {
    const created = await api.json(admin, '/api/team/users', 'POST', { employeeId: id, displayName, role: 'employee' }, 201);
    if (id === 'film-employee') {
      // Fixture providers intentionally have no paid price. Exercise the normal
      // administrator policy path for this isolated employee.
      const endpoint = `/api/team/members/${created.user.id}/policy`;
      const policy = await api.json(admin, endpoint);
      await api.json(admin, endpoint, 'PATCH', {
        unlimited: true, personalConcurrency: policy.personalConcurrency,
        concurrencyMode: policy.concurrencyMode, paused: false, expectedVersion: policy.version,
      });
    }
    return api.activate(id, created.credential, randomUUID());
  };
  const member = await employee('film-employee', '验收剪辑师');
  const stranger = await employee('film-stranger', '无权员工');
  const music = new FormData();
  music.set('files', new File([fs.readFileSync(media.music)], '验收配乐.wav', { type: 'audio/wav' }));
  const bgm = await api.raw(admin, '/api/team/public-resources/bgm', { method: 'POST', body: music });
  assert.ok(bgm.ok, await bgm.text());
  browser = await chromium.launch({ ...(process.env.OCF_ACCEPTANCE_CHROME ? { executablePath: process.env.OCF_ACCEPTANCE_CHROME } : {}) });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1536, height: 864 }, acceptDownloads: true });
  await context.addCookies(member.cookies.map((pair) => {
    const equal = pair.indexOf('=');
    return { name: pair.slice(0, equal), value: pair.slice(equal + 1), url: base };
  }));
  page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/api/one-click-film/')) {
      void response.text().then((body) => { localErrors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname} ${body.slice(0, 300)}`); }).catch(() => {});
    }
  });

  stage = '员工首页创建项目和上传';
  await page.goto('/');
  await page.getByRole('link', { name: /一键成片/ }).click();
  await page.getByLabel('店铺').selectOption('B店');
  await page.getByLabel('型号').fill('OCF-16');
  await page.getByLabel('类型').selectOption('AI种草');
  await expect(page.getByRole('textbox', { name: '剪辑师', exact: true })).toHaveValue('验收剪辑师');
  await page.getByRole('button', { name: '创建并准备素材' }).click();
  await page.waitForURL(/\/one-click-film\/(?!new$)[\w-]+$/);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  assert.ok([403, 404].includes((await api.raw(stranger, `/api/one-click-film/${projectId}`)).status), '项目读取必须拒绝无权限员工');
  await assertReachable(page.getByRole('button', { name: '拖入或选择场景图' }), page.getByRole('button', { name: '拖入或选择详情页' }));
  if (output) await page.screenshot({ path: path.join(output, 'ui-upload-empty.png'), animations: 'disabled' });
  const image = async (background) => sharp({ create: { width: 540, height: 720, channels: 3, background } }).png().toBuffer();
  const dropImage = async (region, filename, buffer) => {
    const transfer = await page.evaluateHandle(({ filename, bytes }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], filename, { type: 'image/png' }));
      return data;
    }, { filename, bytes: Array.from(buffer) });
    try {
      await region.dispatchEvent('dragenter', { dataTransfer: transfer });
      await expect(region).toHaveAttribute('data-drag-over', 'true');
      await region.dispatchEvent('dragover', { dataTransfer: transfer });
      await region.dispatchEvent('drop', { dataTransfer: transfer });
      await expect(region.getByRole('img', { name: filename })).toBeVisible();
      await expect(region).toHaveAttribute('data-drag-over', 'false');
    } finally { await transfer.dispose(); }
  };
  await dropImage(page.getByRole('region', { name: '场景图', exact: true }), '场景样图.png', await image('#667788'));
  await dropImage(page.getByRole('region', { name: '详情页', exact: true }), '详情样图.png', await image('#aa8866'));
  await page.getByLabel('添加详情页').setInputFiles({ name: '待移除.png', mimeType: 'image/png', buffer: await image('#cccccc') });
  await page.getByRole('button', { name: '移除 待移除.png' }).click();
  await expect(page.getByRole('img', { name: '待移除.png' })).toHaveCount(0);
  if (output) await page.screenshot({ path: path.join(output, 'ui-upload.png') });
  const imagePath = await page.getByRole('img', { name: '场景样图.png' }).getAttribute('src');
  assert.ok([403, 404].includes((await api.raw(stranger, imagePath)).status), '素材读取必须拒绝无权限员工');
  const analyzed = page.waitForResponse((response) => response.url().endsWith('/analysis') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '分析 2 份素材' }).click();
  const analysisResponse = await analyzed;
  assert.equal(analysisResponse.ok(), true, (await analysisResponse.json()).message);
  await expect(page.getByText('坐到床边放松', { exact: true }).or(page.locator('input[value="坐到床边放松"]')).first()).toBeVisible();
  await page.getByTestId('one-click-film-confirm').click();
  console.log('通过：普通员工建项目、上传两类素材、核对卖点；无权限员工读不到项目和素材。');

  stage = '脚本手改与单条重做';
  await expect(page.getByRole('heading', { name: '生成脚本', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续生成视频' })).toBeDisabled();
  await assertReachable(page.getByRole('button', { name: '应用设置并生成脚本' }));
  await page.getByLabel('视频结构', { exact: true }).selectOption('individual');
  await page.getByLabel('F01 结构').selectOption('scene');
  await page.getByLabel('F02 结构').selectOption('problem');
  await page.getByRole('button', { name: '应用设置并生成脚本' }).click();
  const workspace = () => api.json(member, `/api/one-click-film/${projectId}`);
  await expect.poll(async () => (await workspace()).entries.length, { timeout: 45_000 }).toBe(2);
  const scriptTitle = '靠垫整理后的舒适一角';
  await expect(page.getByLabel('成片标题')).toHaveValue(/^F01 /);
  await page.getByLabel('成片标题').fill(scriptTitle);
  await page.locator('textarea').first().fill('F01 手编大纲，坐在床边。');
  await page.locator('textarea').nth(1).fill('F01 手编原生画外音，今天在床边歇一会儿。');
  await page.getByRole('button', { name: /查看与编辑/ }).click();
  const editPrompt = page.locator('textarea').last();
  await editPrompt.fill((await editPrompt.inputValue()) + '\nF01 手编分镜：人物轻轻整理靠垫。');
  await page.getByRole('button', { name: /确认本条|确认脚本/ }).click();
  await expect.poll(async () => (await workspace()).entries[0].status).toBe('confirmed');
  const before = (await workspace()).entries;
  assert.equal(before[0].title, scriptTitle);
  await page.getByRole('button', { name: /^F02/ }).click();
  await page.getByRole('button', { name: '重新生成本条' }).click();
  await expect.poll(async () => (await workspace()).entries[1].scriptRevision).toBe(before[1].scriptRevision + 1);
  const revised = (await workspace()).entries;
  for (const key of ['id', 'title', 'outline', 'narration', 'promptText', 'scriptConfirmedAt']) assert.equal(revised[0][key], before[0][key]);
  for (const key of ['title', 'outline', 'narration', 'promptText']) assert.notEqual(revised[1][key], before[1][key]);
  assert.equal(revised[1].status, 'pending');
  await page.getByRole('button', { name: /确认本条|确认脚本/ }).click();
  await page.getByRole('button', { name: '继续生成视频' }).click();
  console.log('通过：手改 F01，再独立重写 F02，F01 确认稿逐字保留。');

  stage = '样片生成和实际切点';
  await page.getByLabel('视频通道').selectOption('film-video');
  await page.getByLabel('生成模式').selectOption('draft');
  await assertReachable(page.getByRole('button', { name: '核对 F02 提示词' }), page.getByTestId('one-click-film-generate'));
  await page.route('**/one-click-film/*/generation', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const [first, replay] = await Promise.all([route.fetch(), route.fetch()]);
    assert.equal(first.status(), 200);
    assert.equal(replay.status(), 200);
    await route.fulfill({ response: first });
  });
  await page.getByTestId('one-click-film-generate').click();
  await page.getByRole('button', { name: '审片 F02' }).waitFor({ timeout: 120_000 });
  if (output) {
    await page.getByRole('heading', { name: '整条生成，自动识别镜头' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'ui-generation.png') });
  }
  assert.equal(submitted.length, 2);
  const scripts = (await workspace()).entries;
  for (const script of scripts) assert.ok(submitted.some((job) => job.request.draft === true && job.prompt === script.promptText));
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^F02/ }) })
    .getByRole('button', { name: /^镜头 2/ }).click();
  const preview = page.getByLabel('当前成片');
  await expect(preview).toBeVisible();
  await assertPlayable(preview);
  const originalUrl = await preview.getAttribute('src');
  const original = path.join(root, 'original-f02.mp4');
  fs.writeFileSync(original, await responseBytes(originalUrl));
  const secondShot = page.getByRole('button', { name: 's2', exact: true });
  await expect(secondShot).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('00:06.00–00:09.00', { exact: true })).toBeVisible();
  const playhead = page.getByRole('slider', { name: '时间轴播放头' });
  const split = page.getByRole('button', { name: '在播放头处切分' });
  await secondShot.click();
  await expect(split).toBeDisabled();
  const sliderBox = await playhead.boundingBox();
  const y = sliderBox.y + sliderBox.height / 2;
  const x = (fraction) => sliderBox.x + 8 + (sliderBox.width - 16) * fraction;
  await page.mouse.move(x(6 / 15), y);
  await page.mouse.down();
  await page.mouse.move(x(0.5), y, { steps: 12 });
  await page.mouse.up();
  assert.ok(Math.abs(await preview.evaluate((video) => video.currentTime) - 7.5) < 0.12);
  assert.equal(await preview.evaluate((video) => video.paused), true);
  const draggedFrame = Number(await playhead.inputValue());
  await playhead.press('ArrowRight');
  await expect(playhead).toHaveValue(String(draggedFrame + 1));
  const cutUs = Math.round((draggedFrame + 1) * 1e6 / 24);
  await expect.poll(() => preview.evaluate((video) => video.currentTime)).toBeCloseTo(cutUs / 1e6, 2);
  const timeline = page.getByRole('region', { name: '剪辑时间轴' });
  await expect.poll(() => timeline.locator('button img').evaluateAll((images) =>
    images.filter((image) => image.naturalWidth > 0).length)).toBe(3);
  const legacyThumbnail = await secondShot.locator('img').getAttribute('src');
  assert.equal(new Set(await timeline.locator('button img').evaluateAll((images) => images.map((image) => image.src))).size, 3);
  assert.ok((await secondShot.boundingBox()).height >= 60, '画面轨保留可读高度');
  assert.ok((await timeline.locator('[class*="playheadLine"]').boundingBox()).height >= 90, '播放头跨越画面和声音轨');
  await assertReachable(split);
  const readF02 = async () => {
    const { reviews } = await api.json(member, `/api/one-click-film/${projectId}/review`);
    return reviews.find((review) => review.entryCode === 'F02');
  };
  assert.equal((await readF02()).shots.length, 3, '拖动只改变预览位置');
  if (output) {
    await page.getByRole('tab', { name: '审片与返工' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'ui-review.png'), animations: 'disabled' });
  }
  await split.click();
  await expect(page.getByRole('button', { name: 's4', exact: true })).toBeVisible();
  assert.deepEqual((await readF02()).shots.map((shot) => shot.endUs), [6e6, cutUs, 9e6, 15e6]);
  await expect(preview).toHaveAttribute('src', originalUrl);
  await page.getByRole('button', { name: '与下一镜合并' }).click();
  await expect(page.getByRole('button', { name: 's4', exact: true })).toHaveCount(0);
  assert.deepEqual((await readF02()).shots.map((shot) => shot.endUs), [6e6, 9e6, 15e6]);
  await page.goto(`/one-click-film/${projectId}?stage=review`);
  await page.getByRole('button', { name: /^F02 / }).click();
  await page.getByRole('button', { name: '撤回合并' }).click();
  await expect(page.getByRole('button', { name: 's4', exact: true })).toBeVisible();
  assert.deepEqual((await readF02()).shots.map((shot) => shot.endUs), [6e6, cutUs, 9e6, 15e6]);
  await secondShot.click();
  await page.getByRole('button', { name: '与下一镜合并' }).click();
  await expect(page.getByRole('button', { name: 's4', exact: true })).toHaveCount(0);
  console.log('通过：两个素材框独立拖放；播放头同步预览和逐帧定位，切分后片源不变，合并恢复原区间。');

  stage = '候选生成、采用、撤销与恢复';
  await page.getByText('返工设置', { exact: true }).click();
  await page.getByLabel('返工要求').fill('只换第二镜的人物动作，保留产品外观和整条原声。');
  await page.getByLabel('返工参考素材').selectOption({ label: '场景样图.png' });
  await page.getByRole('button', { name: '重新生成片段' }).click();
  await page.getByRole('button', { name: /候选 1 · 可预览/ }).waitFor({ timeout: 120_000 });
  const sentReference = submitted.at(-1).request.content.find((item) => item.type === 'image_url');
  assert.ok(sentReference?.image_url?.url.startsWith('data:image/png;base64,'), '补拍收到字节格式匹配的 PNG 参考');
  await page.getByRole('button', { name: '循环预览接缝' }).click();
  await expect(page.getByLabel('接缝预览')).toBeVisible();
  const inspector = page.getByRole('region', { name: '审片操作' });
  assert.equal(await inspector.evaluate((element) => getComputedStyle(element).overflowY), 'auto');
  await page.getByRole('button', { name: '调整入点与出点' }).click();
  const trim = page.getByRole('dialog', { name: '调整候选片段' });
  const trimPreview = trim.getByLabel('候选剪裁预览');
  const inPoint = trim.getByRole('slider', { name: '候选入点' });
  const outPoint = trim.getByRole('slider', { name: '候选出点' });
  await expect.poll(() => trimPreview.evaluate((video) => video.readyState)).toBeGreaterThan(1);
  await inPoint.press('ArrowRight');
  await expect(inPoint).toHaveValue('1');
  await expect.poll(() => trimPreview.evaluate((video) => video.currentTime)).toBeCloseTo(1 / 24, 2);
  const rail = await outPoint.boundingBox();
  const candidateFrames = Number(await outPoint.getAttribute('max'));
  const trimX = (frame) => rail.x + 8 + (rail.width - 16) * frame / candidateFrames;
  const trimY = rail.y + rail.height / 2;
  await page.mouse.move(trimX(73), trimY);
  await page.mouse.down();
  await page.mouse.move(trimX(96), trimY, { steps: 8 });
  await page.mouse.up();
  await expect(inPoint).toHaveValue('24');
  await expect(outPoint).toHaveValue('96');
  await expect.poll(() => trimPreview.evaluate((video) => video.currentTime)).toBeCloseTo(95 / 24, 2);
  await trim.getByRole('button', { name: '循环预览选区' }).click();
  await expect.poll(() => trimPreview.evaluate((video) => video.paused)).toBe(false);
  await trim.getByRole('button', { name: '暂停', exact: true }).click();
  if (output) await page.screenshot({ path: path.join(output, 'ui-candidate-trim.png'), animations: 'disabled' });
  let unblockReview;
  const previewBarrier = new Promise((resolve) => { unblockReview = resolve; });
  const reviewEndpoint = '**/api/one-click-film/*/review';
  const holdReview = async (route) => {
    if (route.request().method() === 'GET') await previewBarrier;
    await route.continue();
  };
  await page.route(reviewEndpoint, holdReview, { times: 1 });
  try {
    await trim.getByRole('button', { name: '替换', exact: true }).click();
    await expect(inspector.getByRole('status')).toHaveText('已替换，正在刷新成片预览…');
    await expect(page.getByRole('button', { name: /候选 1 · 已替换/ })).toBeVisible();
    await expect(preview).toHaveAttribute('src', originalUrl);
  } finally {
    unblockReview();
  }
  await expect(preview).not.toHaveAttribute('src', originalUrl, { timeout: 120_000 });
  await expect(secondShot.locator('img')).not.toHaveAttribute('src', legacyThumbnail);
  console.log('通过：两端逐帧预览，替换写入后立即反馈，缩略图随当前成片刷新。');
  const adoptedUrl = await preview.getAttribute('src');
  const adopted = path.join(root, 'adopted-f02.mp4');
  fs.writeFileSync(adopted, await responseBytes(adoptedUrl));
  assertLocalEdit(original, adopted);
  assertContinuousAudio(adopted, 0);
  await page.getByRole('button', { name: '撤销替换' }).click();
  await expect(preview).toHaveAttribute('src', originalUrl);
  await page.getByText('剪辑历史', { exact: true }).click();
  await page.getByLabel('历史版本').selectOption({ label: '第 1 版 · 1 处替换' });
  await page.getByRole('button', { name: '恢复该版本' }).click();
  await expect(preview).toHaveAttribute('src', adoptedUrl);
  console.log('通过：F02 只替换 6–9 秒，原声跨两处接缝；撤销和恢复可重现。');

  stage = '按采用来源转高清';
  for (const code of ['F02', 'F01']) {
    await page.getByRole('button', { name: new RegExp(`^${code} `) }).click();
    await page.getByTestId('one-click-film-approve').click();
    if (code === 'F02') {
      await expect(page.getByRole('button', { name: '一键高清', exact: true })).toBeVisible();
      const fixtureDb = new Database(path.join(root, 'data', 'workbench.db'));
      const key = fixtureDb.prepare("SELECT apiKey FROM video_providers WHERE id='film-video'").pluck().get();
      const change = fixtureDb.prepare("UPDATE video_providers SET apiKey=? WHERE id='film-video'");
      try {
        change.run('different-fixture-account');
        const blocked = await api.json(member, `/api/one-click-film/${projectId}/rework`, 'POST',
          { action: 'convert-hd', entryCode: code }, 400);
        assert.match(blocked.message, /账号/);
        assert.equal(submitted.filter((job) => job.draftId).length, 0);
      } finally { change.run(key); fixtureDb.close(); }
    }
    await page.getByRole('button', { name: '一键高清', exact: true }).click();
    await page.getByRole('button', { name: '确认转高清' }).click();
    await page.getByRole('button', { name: '确认高清通过' }).click({ timeout: 180_000 });
    await expect(page.getByRole('button', { name: '高清已复核' })).toBeVisible({ timeout: 120_000 });
    if (code === 'F02') {
      const hd = path.join(root, 'hd-f02-approved.mp4');
      fs.writeFileSync(hd, await responseBytes(await preview.getAttribute('src')));
      assertLocalEdit(media.assets.get('hd.mp4'), hd);
      assertContinuousAudio(hd, 0);
    } else {
      const unchanged = path.join(root, 'hd-f01-approved.mp4');
      fs.writeFileSync(unchanged, await responseBytes(await preview.getAttribute('src')));
      assert.ok(pixelsNear(pixelFrames(media.assets.get('hd.mp4')), pixelFrames(unchanged)), 'F01 的高清画面仍为原版本');
    }
  }
  const hdRequests = submitted.filter((job) => job.draftId);
  assert.equal(hdRequests.length, 3);
  assert.deepEqual(new Set(hdRequests.map((job) => job.draftId)), new Set(submitted.filter((job) => !job.draftId).map((job) => job.id)));
  console.log('通过：按实际采用的三个样片来源转高清。');

  stage = '真实包装、时间轴编辑和交付';
  await page.getByRole('tab', { name: '包装与导出' }).click();
  const beforePackaging = page.getByRole('button', { name: '打开 F01 预览与编辑' });
  await expect.poll(() => beforePackaging.locator('img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  const portrait = await beforePackaging.boundingBox();
  assert.ok(portrait.height > portrait.width, '未包装的成片也有竖卡封面');
  await expect(page.locator('article').filter({ has: beforePackaging })).toContainText(scriptTitle);
  await expect(page.locator('article video')).toHaveCount(0);
  if (output) await page.screenshot({ path: path.join(output, 'ui-packaging-cards.png'), animations: 'disabled' });
  await page.getByTestId('one-click-film-package').click();
  const readPackaging = () => api.json(member, `/api/one-click-film/${projectId}/packaging`).then((result) => result.packaging);
  await expect.poll(async () => (await readPackaging()).length).toBe(2);
  assert.equal((await readPackaging()).find((item) => item.entryCode === 'F01').title, scriptTitle);
  assert.ok((await readPackaging()).every((item) => item.status === 'pending' && !item.videoUrl));
  const openPackaging = (code) => page.getByRole('button', { name: `打开 ${code} 预览与编辑` }).click();
  await openPackaging('F02');
  await expect(page.getByRole('region', { name: '包装时间轴', exact: true })).toBeVisible();
  assert.deepEqual(await page.locator('[data-packaging-track]').evaluateAll((rows) =>
    rows.map((row) => row.dataset.packagingTrack)), ['subtitle', 'packaging', 'sticker', 'picture', 'voice', 'music']);
  await page.getByRole('button', { name: '播放完整预览' }).click();
  await expect.poll(() => page.getByLabel('F02 编辑预览').evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '暂停预览' }).click();
  await page.getByRole('tab', { name: '镜头返工' }).click();
  await page.getByRole('button', { name: 's2', exact: true }).click();
  await expect(page.getByText('00:06.00–00:09.00', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '包装调整' }).click();
  await page.getByRole('tab', { name: '字幕', exact: true }).click();
  await page.getByRole('button', { name: '识别口播字幕' }).click();
  await expect(page.getByText('口播字幕已识别。')).toBeVisible();
  const captionTrack = page.getByRole('group', { name: '字幕', exact: true });
  await captionTrack.getByRole('button').first().click();
  const text = page.getByLabel('当前字幕');
  await expect(text).toHaveValue('这是原片旁白。');
  await text.fill('这是校对后的旁白。');
  const caption = page.getByRole('button', { name: '移动画面字幕' });
  const dragBy = async (locator, dx, dy) => {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    assert.ok(bounds);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  };
  await dragBy(caption, 0, -8);
  await page.getByRole('tab', { name: '花字包装', exact: true }).click();
  const coverTitle = page.frameLocator('iframe[title="可编辑包装图层"]').locator('[data-point-id="cover:title"]');
  await expect(coverTitle).toBeVisible();
  await dragBy(coverTitle, 8, 8);
  const packageLane = page.getByRole('group', { name: '花字包装', exact: true }).locator('[data-track-lane]');
  const laneWidth = await packageLane.evaluate((element) => element.clientWidth);
  await dragBy(page.getByLabel('调整字幕出点'), laneWidth * 0.25 / (15 + 20 / 24), 0);
  await dragBy(page.getByLabel('调整花字包装入点'), laneWidth * 4 / (15 + 20 / 24), 0);
  await page.getByRole('tab', { name: '贴纸', exact: true }).click();
  await page.getByRole('button', { name: '添加星星' }).click();
  await expect(page.getByRole('button', { name: '移动星星贴纸' })).toBeVisible();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText('已保存草稿。')).toBeVisible();
  const f02Draft = (await readPackaging()).find((item) => item.entryCode === 'F02');
  assert.ok(f02Draft.options.subtitlePosition.y < 91);
  assert.ok(f02Draft.options.layouts['overlay-minimal'].cover.title);
  assert.equal(f02Draft.subtitleCues[0].text, '这是校对后的旁白。');
  assert.ok(f02Draft.subtitleCues[0].endSec > 2.8);
  assert.ok(Math.abs(f02Draft.pointCues[0].startSec - 4) <= 1 / 24);
  assert.equal(f02Draft.options.stickers[0].kind, 'star');
  assert.equal(f02Draft.videoUrl, null);
  if (output) await page.screenshot({ path: path.join(output, 'ui-packaging-draft.png'), animations: 'disabled' });
  await assertReachable(page.getByRole('button', { name: '选入导出' }));
  await page.getByRole('button', { name: '选入导出' }).click();
  await openPackaging('F01');
  await page.getByRole('button', { name: '选入导出' }).click();
  assert.equal((await readPackaging()).find((item) => item.entryCode === 'F01').subtitlesPrepared, false);
  await page.getByRole('button', { name: '全选可导出成片' }).click();
  const confirmExport = async () => {
    await page.getByTestId('one-click-film-export').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认渲染并导出', exact: true }).click();
  };
  const getExports = () => api.json(member, `/api/one-click-film/${projectId}/exports`).then((result) => result.exports);
  assert.equal((await getExports()).length, 0);
  assert.ok((await readPackaging()).every((item) => !item.videoUrl));
  console.log('通过：外层只显示封面，编辑器六轨顺序正确，拖动及保存草稿不渲染。');
  await confirmExport();
  await expect.poll(async () => (await getExports()).length, { timeout: 300_000 }).toBe(2);
  const autoCaption = (await readPackaging()).find((item) => item.entryCode === 'F01');
  assert.equal(autoCaption.subtitlesPrepared, true);
  assert.equal(autoCaption.subtitleCues[0].text, '这是原片旁白。');
  const deliveries = await getExports();
  const history = page.locator('[class*="exportCard"]');
  await expect(history).toHaveCount(2);
  for (const video of await history.locator('video').all()) await assertPlayable(video);
  for (const delivery of deliveries) await page.getByLabel(`选择 ${delivery.filename}`).check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载所选 2 条为 ZIP' }).click();
  const archive = path.join(root, '交付.zip');
  await (await download).saveAs(archive);
  const zip = await JSZip.loadAsync(fs.readFileSync(archive), { checkCRC32: true });
  assert.equal(Object.keys(zip.files).length, 2);
  const files = [];
  const checked = [];
  for (const delivery of deliveries) {
    assert.equal((await api.raw(stranger, delivery.url)).status, 404);
    const bytes = await zip.file(delivery.filename).async('nodebuffer');
    assert.equal(digest(bytes), delivery.checksum);
    assert.equal(digest(await responseBytes(delivery.url)), delivery.checksum);
    const file = path.join(root, `${delivery.entryCode}-final.mp4`);
    fs.writeFileSync(file, bytes);
    const streams = metadata(file).streams;
    const video = streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.avg_frame_rate, '24/1');
    assert.equal(Number(video.nb_read_frames), 380);
    assert.ok(streams.some((stream) => stream.codec_type === 'audio'));
    assertContinuousAudio(file, 20 / 24, true);
    const visual = assertPackagedVisuals(file, delivery.entryCode);
    checked.push({ entry: delivery.entryCode, filename: path.basename(file), fps: video.avg_frame_rate,
      frames: Number(video.nb_read_frames), sha256: delivery.checksum, ...visual });
    files.push(file);
  }
  const oldF02 = deliveries.find((delivery) => delivery.entryCode === 'F02');
  await openPackaging('F02');
  await page.getByLabel('F02 标题').fill('F02 第二版交付');
  await page.getByRole('tab', { name: '字幕', exact: true }).click();
  await page.getByLabel('显示口播字幕').uncheck();
  await page.getByRole('button', { name: '选入导出' }).click();
  await confirmExport();
  await expect.poll(async () => (await getExports()).length, { timeout: 180_000 }).toBe(3);
  assert.equal(digest(await responseBytes(oldF02.url)), oldF02.checksum);
  assert.notEqual((await getExports()).find((item) => item.title === 'F02 第二版交付').checksum, oldF02.checksum);
  const withoutCaptions = (await readPackaging()).find((item) => item.entryCode === 'F02');
  assert.equal(withoutCaptions.options.subtitles, false);
  assert.deepEqual(withoutCaptions.subtitleCues, f02Draft.subtitleCues, '关闭字幕导出仍保留已校对的字幕');
  await expect(history).toHaveCount(3);
  for (const video of await history.filter({ hasText: 'F02' }).locator('video').all()) await assertPlayable(video);
  stage = '整条重抽的真实声音和实际切点';
  await page.getByRole('tab', { name: /审片/ }).click();
  await page.getByRole('button', { name: /^F01 / }).click();
  const originalF01 = await preview.getAttribute('src');
  const originalPrompt = (await workspace()).entries.find((entry) => entry.code === 'F01').promptText;
  await page.getByRole('button', { name: '整条重抽', exact: true }).click();
  await expect(page.getByText('使用重抽成片的原生画外音和现场声', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '修改提示词' }).click();
  const editRedraw = page.getByLabel('整条重抽提示词全文');
  await expect(editRedraw).toHaveValue(originalPrompt);
  await editRedraw.fill('重抽验收：从产品全景推进到手部特写。');
  await page.getByRole('button', { name: '应用到本次重抽' }).click();
  await expect(page.getByText('已修改提示词')).toBeVisible();
  await page.getByRole('button', { name: '确认整条重抽' }).click();
  await page.getByRole('button', { name: /候选 1 · 可预览/ }).waitFor({ timeout: 120_000 });
  assert.equal(submitted.at(-1).prompt, '重抽验收：从产品全景推进到手部特写。\n整条重抽');
  assert.equal((await workspace()).entries.find((entry) => entry.code === 'F01').promptText, originalPrompt);
  await expect(preview).toHaveAttribute('src', originalF01);
  await page.getByRole('button', { name: '采用整条' }).click();
  await expect(preview).not.toHaveAttribute('src', originalF01, { timeout: 120_000 });
  await page.getByRole('button', { name: 's2', exact: true }).click();
  await expect(page.getByText('00:03.00–00:08.00', { exact: true })).toBeVisible();
  const redrawn = path.join(root, 'redrawn-f01.mp4');
  fs.writeFileSync(redrawn, await responseBytes(await preview.getAttribute('src')));
  assert.ok(tone(redrawn, 7.96, 770) > 250 && tone(redrawn, 7.96, 330) < 20, '整条重抽采用新的整条声音');
  await page.getByRole('button', { name: '撤销替换' }).click();
  await expect(preview).toHaveAttribute('src', originalF01);
  assert.equal(digest(await responseBytes(oldF02.url)), oldF02.checksum);
  stage = 'TTS 和不配音的音轨尾段';
  await assertOtherSoundModes(media);
  assert.deepEqual(localErrors, []);
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    for (const file of [...files, archive]) fs.copyFileSync(file, path.join(output, path.basename(file)));
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({
      role: 'employee', firstBodyFrame: 20, changedBodyFrames: [144, 215], originalAudioHz: 330,
      ignoredCandidateAudioHz: 990, bgmHz: 550, hdConversions: hdRequests.length, deliveries: checked,
    }, null, 2));
    fs.rmSync(path.join(output, 'failure.png'), { force: true });
  }
  console.log('第 16 票通过：员工首页 → 两条样片 → F02 只替换第 144–215 帧，330 Hz 原声跨接缝 → 三次来源转高清 → 实际包装并下载两条 24 fps / 380 帧 MP4，复查历史交付。');
} catch (error) {
  if (page && output) {
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  const databaseFile = path.join(root, 'data', 'workbench.db');
  if (fs.existsSync(databaseFile)) {
    const diagnostics = new Database(databaseFile, { readonly: true });
    try {
      console.error('隔离执行状态', diagnostics.prepare(`
        SELECT module, step, status, waitReason, waitDetail, requiredPoolsJson
        FROM execution_operations ORDER BY readySeq DESC LIMIT 8
      `).all());
    } catch { /* 尚未创建执行账本 */ }
    finally { diagnostics.close(); }
  }
  console.error(`第 16 票停止在 ${stage}`, error, localErrors, (startupLog + '\n' + serverLog).replaceAll(root, '[验收数据根]'));
  throw error;
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(app.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
  fixture?.closeAllConnections();
  fixture?.close();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(root, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 9) console.warn('隔离目录清理失败', error.message); else await delay(100); }
  }
}
