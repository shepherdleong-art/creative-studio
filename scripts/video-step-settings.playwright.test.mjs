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
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';

const imageFixture = await sharp({ create: { width: 480, height: 640, channels: 3, background: '#b7a68e' } }).png().toBuffer();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-step-settings-'));
const clipPath = path.join(root, 'preview.mp4');
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=tan:s=360x480:r=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clipPath], { windowsHide: true, stdio: 'ignore' });
const videoFixture = fs.readFileSync(clipPath);
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

  providers.push(...['minimax-h3', 'wan-3.0'].map((model) => ({
    id: model, name: model, category: 'video', type: 'openai-video', defaultModel: model,
    enabled: 1, configured: true, hasApiKey: true, missing: [],
    capabilities: {
      durations: [5, 10], tailFrame: { supported: true, protocol: 'company-gateway-tencent-fileinfos' },
      multiShot: { supported: false, defaultEnabled: false }, reference: { supported: true },
    },
  })));

  const shots = [
    { id: 'shot-1', indexNum: 1, sourceImageId: 'img-1', sourceImageUrl: '/api/images/uploads/shot-1.png' },
    { id: 'shot-2', indexNum: 2, sourceImageId: 'img-2', sourceImageUrl: '/api/images/uploads/shot-2.png' },
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
  const rejectedReasons = [];
  const unrejectedJobIds = [];

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
          id: 'p1', name: '视频设置测试', images: shots.map(shot => ({ id: shot.sourceImageId, role: 'input', usage: 'shot_source', filename: `${shot.id}.png`, imageUrl: shot.sourceImageUrl })), jobs: [], provider: null, model: 'fixture',
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
    } else if (pathname === '/api/video-jobs/job-a') {
      const payload = route.request().postDataJSON();
      if (payload.action === 'reject') {
        rejectedReasons.push({ jobId: 'job-a', reason: payload.reason });
        videoJobs[0].rejectedAt = new Date().toISOString();
        videoJobs[0].rejectReason = payload.reason ?? null;
      } else if (payload.action === 'unreject') {
        unrejectedJobIds.push('job-a');
        videoJobs[0].rejectedAt = null;
        videoJobs[0].rejectReason = null;
      }
      body = { success: true };
    } else if (pathname === '/api/team/models' && url.searchParams.get('kind') === 'video') {
      body = providers;
    } else if (pathname === '/api/video-prompt-templates') {
      body = templates;
    } else if (pathname === '/api/team/auth/session') {
      body = { role: 'employee' };
    } else if (pathname === '/api/upload') {
      body = { files: [{ id: 'uploaded-tail', filename: 'tail.png', imageUrl: '/api/images/uploads/tail.png' }] };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  // 可解码的竖视频用于检查描述增加时，预览比例与可用高度保持稳定。
  await page.route('**/api/videos/**', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: videoFixture }));
  await page.route('**/api/images/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: imageFixture }));

  await page.goto(`${baseUrl}/projects/p1?tab=video`);
  await expect(page.getByRole('heading', { name: '视频生成', exact: true })).toBeVisible({ timeout: 30_000 });

  // ── 5. 视频页没有并发设置 ──────────────────────────────────────────
  await expect(page.getByText('并发', { exact: false })).toHaveCount(0);

  const setSelect = page.getByLabel('选择分镜组', { exact: true });
  await setSelect.waitFor({ timeout: 15_000 });
  await setSelect.selectOption('set-1');
  await expect(page.getByRole('button', { name: /^批量检查 2 个分镜$/ })).toBeVisible({ timeout: 15_000 });

  // 左栏缩略图悬浮显示可辨认的完整大图，并在小窗口内保持可见。
  for (const width of [1536, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const thumbnail = page.locator('.video-shot-thumb').first();
    await thumbnail.hover();
    const preview = page.locator('.theme-preview-popover');
    await expect(preview).toBeVisible();
    await preview.locator('img').evaluate((img) => img.decode());
    const box = await preview.boundingBox();
    assert.ok(box.width >= 250 && box.height >= 300, '悬浮图应明显大于缩略图');
    await page.screenshot({ path: path.resolve(`outputs/video-hover-${width}.png`) });
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900, `悬浮预览完整位于窗口内：${JSON.stringify(box)}`);
    await page.mouse.move(width - 10, 10);
    await expect(preview).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1536, height: 900 });

  // ── 1. 点不同视频 → 右栏换成各自保存的设置 ─────────────────────────
  const cards = page.getByTestId('video-result-card');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('素材 A');
  const savedPanel = page.getByTestId('video-saved-settings');
  await expect(savedPanel).toHaveCount(0, { timeout: 5_000 }); // 还没点选时不显示

  // 先点素材 A（Kling 2.5 · 5 秒 · 带尾帧 · 智能分镜开）
  await cards.filter({ hasText: '素材 A' }).click();
  await expect(savedPanel).toHaveCount(0);
  const promptInput = page.getByPlaceholder('运镜描述（提示词）').first();
  const durationInput = page.locator('.video-motion-card .video-control.text-center').first();
  await expect(promptInput).toHaveValue(videoJobs[0].prompt);
  await expect(durationInput).toHaveValue('5');

  // 点击另一条视频，直接回填可编辑描述，不能再出现重复的只读设置卡。
  await page.getByRole('button', { name: '分镜 2', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await cards.filter({ hasText: '素材 B' }).click();
  await expect(savedPanel).toHaveCount(0);
  await expect(promptInput).toHaveValue(videoJobs[1].prompt);
  await expect(durationInput).toHaveValue('12');

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

  // 切换分镜只筛选展示，不丢失 A/B 或各自编辑设置。
  await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: '分镜 1', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('素材 A');

  // ── 6. 剔除要写原因、能恢复、能隐藏已剔除 ───────────────────────────
  const jobA = cards.filter({ hasText: '素材 A' });
  await jobA.getByRole('button', { name: '剔除', exact: true }).click();
  const reasonInput = jobA.getByLabel('剔除原因，可选');
  await expect(reasonInput).toBeVisible({ timeout: 10_000 });
  await reasonInput.fill('手部变形');
  await jobA.getByRole('button', { name: '确认剔除' }).click();
  await expect.poll(() => rejectedReasons.length).toBe(1);
  assert.equal(rejectedReasons[0].jobId, 'job-a', '剔除请求要带上这条任务的 id');
  assert.equal(rejectedReasons[0].reason, '手部变形', '剔除原因要传给服务端');

  // 已剔除的默认隐藏，可以「显示已剔除」把它找回来，再「恢复使用」。
  await expect(page.getByRole('button', { name: /显示已剔除（\d+）/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /显示已剔除（\d+）/ }).click();
  const restoredCard = cards.filter({ hasText: '素材 A' });
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard).toContainText('剔除原因：手部变形');
  await restoredCard.getByRole('button', { name: '恢复使用', exact: true }).click();
  await expect.poll(() => unrejectedJobIds.length).toBe(1);
  assert.equal(unrejectedJobIds[0], 'job-a');
  // 恢复后可以再隐藏已剔除（此时没有已剔除项，按钮消失）。
  await expect(page.getByRole('button', { name: /显示已剔除（\d+）/ })).toHaveCount(0);

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
  await page.getByRole('button', { name: '关闭批量检查' }).click();
  await page.getByRole('button', { name: '分镜 2', exact: true }).click();
  const motionCard = page.locator('.video-motion-card').first();
  for (const model of ['minimax-h3', 'wan-3.0']) {
    await motionCard.locator('select').first().selectOption(model);
    await expect(motionCard.getByTestId('video-generation-mode')).toContainText('全能参考');
    await expect(motionCard.getByText('添加尾帧图', { exact: true })).toBeVisible();
    await expect(motionCard.getByTestId('video-frame-pair')).toBeVisible();
    await motionCard.locator('input[type=file]').first().setInputFiles({ name: 'tail.png', mimeType: 'image/png', buffer: imageFixture });
    await expect(motionCard.getByAltText('尾帧预览', { exact: true })).toBeVisible();
    await expect(motionCard.getByTestId('video-generation-mode')).toHaveText('首尾帧生成');
    await promptInput.fill('从首帧平滑过渡到尾帧');
    const before = submittedBatches.length;
    await page.getByRole('button', { name: '生成 1 条视频', exact: true }).click();
    await expect.poll(() => submittedBatches.length).toBe(before + 1);
    const item = submittedBatches.at(-1).items[0];
    assert.equal(item.providerId, model);
    assert.equal(item.generationMode, 'image-to-video');
    assert.equal(item.tailImageId, 'uploaded-tail');
    assert.deepEqual(item.referenceAssetIds, []);
    assert.equal('multiShot' in item, false, 'H3/Wan 不发送可灵智能分镜参数');
    await motionCard.locator('.video-frame-tail').hover();
    await motionCard.getByRole('button', { name: '移除尾帧', exact: true }).click();
    await expect(motionCard.getByTestId('video-generation-mode')).toContainText('全能参考');
    await expect(motionCard.getByText('添加尾帧图', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '生成 1 条视频', exact: true }).click();
    await expect.poll(() => submittedBatches.length).toBe(before + 2);
    assert.equal(submittedBatches.at(-1).items[0].generationMode, 'reference-to-video');
    assert.equal(submittedBatches.at(-1).items[0].tailImageId, null);
  }
  await page.screenshot({ path: path.resolve('outputs/video-step-tail-frame-restored.png'), fullPage: true });

  await cards.filter({ hasText: '素材 B' }).click();
  const workspace = page.locator('.video-workspace-prototype');
  const initialBox = await workspace.boundingBox();
  for (const count of [4, 10]) {
    while (await page.locator('.video-motion-card').count() < count) {
      await page.getByRole('button', { name: '添加描述', exact: true }).click();
    }
    const box = await workspace.boundingBox();
    assert.ok(Math.abs(box.height - initialBox.height) <= 1, '描述数量不得撑高工作区');
    const list = page.locator('.video-motion-list').first();
    assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight), '多条描述在右栏内部滚动');
  }
  for (const [width, height] of [[1536, 900], [1280, 720], [1024, 720]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect.poll(async () => page.locator('.video-player').evaluate(video => video.videoWidth)).toBe(360);
      await expect.poll(async () => {
        const video = await page.locator('.video-player').boundingBox();
        const controls = await page.locator('.stage-controls').boundingBox();
        return video && controls && Math.abs(video.width / video.height - 0.75) < 0.02 && controls.y + controls.height <= height;
      }).toBe(true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1), '整页不因多条描述产生滚动');
      for (const selector of ['.video-add-action', '.video-create-action']) {
        const button = await page.locator(selector).boundingBox();
        assert.ok(button.y >= 0 && button.y + button.height <= height, '添加与生成按钮固定在当前窗口内');
      }
      await page.screenshot({ path: path.resolve(`outputs/video-layout-10-descriptions-${width}-${theme}.png`) });
    }
  }
  assert.deepEqual(pageErrors, [], '页面不应出现运行时异常');
  assert.deepEqual(projectPatches, [], '视频页不得再提交并发设置等生产参数');
  console.log('video-step-settings.playwright.test.mjs: ok (saved settings follow the selected clip, change hint + revert, intersection durations + provider switch, editable prompts without focus loss, fill-empty-only, generate-missing-only, reject with reason + restore + hide-rejected, no concurrency control)');
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) { server.kill('SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
