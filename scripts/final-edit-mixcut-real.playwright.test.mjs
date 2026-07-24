import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ffmpegStatic from 'ffmpeg-static';
import { chromium } from '@playwright/test';

const fixturePath = path.resolve('scripts/final-edit-mixcut-real-project.fixture.ts');
const loaderPath = path.resolve('scripts/typescript-extension-loader.mjs');
assert.ok(fs.existsSync(fixturePath), '真实项目 E2E 必须提供 seed fixture');
assert.ok(fs.existsSync(loaderPath), '真实项目 E2E 必须能加载仓库 TypeScript 模块');
assert.ok(fs.existsSync(path.resolve('.next', 'BUILD_ID')), '请先在当前 cwd 完成 npm run build，再运行真实项目 E2E');

const suppliedDataRoot = process.env.MIXCUT_REAL_DATA_ROOT?.trim();
const testDataRoot = suppliedDataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-mixcut-real-'));
const ownsDataRoot = !suppliedDataRoot;
assert.equal(fs.existsSync(path.join(testDataRoot, 'data', 'workbench.db')), false, '真实项目 E2E 要求空的数据根，拒绝覆盖已有数据库');
const testEnv = {
  ...process.env,
  CREATIVE_STUDIO_DATA_ROOT: testDataRoot,
  NEXT_TELEMETRY_DISABLED: '1',
};

function seedFixture() {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, fixturePath], {
    cwd: process.cwd(),
    env: testEnv,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `真实项目 fixture 初始化失败：\n${result.stderr}\n${result.stdout}`);
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(lastLine, 'fixture 必须输出 JSON 身份信息');
  return JSON.parse(lastLine);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startProductionServer() {
  const port = await getFreePort();
  const nextBin = path.resolve('node_modules/next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    env: testEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next production server exited with ${child.exitCode}:\n${output}`);
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status < 500) return { child, baseUrl, output: () => output };
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Next production server did not become ready:\n${output}`);
}

async function stopProductionServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function assertMp4(buffer) {
  assert.ok(buffer.length > 10_000, `下载 MP4 体积异常：${buffer.length}`);
  assert.equal(buffer.subarray(4, 8).toString('ascii'), 'ftyp', '下载响应必须是真实 MP4');
  const downloadedPath = path.join(testDataRoot, 'downloaded-final.mp4');
  fs.writeFileSync(downloadedPath, buffer);
  const probe = spawnSync(ffmpegStatic, ['-hide_banner', '-i', downloadedPath, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(probe.status, 0, `下载 MP4 必须能被打包同源 FFmpeg 解码：${probe.stderr}`);
  const duration = probe.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  assert.ok(duration, '下载 MP4 必须包含有效时长元数据');
  const durationSec = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  assert.ok(durationSec > 1, '下载 MP4 必须包含有效时长');
  const visualScan = spawnSync(ffmpegStatic, [
    '-hide_banner', '-ss', '0.9', '-i', downloadedPath,
    '-vf', 'blackdetect=d=0.2:pix_th=0.02,freezedetect=n=-50dB:d=0.75',
    '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(visualScan.status, 0, `下载 MP4 视觉扫描失败：${visualScan.stderr}`);
  assert.doesNotMatch(visualScan.stderr, /black_start|freeze_start/, '跳过封面片头后，成片不得包含黑场或冻结段');
  return durationSec;
}

function assertJpeg(buffer) {
  assert.ok(buffer.length > 1_000, `下载封面体积异常：${buffer.length}`);
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8, '下载响应必须是真实 JPEG');
}

function assertZip(buffer) {
  assert.ok(buffer.length > 1_000, `项目 ZIP 体积异常：${buffer.length}`);
  assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK', '项目创意包必须是真实 ZIP');
}

const fixture = seedFixture();
const server = await startProductionServer();
const browser = await chromium.launch({ headless: true });
let completedJobId = '';
let passed = false;
let page;

try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20_000);
  await page.goto(`${server.baseUrl}/projects/${fixture.projectId}?tab=final-edit`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '选择这次混剪要用的素材' }).waitFor();

  const shotSetPicker = page.getByLabel('选择分镜组');
  assert.equal(await shotSetPicker.inputValue(), fixture.shotSetB, '最近分镜组必须成为真实初始上下文');
  await page.getByText('真实组B-专属.mp4', { exact: true }).waitFor();
  assert.equal(await page.getByText('真实组A-素材1.mp4', { exact: true }).count(), 0, '组 B 不得混入组 A 视频');

  await shotSetPicker.selectOption(fixture.shotSetA);
  await page.locator(`[data-mixcut-shot-set-id="${fixture.shotSetA}"]`).waitFor();
  for (let index = 1; index <= fixture.primaryMaterialCount; index += 1) {
    await page.getByText(`真实组A-素材${index}.mp4`, { exact: true }).waitFor();
  }
  assert.equal(await page.getByText('真实组B-专属.mp4', { exact: true }).count(), 0, '切换到组 A 后不得残留组 B 视频');

  await page.getByRole('button', { name: /预览调整/ }).click();
  await page.getByRole('heading', { name: '预览并调整完整时间轴' }).waitFor();
  await page.getByRole('button', { name: '下一步：导出' }).click();
  await page.getByRole('heading', { name: '导出并写回项目' }).waitFor();
  await page.getByText('REAL-E2E', { exact: true }).waitFor();
  const renderResponsePromise = page.waitForResponse((response) => response.url().includes('/api/final-edit-variants/') && response.url().endsWith('/render') && response.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: '开始导出' }).click();
  let renderResponse;
  try {
    renderResponse = await renderResponsePromise;
  } catch (error) {
    const bodyText = await page.locator('body').innerText();
    throw new Error(`浏览器未创建真实 render job：${error instanceof Error ? error.message : String(error)}\n${bodyText}`);
  }
  assert.equal(renderResponse.ok(), true, `创建真实 render job 失败：${renderResponse.status()} ${await renderResponse.text()}`);

  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('导出完成 · 100%') || Boolean([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('重试导出')));
  }, null, { timeout: 360_000 });
  const pageText = await page.locator('body').innerText();
  assert.match(pageText, /导出完成 · 100%/, `真实 worker 导出失败：\n${pageText}`);

  const videoHref = await page.getByRole('link', { name: '下载视频' }).getAttribute('href');
  const coverHref = await page.getByRole('link', { name: '下载封面' }).getAttribute('href');
  const projectZipHref = await page.getByRole('link', { name: '下载项目创意包' }).getAttribute('href');
  assert.ok(videoHref && coverHref && projectZipHref);
  completedJobId = videoHref.match(/final-edit-jobs\/([^/]+)\/video/)?.[1] || '';
  assert.ok(completedJobId, '下载链接必须包含真实 render job id');

  const [videoResponse, coverResponse, zipResponse] = await Promise.all([
    page.request.get(new URL(videoHref, server.baseUrl).href),
    page.request.get(new URL(coverHref, server.baseUrl).href),
    page.request.get(new URL(projectZipHref, server.baseUrl).href),
  ]);
  assert.equal(videoResponse.ok(), true, `视频下载失败：${videoResponse.status()}`);
  assert.equal(coverResponse.ok(), true, `封面下载失败：${coverResponse.status()}`);
  assert.equal(zipResponse.ok(), true, `项目 ZIP 下载失败：${zipResponse.status()}`);
  const outputDurationSec = assertMp4(await videoResponse.body());
  const expectedDurationSec = fixture.narrationDurationSec + 20 / 24;
  assert.ok(Math.abs(outputDurationSec - expectedDurationSec) <= 0.06, `成片时长必须等于封面片头加口播主轴：${outputDurationSec}s vs ${expectedDurationSec}s`);
  assertJpeg(await coverResponse.body());
  assertZip(await zipResponse.body());
  await page.locator('section[aria-label="导出结果"] img').waitFor();
  assert.equal(await page.locator('section[aria-label="导出结果"] img').evaluate((image) => image.naturalWidth > 0), true, '真实导出封面必须能在浏览器加载');
  await page.close();
  passed = true;
} catch (error) {
  const bodyText = page ? await page.locator('body').innerText().catch(() => '页面正文不可用') : '页面尚未创建';
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nPage body:\n${bodyText}\n\nNext production output:\n${server.output()}\nFixture data root: ${testDataRoot}`, { cause: error });
} finally {
  await browser.close();
  await stopProductionServer(server.child);
}

