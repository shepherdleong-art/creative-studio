/**
 * 08 号票：第 4 步视频页的页面级行为验收（V12）。
 *
 *   npm run build && node scripts/video-step-settings.playwright.test.mjs
 *
 * 真实生产前端 + 受控 API 夹具（临时数据根、断外网、不调用真实模型），验尺寸检查量不到的：
 *
 *   1. 点不同视频，右栏换成各自保存的设置（提示词、模型、秒数、首尾帧、智能分镜）；
 *   2. 改动后出现「改过了，再生成会多做一条，原来那条不变」，点「还原」恢复原值；
 *   3. 批量检查窗口：统一供应商/统一秒数在顶部，统一秒数是**所选模型都支持的秒数交集**；
 *      换统一供应商后秒数选项跟着更新；交集为空时给出说明；
 *   4. 每个分镜的提示词能直接改且打字不丢焦点；一键填充只填空着的；逐条秒数仍可改；
 *   5. 视频页没有任何并发设置。
 *
 * 排版与「两内核 × 三窗口 × 浅深两色」的尺寸检查归 04 的验收工具
 * （TEAM_ACCEPTANCE_UI_SCREENS=project-video）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-step-settings-'));
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.resolve('.next/standalone/server.js')], {
  env: {
    ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production',
    CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  },
  stdio: 'ignore',
});

let browser;
try {
  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    if (server.exitCode !== null) throw new Error('fixture server exited');
    try { ready = (await fetch(baseUrl)).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'fixture server ready');

  // ── 夹具：两个分镜、两条已生成素材、三家秒数表不同的供应商 ──────────────
  // Kling 2.5（公司网关别名）只给 5/10 秒；Seedance 2.5 给 4–30；Kling 3.0 给 3–15。
  const providers = [
    {
      id: 'prov-kling25', name: '公司可灵 2.5 · 1080p', category: 'video', type: 'openai-video',
      defaultModel: 'kling-2.5', enabled: 1, configured: true, hasApiKey: true,
      capabilities: {
        durations: [5, 10],
        tailFrame: { supported: true, protocol: 'kling-tail' },
        multiShot: { supported: true, defaultEnabled: true },
        reference: { supported: false, reason: 'unsupported_model' },
      },
      missing: [],
    },
    {
      id: 'prov-seedance25', name: '公司即梦 Seedance 2.5', category: 'video', type: 'openai-video',
      defaultModel: 'doubao-seedance-2-5', enabled: 1, configured: true, hasApiKey: true,
      capabilities: {
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
        tailFrame: { supported: true, protocol: 'seedance-tail' },
        multiShot: { supported: false, defaultEnabled: false },
        reference: { supported: false, reason: 'unsupported_model' },
      },
      missing: [],
    },
    {
      id: 'prov-kling3', name: '公司可灵 3.0', category: 'video', type: 'openai-video',
      defaultModel: 'kling-3.0', enabled: 1, configured: true, hasApiKey: true,
      capabilities: {
        durations: Array.from({ length: 13 }, (_, index) => index + 3), // 3–15
        tailFrame: { supported: true, protocol: 'kling-tail' },
        multiShot: { supported: true, defaultEnabled: true },
        reference: { supported: false, reason: 'unsupported_model' },
      },
      missing: [],
    },
  ];

  const shots = [
    { id: 'shot-1', indexNum: 1, sourceImageId: 'img-1', imageUrl: '/api/images/uploads/shot-1.png' },
    { id: 'shot-2', indexNum: 2, sourceImageId: 'img-2', imageUrl: '/api/images/uploads/shot-2.png' },
  ];

  const templates = [
    { id: 'tpl-push', name: '推进', description: '镜头推进', prompt: '以当前图片为首帧，镜头推进，向主体缓慢靠近，运动平稳自然。', isBuiltin: 1, inRandomPool: 1 },
    { id: 'tpl-fixed', name: '固定镜头', description: '机位不动', prompt: '以当前图片为首帧，固定镜头，机位与镜头全程不动，光线保持恒定。', isBuiltin: 1, inRandomPool: 1 },
  ];

  /** 两条素材各自保存的设置不同——点哪条右栏就该是哪条。 */
  const videoJobs = [
    {
      id: 'job-a', shotId: 'shot-1', providerId: 'prov-kling25', model: 'kling-2.5',
      templateId: 'tpl-push', prompt: '镜头推进，向主体缓慢靠近，运动平稳自然。', durationSec: 5,
      status: 'succeeded', filename: 'a.mp4', displayName: '素材 A.mp4',
      videoUrl: '/api/videos/outputs/a.mp4', posterImageUrl: '/api/images/uploads/shot-1.png',
      generationMode: 'image-to-video', multiShot: 1, tailImageId: 'tail-a', rejectedAt: null, rejectReason: null,
    },
    {
      id: 'job-b', shotId: 'shot-2', providerId: 'prov-seedance25', model: 'doubao-seedance-2-5',
      templateId: null, prompt: '一只手掀开沙发坐垫，露出下面的实木排骨架。', durationSec: 12,
      status: 'succeeded', filename: 'b.mp4', displayName: '素材 B.mp4',
      videoUrl: '/api/videos/outputs/b.mp4', posterImageUrl: '/api/images/uploads/shot-2.png',
      generationMode: 'image-to-video', multiShot: 0, tailImageId: null, rejectedAt: null, rejectReason: null,
    },
  ];

  const submittedBatches = [];
  const projectPatches = [];

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1536, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    let body = {};
    if (pathname === '/api/projects/p1') {
      if (method === 'PATCH') {
        projectPatches.push(route.request().postDataJSON());
        body = { success: true };
      } else {
        body = {
          id: 'p1', name: '视频设置测试', images: [], jobs: [], provider: null, model: 'fixture',
          status: 'draft', concurrency: 2, maxAttempts: 1, prompt: '',
        };
      }
    } else if (pathname === '/api/projects/p1/shot-sets') {
      body = [{ id: 'set-1', name: '验收分镜组', shotCount: 2, kind: 'storyboard' }];
    } else if (pathname === '/api/shot-sets/set-1') {
      body = { shots };
    } else if (pathname === '/api/shot-sets/set-1/video-jobs') {
      body = { jobs: videoJobs };
    } else if (pathname === '/api/shot-sets/set-1/video-jobs/batch') {
      submittedBatches.push(route.request().postDataJSON());
      body = { videoJobIds: ['job-new'] };
    } else if (pathname === '/api/projects/p1/video-run') {
      body = { success: true };
    } else if (pathname === '/api/team/models' && url.searchParams.get('kind') === 'video') {
      body = providers;
    } else if (pathname === '/api/video-prompt-templates') {
      body = templates;
    } else if (pathname === '/api/team/auth/session') {
      body = { role: 'employee' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  // 视频地址与缩略图本次不验，给个空响应避免请求卡住。
  await page.route('**/api/videos/**', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/images/**', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto(`${baseUrl}/projects/p1?tab=video`);
  await expect(page.getByRole('heading', { name: '视频生成', exact: true })).toBeVisible({ timeout: 30_000 });

  // ── 5. 视频页没有并发设置 ──────────────────────────────────────────
  await expect(page.getByText('并发', { exact: false })).toHaveCount(0);

  const setSelect = page.getByLabel('选择分镜组', { exact: true });
  await setSelect.waitFor({ timeout: 15_000 });
  await setSelect.selectOption('set-1');
  await expect(page.getByRole('button', { name: /^批量检查 2 个分镜$/ })).toBeVisible({ timeout: 15_000 });

  // ── 1. 点不同视频 → 右栏换成各自保存的设置 ─────────────────────────
  const cards = page.getByTestId('video-result-card');
  await expect(cards).toHaveCount(2);
  const savedPanel = page.getByTestId('video-saved-settings');
  await expect(savedPanel).toHaveCount(0, { timeout: 5_000 }); // 还没点选时不显示

  // 先点素材 A（Kling 2.5 · 5 秒 · 带尾帧 · 智能分镜开）
  await cards.filter({ hasText: '素材 A' }).click();
  await expect(savedPanel).toBeVisible({ timeout: 10_000 });
  await expect(savedPanel).toContainText('kling-2.5');
  await expect(savedPanel).toContainText('5 秒');
  await expect(savedPanel).toContainText('带尾帧');
  await expect(savedPanel).toContainText('智能分镜');
  await expect(savedPanel).toContainText('镜头推进');

  // 再点素材 B（Seedance 2.5 · 12 秒 · 仅首帧 · 智能分镜关）
  await cards.filter({ hasText: '素材 B' }).click();
  await expect(savedPanel).toContainText('doubao-seedance-2-5');
  await expect(savedPanel).toContainText('12 秒');
  await expect(savedPanel).toContainText('仅首帧');
  await expect(savedPanel).toContainText('一只手掀开沙发坐垫');

  // ── 2. 改动后提示、还原恢复原值 ────────────────────────────────────
  // 改一下这条视频的秒数（右栏第一行的秒数下拉）。
  const durationSelect = page.locator('.video-motion-card .video-control.text-center').first();
  await durationSelect.selectOption('10');
  await expect(page.getByTestId('video-settings-changed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('video-settings-changed')).toContainText('改过了，再生成会多做一条，原来那条不变');
  // 还原 → 提示消失、秒数回到 12。
  await page.getByRole('button', { name: '还原', exact: true }).click();
  await expect(page.getByTestId('video-settings-changed')).toHaveCount(0);
  await expect(durationSelect).toHaveValue('12');

  // 再生成一条不会删除原来的：素材 A/B 仍在列表里。
  await expect(cards).toHaveCount(2);

  // ── 3/4. 批量检查窗口 ────────────────────────────────────────────────
  await page.getByRole('button', { name: /^批量检查 2 个分镜$/ }).click();
  const dialog = page.getByRole('dialog', { name: '批量检查分镜' });
  await dialog.waitFor({ timeout: 15_000 });

  const bulkProvider = dialog.getByTestId('bulk-provider');
  const bulkDuration = dialog.getByTestId('bulk-duration');
  const bulkHint = dialog.getByTestId('bulk-duration-hint');
  await bulkProvider.waitFor();
  await bulkDuration.waitFor();
  await expect(bulkHint).toBeVisible();

  const durationOptionValues = async () => (await bulkDuration.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value)));

  // 两个分镜分别是 Kling 2.5（5/10）与 Seedance 2.5（4–20）→ 交集只有 5 / 10。
  assert.deepEqual(await durationOptionValues(), ['5', '10'], '统一秒数只给两个模型都支持的秒数（5 / 10）');
  await expect(bulkHint).toContainText('5 / 10 秒');

  // 统一供应商会把两家都换成 Kling 3.0（3–15）→ 秒数选项跟着更新为 3–15。
  await bulkProvider.selectOption('prov-kling3');
  await expect.poll(async () => (await durationOptionValues())[0]).toBe('3');
  const afterProvider = await durationOptionValues();
  assert.equal(afterProvider[0], '3', '换统一供应商后秒数下限跟着新模型走');
  assert.equal(afterProvider[afterProvider.length - 1], '15', '换统一供应商后秒数上限跟着新模型走');
  assert.deepEqual(afterProvider, Array.from({ length: 13 }, (_, index) => String(index + 3)), '统一后两家都是 Kling 3.0，交集就是它自己的 3–15');

  // 再统一到 Seedance 2.5（唯一模型）→ 交集变成 Seedance 自己的 4–20。
  await bulkProvider.selectOption('prov-seedance25');
  await expect.poll(async () => (await durationOptionValues()).length).toBeGreaterThan(2);
  const seedanceOptions = await durationOptionValues();
  assert.equal(seedanceOptions[0], '4');
  assert.equal(seedanceOptions[seedanceOptions.length - 1], '20');

  // 统一秒数下拉能真的把秒数应用到所有分镜。
  await bulkDuration.selectOption('7');
  await expect(bulkHint).toContainText('4–20 秒');

  // 逐条秒数仍可改。
  const rowDurations = dialog.locator('.video-bulk-duration');
  await expect(rowDurations).toHaveCount(2);
  await rowDurations.first().selectOption('9');
  assert.equal(await rowDurations.first().inputValue(), '9', '逐条改秒数仍然可用');

  // 提示词可直接改，且打字不丢焦点。
  const rowPrompts = dialog.locator('.video-bulk-prompt-input');
  await expect(rowPrompts).toHaveCount(2);
  const firstPrompt = rowPrompts.first();
  await firstPrompt.click();
  await firstPrompt.fill('');
  await firstPrompt.type('逐字打字不丢焦点', { delay: 20 });
  assert.equal(await firstPrompt.inputValue(), '逐字打字不丢焦点', '批量窗口的提示词输入不能丢字');
  assert.equal(await firstPrompt.evaluate((node) => node === document.activeElement), true, '打字过程中焦点必须留在输入框');

  // 一键填充只填空着的：第一行有内容（刚打的），第二行空着 → 只有第二行被填。
  await dialog.getByRole('button', { name: '一键填充提示词' }).click();
  assert.equal(await rowPrompts.first().inputValue(), '逐字打字不丢焦点', '已有内容不得被一键填充覆盖');
  assert.ok((await rowPrompts.nth(1).inputValue()).length > 0, '空着的提示词应被填充');

  // 全部生成只提交还没有任务的分镜：夹具里两个分镜都已有成功任务 → 不提交任何新任务。
  await dialog.getByRole('button', { name: '全部生成' }).click();
  await expect(page.getByText('全部分镜都已有任务，未提交新任务。')).toBeVisible({ timeout: 10_000 });
  assert.equal(submittedBatches.length, 0, '已有任务的分镜不得再次提交');

  await page.screenshot({ path: path.resolve('outputs/video-step-bulk-drawer.png'), fullPage: true });
  assert.deepEqual(pageErrors, [], '页面不应出现运行时异常');
  assert.deepEqual(projectPatches, [], '视频页不得再提交并发设置等生产参数');
  console.log('video-step-settings.playwright.test.mjs: ok (saved settings follow the selected clip, change hint + revert, intersection durations + provider switch, editable prompts without focus loss, fill-empty-only, generate-missing-only, no concurrency control)');
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) { server.kill('SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