const verificationDb = new Database(fixture.dbPath, { readonly: true });
try {
  const job = verificationDb.prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(completedJobId);
  assert.equal(job?.status, 'succeeded', '真实 render job 必须持久化为 succeeded');
  const output = JSON.parse(job.outputJson);
  for (const key of ['videoRelativePath', 'coverRelativePath', 'publishedVideoRelativePath', 'publishedCoverRelativePath']) {
    const absolutePath = path.join(testDataRoot, 'storage', output[key]);
    assert.ok(fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 0, `${key} 必须指向真实非空文件`);
  }
  const artifacts = verificationDb.prepare(`SELECT kind, relativePath, sourceJobId FROM project_artifacts WHERE projectId=? ORDER BY kind`).all(fixture.projectId);
  assert.deepEqual(artifacts.map((artifact) => artifact.kind), ['final_cover', 'final_video']);
  assert.ok(artifacts.every((artifact) => artifact.sourceJobId === completedJobId), '项目 artifacts 必须关联真实 render job');
  assert.ok(artifacts.every((artifact) => fs.existsSync(path.join(testDataRoot, 'storage', artifact.relativePath))), '项目 artifacts 必须指向已发布文件');
  const variant = verificationDb.prepare(`SELECT timelineJson, matchDiagnosticsJson FROM final_edit_variants WHERE id=?`).get(fixture.variantId);
  const timeline = JSON.parse(variant.timelineJson);
  const diagnostics = JSON.parse(variant.matchDiagnosticsJson);
  assert.equal(timeline.clips.length, fixture.primaryMaterialCount, '真实验收时间线必须覆盖 7 个口播句段');
  assert.ok(new Set(timeline.clips.map((clip) => clip.videoJobId)).size >= 5, '真实验收成片必须实际使用至少 5/7 个素材');
  assert.ok(diagnostics.usedMaterials.length >= 5, '真实 matcher 诊断必须记录至少 5/7 个素材');
} finally {
  verificationDb.close();
}

if (passed && ownsDataRoot && process.env.MIXCUT_REAL_KEEP_DATA !== '1') {
  const resolved = path.resolve(testDataRoot);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}creative-studio-mixcut-real-`), '拒绝清理非测试临时目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log('final-edit mixcut real project Playwright E2E passed');
