/**
 * 07 号票的页面级行为验收（第 1 步场景图 / 第 2 步分镜）。
 *
 *   npm run build && node scripts/workbench-scene-shots.playwright.test.mjs
 *
 * 用真实生产构建 + 受控 API 夹具（临时数据根、断外网、不调用真实模型），逐条验
 * 任务单验收条件里**尺寸检查量不到**的那部分行为：
 *
 *   第 1 步：默认对照 / 左右键切候选且不翻页 / 网格↔对照选中不变 /
 *            标记、场景参考图、类目提示词、数量与按钮文字、生成中占位 / 没有并发设置
 *   第 2 步：上传入口 / 全选再点取消 / 设为开场顺序 / 切版本不丢旧版 /
 *            失败分镜写明原因且不能标可用 / 删除前确认
 *
 * 尺寸与「两内核 × 三窗口 × 浅深两色」的排版归 04 的界面验收工具：
 *   TEAM_ACCEPTANCE_UI_SCREENS=project-scene,project-storyboard,... node scripts/ui-acceptance.playwright.test.mjs
 * 这里不重复量像素，只验行为。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-scene-shots-'));
const probe = net.createServer();
const port = await new Promise((resolve) => {
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
const entry = path.resolve('.next/standalone/server.js');
assert.ok(fs.existsSync(entry), '请先在当前 cwd 完成 npm run build，再运行本测试');

const server = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-4_000); });
}

/** 96×128 纯色 PNG（上传夹具用；不联网、不依赖 sharp）。 */
function solidPng(rgb, width = 96, height = 128) {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = solidPng([210, 210, 214]);
const LANDSCAPE_PNG = solidPng([80, 150, 130], 192, 96);
const PROJECT_ID = 'workbench-project';
const NAMES = { seed: 'seed.png', a: 'shot-1.png', b: 'shot-2.png', c: 'shot-3.png' };

// ── 夹具状态 ──
let project;
let sceneJobs = [];
const uploads = [];
const createdShotSets = [];
const selectionPatches = [];
const deletedShotSets = [];
const regenerations = [];
// 原地重试（POST /api/jobs/:id/retry）与重做（/regenerate）分开记，用来区分「原供应商重跑」与「按新供应商新建一版」。
const retries = [];
const appliedScenes = [];
const sceneReferences = [
  { id: 'scene-ref-1', name: '暖色客厅', imageAssetId: 'scene-out-1', status: 'active' },
  { id: 'scene-ref-2', name: '明亮客厅', imageAssetId: 'scene-out-2', status: 'active' },
];
let queueStatus = 'idle';
let groupGenerationState = 'normal';

function imageAsset(usage, filename) {
  return {
    id: `img-${uploads.length + 1}`,
    role: 'input',
    filename,
    path: `storage/uploads/${filename}`,
    imageUrl: `/api/images/uploads/${filename}`,
    usage,
  };
}

function addUpload(usage, filename) {
  const asset = imageAsset(usage, filename);
  uploads.push(asset);
  project = { ...project, images: [...project.images, asset] };
  return asset;
}

function seedJobs() {
  return [
    { id: 'scene-job-1', inputFilename: NAMES.seed, outputFilename: '场景-候选-1.png', status: 'succeeded', inputImageId: 'img-1', outputImageId: 'scene-out-1', reviewMark: 'available', prompt: '卧室换场景', providerId: 'provider-1', model: 'gpt-image-2', size: '1024x1024' },
    { id: 'scene-job-2', inputFilename: NAMES.seed, outputFilename: '场景-候选-2.png', status: 'succeeded', inputImageId: 'img-1', outputImageId: 'scene-out-2', reviewMark: '', prompt: '卧室换场景', providerId: 'provider-1', model: 'gpt-image-2', size: '1024x1024' },
    { id: 'scene-job-3', inputFilename: NAMES.seed, status: 'failed', inputImageId: 'img-1', errorMessage: '供应商返回 400：提示词被安全策略拦截', prompt: '卧室换场景' },
    { id: 'scene-job-4', inputFilename: NAMES.seed, status: 'pending', inputImageId: 'img-1', prompt: '卧室换场景' },
  ];
}

function shotDetail() {
  const a = uploads.find((item) => item.filename === NAMES.a);
  const b = uploads.find((item) => item.filename === NAMES.b);
  if (['ungenerated', 'pending', 'needs_check', 'blocked'].includes(groupGenerationState)) {
    return {
      status: 'draft',
      shots: [a, b].map((asset, index) => ({
        id: `shot-${index + 1}`, indexNum: index + 1,
        sourceImageId: asset.id, sourceFilename: asset.filename, sourceImageUrl: asset.imageUrl,
        latestJobId: groupGenerationState === 'ungenerated' ? undefined : `shot-job-${index + 1}`,
        jobStatus: groupGenerationState === 'ungenerated' ? undefined : groupGenerationState === 'blocked' ? 'failed' : groupGenerationState,
        jobErrorMessage: groupGenerationState === 'blocked' ? '供应商安全审核未通过，请调整素材后重新生成。' : undefined,
        resultCandidates: [],
      })),
    };
  }
  return {
    status: groupGenerationState === 'complete' ? 'completed' : groupGenerationState === 'running' ? 'generating' : 'draft',
    shots: [
      {
        id: 'shot-1', indexNum: 1,
        sourceImageId: a.id, sourceFilename: NAMES.a, sourceImageUrl: a.imageUrl,
        latestGeneratedImageId: 'shot-1-v2', generatedImageUrl: '/api/images/outputs/shot-1-v2.png',
        latestJobId: 'shot-job-1', jobStatus: 'succeeded', jobPrompt: '第 1 镜：产品全景', reviewMark: '',
        referenceImageIds: '["scene-out-1"]',
        resultCandidates: [
          { shotId: 'shot-1', jobId: 'shot-job-1a', imageAssetId: 'shot-1-v1', createdAt: '2026-11-01T00:00:00Z', imageUrl: '/api/images/outputs/shot-1-v1.png', jobStatus: 'succeeded', jobPrompt: '第 1 镜：旧版' },
          { shotId: 'shot-1', jobId: 'shot-job-1', imageAssetId: 'shot-1-v2', createdAt: '2026-11-02T00:00:00Z', imageUrl: '/api/images/outputs/shot-1-v2.png', jobStatus: 'succeeded', jobPrompt: '第 1 镜：产品全景' },
        ],
      },
      {
        id: 'shot-2', indexNum: 2,
        sourceImageId: b.id, sourceFilename: NAMES.b, sourceImageUrl: b.imageUrl,
        latestJobId: 'shot-job-2', jobStatus: groupGenerationState === 'normal' ? 'failed' : groupGenerationState === 'running' ? 'running' : 'succeeded',
        // 失败的分镜任务也记着自己用的是哪个供应商：右栏换供应商后点「重试」必须按新供应商重做。
        providerId: 'provider-1', jobPrompt: '第 2 镜：细节', resultCandidates: [],
      },
    ],
    sceneRefName: '验收场景参考',
    sceneRefImageUrl: '/api/images/scene-reference.png',
  };
}

async function installRoutes(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'GET' ? null : (() => {
      try { return request.postDataJSON(); } catch { return null; }
    })();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const png = () => route.fulfill({ status: 200, contentType: 'image/png', body: PNG });

    if (pathname === `/api/projects/${PROJECT_ID}`) {
      if (method === 'PATCH') {
        if (typeof body?.scenePrompt === 'string') project = { ...project, scenePrompt: body.scenePrompt };
        if (typeof body?.shotPrompt === 'string') project = { ...project, shotPrompt: body.shotPrompt };
      }
      return json(project);
    }
    if (pathname === `/api/projects/${PROJECT_ID}/run`) {
      if (method === 'POST') queueStatus = 'running';
      return json({ queueStatus });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/scene-jobs`) {
      sceneJobs = seedJobs();
      return json({ jobIds: sceneJobs.map((job) => job.id) });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/scene-references`) return json(sceneReferences);
    if (pathname === `/api/projects/${PROJECT_ID}/creative-package`) return png();
    if (pathname === `/api/projects/${PROJECT_ID}/shot-sets`) {
      if (method === 'POST') {
        createdShotSets.push(body);
        return json({ id: 'set-created', name: body.name, kind: 'storyboard' });
      }
      return json([{ id: 'set-1', name: '验收分镜组', shotCount: 2, generatedCount: 1, approvedCount: 0, status: 'draft', createdAt: '2026-11-01T00:00:00Z' }]);
    }
    if (pathname === '/api/shot-sets/set-1' && method === 'GET') return json({ id: 'set-1', name: '验收分镜组', ...shotDetail() });
    if (pathname === '/api/shot-sets/set-1/apply-scene' && method === 'POST') {
      appliedScenes.push(body);
      return json({ success: true, jobCount: 2 });
    }
    if (pathname.startsWith('/api/shot-sets/') && method === 'PATCH') {
      selectionPatches.push(body);
      return json({ success: true });
    }
    if (pathname.startsWith('/api/shot-sets/') && method === 'DELETE') {
      deletedShotSets.push(pathname.split('/').at(-1));
      return json({ success: true });
    }
    if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/regenerate')) {
      regenerations.push(body);
      return json({ newJobId: 'shot-job-1-redo' });
    }
    if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/retry')) {
      retries.push({ pathname, body });
      return json({ success: true });
    }
    if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/resume-poll')) return json({ success: true });
    if (pathname === '/api/team/models') {
      return json([
        { id: 'provider-1', name: '验收供应商', model: 'gpt-image-2', type: 'openai', enabled: 1, hasApiKey: true },
        { id: 'provider-2', name: '备用供应商', model: 'gpt-image-2', type: 'openai', enabled: 1, hasApiKey: true },
      ]);
    }
    if (pathname === '/api/team/auth/session') return json({ authenticated: true, role: 'employee', displayName: '验收员工' });
    if (pathname.startsWith('/api/images/')) return route.fulfill({status:200,contentType:'image/png',body:pathname.includes('/uploads/') ? LANDSCAPE_PNG : PNG});
    return json({});
  });
}

/** 多选上传：点上传按钮 → 在 filechooser 里一次给多个文件。 */
async function uploadViaChooser(page, label, files) {
  const chooser = page.waitForEvent('filechooser', { timeout: 30_000 });
  await page.getByRole('button', { name: new RegExp(label) }).first().click();
  await (await chooser).setFiles(files.map((name) => ({ name, mimeType: 'image/png', buffer: PNG })));
}

/** 轮询按钮的禁用状态；超时仍返回最后一次读到的值，让断言报出中文原因而不是英文超时。 */
async function waitForDisabledState(locator, expectedDisabled, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let disabled = await locator.isDisabled();
  while (disabled !== expectedDisabled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    disabled = await locator.isDisabled();
  }
  return disabled;
}

let browser;
const pageErrors = [];
try {
  let ready = false;
  const readyDeadline = Date.now() + 40_000;
  while (Date.now() < readyDeadline) {
    if (server.exitCode !== null) throw new Error('夹具服务提前退出');
    try { ready = (await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })).ok; } catch { /* 启动中 */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, `夹具服务必须可访问：${serverOutput}`);

  project = {
    id: PROJECT_ID,
    name: '20261108-B店-XQ9A-AI种草-验收',
    productCode: 'XQ9A', storeCode: 'B店', productionType: 'AI种草', editorName: '验收',
    providerId: 'provider-1', model: 'gpt-image-2', size: '1024x1024',
    prompt: '', scenePrompt: '保持图中床的一致性不变，更换其他家具和软装布置，让卧室温馨舒适，全景图',
    shotPrompt: '图1是待编辑分镜图，图2是场景参考图。',
    status: 'draft', concurrency: 3, maxAttempts: 2,
    images: [], jobs: [],
    provider: { id: 'provider-1', name: '验收供应商', model: 'gpt-image-2' },
  };

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1536, height: 900 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installRoutes(page);
  const checkComparison = async (original, result, label) => {
    for (const [width, height] of [[1536,900],[1280,720],[1024,720]]) {
      await page.setViewportSize({width,height});
      const first=page.getByRole('button',{name:`放大预览：${original}`,exact:true});
      const second=page.getByRole('button',{name:`放大预览：${result}`,exact:true});
      await first.locator('img').evaluate(img=>img.decode());
      await second.locator('img').evaluate(img=>img.decode());
      const a=await first.boundingBox(),b=await second.boundingBox();
      assert.ok(Math.abs(a.height-b.height)<1&&a.height>=220&&a.height<=560,'横图与竖图使用同样且有上限的预览区域');
      assert.equal(await first.locator('img').evaluate(img=>getComputedStyle(img).objectFit),'contain','原图必须完整显示');
      await second.click();
      const dialog=page.getByRole('dialog',{name:result,exact:true});
      await dialog.waitFor();
      const box=await dialog.boundingBox();
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,'放大预览与关闭按钮完整位于窗口内');
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
      assert.ok(await second.evaluate(el=>el===document.activeElement),'关闭预览后焦点回到图片');
      const mark=await page.getByRole('button',{name:'可用',exact:true}).first().boundingBox();
      assert.ok(mark.y+mark.height<=height+1,'图片下方的标记操作应在当前窗口内可见');
      const evidence=path.resolve('outputs/04-测试与验收/2026-11-09-preview-fixes');
      fs.mkdirSync(evidence,{recursive:true});
      await page.screenshot({path:path.join(evidence,`${label}-${width}.png`)});
    }
    await page.setViewportSize({width:1536,height:900});
  };

  // ═════════════ 第 1 步 ═════════════
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=scene`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('page-toolbar').first().waitFor({ timeout: 90_000 });
  assert.equal((await page.getByTestId('page-toolbar-title').first().innerText()).trim(), project.name, '工具栏标题必须是项目名');
  for (const label of ['场景图', '分镜', '脚本', '视频', '混剪']) {
    assert.equal(await page.getByRole('tab', { name: label, exact: true }).count(), 1, `五步切换必须有「${label}」`);
  }
  await page.getByRole('link', { name: /导出项目包/ }).first().waitFor({ timeout: 30_000 });
  await page.getByTestId('step-empty').waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('step-empty').innerText(), /先放一张原始场景图/, '新项目第 1 步必须有空状态');

  // 上传多张原图（多选）
  addUpload('scene_seed', NAMES.seed);
  await uploadViaChooser(page, '上传图片', [NAMES.seed]);
  await page.getByRole('button', { name: '生成 4 张', exact: true }).waitFor({ timeout: 30_000 });

  // 没有并发设置
  assert.equal(await page.getByText('并发', { exact: false }).count(), 0, '第 1 步右栏不能再有并发设置');

  // 数量调节 + 按钮文案跟着变
  await page.getByRole('button', { name: '增加数量' }).click();
  await page.getByRole('button', { name: '生成 5 张', exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '减少数量' }).click();
  await page.getByRole('button', { name: '生成 4 张', exact: true }).waitFor({ timeout: 10_000 });

  // 类目带出提示词：改场景后提示词会同步到项目（PATCH scenePrompt）
  const promptBefore = project.scenePrompt;
  await page.getByLabel('场景', { exact: true }).selectOption({ index: 1 });
  await page.waitForFunction(() => true, null, { timeout: 1_500 });
  assert.notEqual(project.scenePrompt, promptBefore, '选类目必须把提示词同步到项目');

  // 生成中占位 + 候选：默认对照，原图与候选并排
  sceneJobs = seedJobs();
  project = { ...project, jobs: sceneJobs };
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=scene`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 });
  assert.equal(await page.getByTestId('workbench-scene').getAttribute('data-view'), 'compare', '默认必须是「对照」视图');
  await page.getByAltText('原始场景图', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('候选 1', { exact: true }).first().waitFor({ timeout: 30_000 });
  await checkComparison('原始场景图','候选结果','scene');
  // 排队中的那张先占位显示「生成中」（左栏候选列表里有状态标签）
  assert.equal(await page.getByText('排队中', { exact: true }).count() > 0, true, '生成中的候选必须先占位');

  // 左右键切候选、不翻页
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await page.getByText('候选 2', { exact: true }).first().waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, '方向键不得让页面滚动（不翻页）');

  // 网格 ↔ 对照往返，选中不变
  await page.getByRole('button', { name: '网格', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-scene"]')?.getAttribute('data-view') === 'grid', null, { timeout: 10_000 });
  assert.ok(await page.locator('[data-testid="workbench-scene"] [aria-current="true"]').count() >= 1, '网格里必须保留选中态');
  await page.getByRole('button', { name: '对照', exact: true }).click();
  await page.getByText('候选 2', { exact: true }).first().waitFor({ timeout: 10_000 });

  // 成功候选可标可用；失败候选不能
  assert.equal(await page.getByRole('button', { name: '可用', exact: true }).first().isDisabled(), false, '成功候选可以标可用');
  await page.getByRole('button', { name: '候选 3', exact: true }).first().click();
  await page.getByText('这张没生成出来', { exact: false }).first().waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole('button', { name: '可用', exact: true }).first().isDisabled(), true, '失败候选不能标可用');
  assert.equal(await page.getByRole('button', { name: /设为场景参考图/ }).first().isDisabled(), true, '失败候选不能设为场景参考图');

  // ═════════════ 第 2 步 ═════════════
  addUpload('shot_source', NAMES.a);
  addUpload('shot_source', NAMES.b);
  addUpload('shot_source', NAMES.c);
  project.images.push(...sceneReferences.map((ref) => ({ id: ref.imageAssetId, role: 'output', filename: `${ref.name}.png`, imageUrl: `/api/images/outputs/${ref.imageAssetId}.png` })));
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=storyboard`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workbench-storyboard').waitFor({ timeout: 60_000 });

  // 左栏有「上传原始分镜图」（可拖入 + 可多选）
  await page.getByRole('button', { name: /上传原始分镜图/ }).first().waitFor({ timeout: 30_000 });
  await uploadViaChooser(page, '上传原始分镜图', [NAMES.a, NAMES.b, NAMES.c]);

  // 默认原图与结果并排
  await page.getByAltText('原图', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('结果', { exact: true }).first().waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('shot-version').innerText(), /第 \d 版（共 \d 版）/, '结果必须显示「第 N 版（共 M 版）」');
  await checkComparison('原图','结果','storyboard');

  // 左右键切分镜
  await page.keyboard.press('ArrowRight');
  await page.getByText('这张没生成出来', { exact: false }).first().waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole('button', { name: '可用', exact: true }).first().isDisabled(), true, '失败分镜不能标可用');
  await page.getByRole('button', { name: '重试', exact: true }).first().waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '分镜 1', exact: true }).first().click();

  // 切历史版本：旧版保留（服务端记住选中）
  await page.getByRole('button', { name: '上一版' }).click();
  await page.waitForFunction(() => true, null, { timeout: 1_000 });
  assert.equal(selectionPatches.some((patch) => patch.shotId === 'shot-1' && patch.selectedImageAssetId === 'shot-1-v1'), true, '切版本必须把选中的旧版写回分镜');
  assert.equal(deletedShotSets.length, 0, '切版本不能删任何东西');

  // 改提示词重做：带这一张的提示词
  await page.getByRole('button', { name: /重新生成/ }).first().click();
  await page.waitForFunction(() => true, null, { timeout: 1_500 });
  assert.equal(regenerations[0]?.prompt, '第 1 镜：产品全景', '重做必须带上这一张的提示词');
  assert.equal('referenceImageIds' in (regenerations[0] ?? {}), false, '重做不得把参考图清空（不传 referenceImageIds 才沿用原任务）');

  // ── 失败分镜：两个「重新生成」入口必须可用；换供应商后「重试」必须按新供应商重做 ──
  // 契约：
  //   1) 失败分镜（jobStatus='failed'）也要能点「重新生成」——之前拿 canMark（只允许 succeeded）当门禁；
  //   2) 右栏供应商改成与失败任务不同的 provider-2 后，点失败占位里的「重试」必须走
  //      POST /api/jobs/:id/regenerate（body.providerId=provider-2），成功后 PATCH 分镜关联新任务；
  //   3) 供应商换回任务原 provider-1 后，「重试」仍走 POST /api/jobs/:id/retry（原任务重跑语义）。
  // 三条契约的违规先收集再一次性抛出，避免第一条失败掩盖后面的 bug。
  const contractViolations = [];
  const expectContract = (label, check) => {
    try { check(); } catch (error) { contractViolations.push(`${label}：${error.message}`); }
  };

  await page.getByRole('button', { name: '分镜 2', exact: true }).first().click();
  await page.getByText('这张没生成出来', { exact: false }).first().waitFor({ timeout: 10_000 });
  const storyboard = page.getByTestId('workbench-storyboard');
  const shotSettings = storyboard.getByRole('complementary', { name: '设置' });
  // 右栏是 <label><span>供应商</span><select>…</select></label>：Playwright 的 label 文本会把
  // option 文案也算进去，getByLabel('供应商', { exact: true }) 匹配不到，这里按标签文本过滤。
  const providerSelect = shotSettings.locator('label').filter({ hasText: '供应商' }).locator('select').first();
  await providerSelect.waitFor({ timeout: 10_000 });
  const providerValues = await providerSelect.locator('option').evaluateAll((options) => options.map((option) => option.value));
  expectContract('右栏供应商下拉必须包含新供应商 provider-2', () => {
    assert.deepEqual(providerValues, ['provider-1', 'provider-2'], `右栏「供应商」下拉应列出 provider-1 与新加的 provider-2，实际：${JSON.stringify(providerValues)}`);
  });
  // 右栏「重新生成这一张」还要等重做提示词按这一张的 jobPrompt 回填（空提示词本来就会被禁用）。
  await shotSettings.locator('textarea').first().waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="workbench-storyboard"] aside[aria-label="设置"] textarea')?.value.trim()),
    null,
    { timeout: 10_000 },
  );

  const bottomRegenerate = storyboard.getByRole('button', { name: '重新生成', exact: true });
  const bottomRegenerateDisabled = await waitForDisabledState(bottomRegenerate, false);
  expectContract('失败分镜下底部动作条「重新生成」必须可用', () => {
    assert.equal(bottomRegenerateDisabled, false, '失败分镜（jobStatus=failed）也要能重新生成，不能因为「不能标可用」被禁用');
  });
  const sideRegenerate = page.getByRole('button', { name: '重新生成这一张', exact: true });
  const sideRegenerateDisabled = await waitForDisabledState(sideRegenerate, false);
  expectContract('失败分镜下右栏「重新生成这一张」必须可用', () => {
    assert.equal(sideRegenerateDisabled, false, '失败分镜（jobStatus=failed）右栏也要能重新生成，不能因为「不能标可用」被禁用');
  });

  // 换成与失败任务原供应商（provider-1）不同的 provider-2，点失败占位里的「重试」→ 必须新建任务。
  await providerSelect.selectOption('provider-2');
  const retriesBeforeForeignProvider = retries.length;
  const regenerationsBeforeForeignProvider = regenerations.length;
  const retryButton = page.getByRole('button', { name: '重试', exact: true }).first();
  await retryButton.waitFor({ timeout: 10_000 });
  const foreignRegenerateResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/jobs/shot-job-2/regenerate'),
    { timeout: 12_000 },
  ).catch(() => null);
  const foreignSelectionPatchResponse = page.waitForResponse((response) => {
    if (response.request().method() !== 'PATCH' || !response.url().endsWith('/api/shot-sets/set-1')) return false;
    try {
      const patch = response.request().postDataJSON();
      return patch?.shotId === 'shot-2' && patch?.latestJobId === 'shot-job-1-redo';
    } catch { return false; }
  }, { timeout: 12_000 }).catch(() => null);
  await retryButton.click();
  const foreignRegenerate = await foreignRegenerateResponse;
  if (foreignRegenerate) await foreignSelectionPatchResponse;
  await page.waitForFunction(() => true, null, { timeout: 300 });

  expectContract('换供应商后点「重试」必须走 POST /regenerate 且带上新供应商', () => {
    assert.equal(regenerations.length, regenerationsBeforeForeignProvider + 1, '右栏供应商换成 provider-2 后点「重试」，必须新发一次 POST /api/jobs/:id/regenerate（不能只发无 body 的 /retry，原任务供应商是冻结的）');
    assert.equal(regenerations.at(-1)?.providerId, 'provider-2', 'regenerate 请求体必须带上右栏新选的 providerId=provider-2（当前只发 /retry，换供应商不生效）');
    assert.equal(regenerations.at(-1)?.prompt, '第 2 镜：细节', '按新供应商重做必须带重做提示词或原 jobPrompt');
  });
  expectContract('换供应商后点「重试」不得再发原地 /retry', () => {
    assert.equal(retries.length, retriesBeforeForeignProvider, '已换成与失败任务不同的供应商时点「重试」不该再发 POST /api/jobs/:id/retry');
  });
  expectContract('换供应商重做成功后必须把新任务写回这个分镜', () => {
    assert.deepEqual(selectionPatches.at(-1), { shotId: 'shot-2', latestJobId: 'shot-job-1-redo' }, '重新生成成功后必须 PATCH /api/shot-sets/set-1 把 latestJobId 指向新任务');
  });

  // 换回任务原供应商 provider-1：点「重试」仍应原地重跑这个任务（/retry，不新开一版）。
  await providerSelect.selectOption('provider-1');
  const retriesBeforeSameProvider = retries.length;
  const regenerationsBeforeSameProvider = regenerations.length;
  const sameProviderRetryResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/jobs/shot-job-2/retry'),
    { timeout: 12_000 },
  ).catch(() => null);
  await retryButton.click();
  const sameProviderRetry = await sameProviderRetryResponse;
  await page.waitForFunction(() => true, null, { timeout: 300 });

  expectContract('供应商没换时点「重试」必须仍走 POST /retry', () => {
    assert.ok(sameProviderRetry, '右栏供应商与失败任务原来的 provider-1 相同时，点「重试」必须仍发 POST /api/jobs/shot-job-2/retry');
    assert.equal(retries.length, retriesBeforeSameProvider + 1, '换回原供应商后点「重试」必须新发一次 POST /api/jobs/:id/retry');
    assert.ok(retries.at(-1)?.pathname?.endsWith('/api/jobs/shot-job-2/retry'), `「重试」必须打到这个分镜自己的任务，实际：${JSON.stringify(retries.at(-1))}`);
    assert.equal(regenerations.length, regenerationsBeforeSameProvider, '没有换供应商时点「重试」不该新发 /regenerate');
  });

  // 回到成功分镜 1：后面的切版本 / 参考图断言都基于 shot-1。
  await page.getByRole('button', { name: '分镜 1', exact: true }).first().click();
  await page.getByRole('button', { name: '上一版' }).waitFor({ timeout: 10_000 });

  assert.deepEqual(contractViolations, [], `失败分镜重新生成相关的行为契约未满足：\n${contractViolations.join('\n')}`);

  // 新版右栏必须保留整组场景选择入口，且提交选择的场景记录。
  await page.getByRole('button', { name: '选择场景参考图', exact: true }).click();
  await page.getByRole('heading', { name: '选择新场景图并生成分镜', exact: true }).waitFor();
  await page.getByRole('button', { name: /明亮客厅/ }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/set-1/apply-scene')),
    page.getByRole('button', { name: '创建任务并开始', exact: true }).click(),
  ]);
  assert.equal(appliedScenes.at(-1)?.sceneReferenceId, 'scene-ref-2');
  await page.getByRole('heading', { name: '选择新场景图并生成分镜', exact: true }).waitFor({ state: 'detached' });

  // 单张选择按任务参考图回填；换图、多选和清空必须真正进入请求。
  await page.getByRole('button', { name: '选择本张参考图（1）', exact: true }).click();
  const refsDialog = page.getByRole('dialog', { name: '选择本张参考图', exact: true });
  assert.equal(await refsDialog.getByRole('button', { name: '暖色客厅', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await refsDialog.getByRole('button', { name: NAMES.a, exact: true }).count(), 0, '底图不能再被选作参考图');
  await refsDialog.getByRole('button', { name: '暖色客厅', exact: true }).click();
  await refsDialog.getByRole('button', { name: '明亮客厅', exact: true }).click();
  await refsDialog.getByRole('button', { name: '暖色客厅', exact: true }).click();
  await refsDialog.getByRole('button', { name: '完成选择', exact: true }).click();
  await page.getByAltText('图2 明亮客厅', { exact: true }).waitFor();
  await page.getByAltText('图3 暖色客厅', { exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/regenerate')),
    page.getByRole('button', { name: '重新生成这一张', exact: true }).click(),
  ]);
  assert.deepEqual(regenerations.at(-1)?.referenceImageIds, ['scene-out-2', 'scene-out-1'], '参考图按选择顺序发送');
  await page.getByRole('button', { name: '选择本张参考图（2）', exact: true }).click();
  await refsDialog.getByRole('button', { name: '清空参考图', exact: true }).click();
  await refsDialog.getByRole('button', { name: '完成选择', exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/regenerate')),
    page.getByRole('button', { name: '重新生成这一张', exact: true }).click(),
  ]);
  assert.deepEqual(regenerations.at(-1)?.referenceImageIds, [], '主动清空必须发送空数组');
  await page.getByRole('button', { name: '分镜 2', exact: true }).first().click();
  await page.getByRole('button', { name: '选择本张参考图（0）', exact: true }).waitFor();
  await page.getByRole('button', { name: '分镜 1', exact: true }).first().click();
  await page.getByRole('button', { name: '选择本张参考图（1）', exact: true }).waitFor();

  // 删除分镜组前必须确认
  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '删除这个分镜组？' });
  await dialog.waitFor({ timeout: 10_000 });
  assert.equal(deletedShotSets.length, 0, '确认前不得发删除请求');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });

  // 新建分镜组窗口：全选 → 再点取消 → 点选顺序 → 设为开场
  await page.getByRole('button', { name: /^新建分镜组$/ }).first().click();
  const sheet = page.getByRole('dialog', { name: '新建分镜组' });
  await sheet.waitFor({ timeout: 10_000 });
  await sheet.getByRole('button', { name: '全选', exact: true }).click();
  await sheet.getByRole('button', { name: '取消全选', exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await sheet.locator('[data-testid="shot-pick"][data-picked="true"]').count(), 3, '全选必须选中全部素材');
  await sheet.getByRole('button', { name: '取消全选', exact: true }).click();
  await page.waitForFunction(() => true, null, { timeout: 1_000 });
  assert.equal(await sheet.locator('[data-testid="shot-pick"][data-picked="true"]').count(), 0, '再点一次必须取消全选');

  const picks = sheet.locator('[data-testid="shot-pick"]');
  await picks.nth(2).click();
  await picks.nth(0).click();
  await picks.nth(1).click();
  const orderText = await sheet.getByText(/^镜头顺序：/).innerText();
  assert.match(orderText, /shot-3\.png → shot-1\.png → shot-2\.png/, `点选顺序必须就是镜头顺序：${orderText}`);
  assert.equal(await sheet.getByText('开场图', { exact: true }).count(), 1, '第一张必须标「开场图」');

  // 悬停任意一张出现「设为开场」，点了移到第一位、其余顺序不变
  await sheet.locator('[data-testid="set-opening"]').first().click({ force: true });
  await page.waitForFunction(() => true, null, { timeout: 500 });
  const reordered = await sheet.getByText(/^镜头顺序：/).innerText();
  assert.match(reordered, /shot-1\.png → shot-3\.png → shot-2\.png/, `设为开场后其余顺序不变：${reordered}`);

  await sheet.getByLabel('分镜组名称').fill('验收新建分镜组');
  await sheet.getByRole('button', { name: /^创建分镜组（3）$/ }).click();
  await page.waitForFunction(() => true, null, { timeout: 1_500 });
  // 点选顺序 img-4(shot-3) → img-2(shot-1) → img-3(shot-2)；把 shot-1 设为开场后
  // 变成 img-2 → img-4 → img-3（其余顺序不变）。
  assert.deepEqual(createdShotSets.at(-1)?.shotImageIds, ['img-2', 'img-4', 'img-3'], '建组必须按点选顺序提交镜头（开场图在第一张）');

  // 即使项目任务列表没有变化，分镜自身轮询也必须把组状态更新为已完成。
  groupGenerationState = 'running';
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=storyboard`, { waitUntil: 'domcontentloaded' });
  const settings = page.getByTestId('workbench-storyboard').getByRole('complementary', { name: '设置' });
  await settings.getByText('生成中', { exact: true }).waitFor();
  groupGenerationState = 'complete';
  await settings.getByText('已完成', { exact: true }).waitFor({ timeout: 10_000 });

  // 建组后没有点击生成：对照和网格都必须显示未生成，不能出现运行占位。
  groupGenerationState = 'ungenerated';
  const submitsBeforeEmpty = appliedScenes.length;
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=storyboard`, { waitUntil: 'domcontentloaded' });
  await page.getByText('还没有生成', { exact: true }).waitFor();
  await page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name: '全部', exact: true }).click();
  const emptyShot = page.getByTestId('workbench-storyboard').getByRole('button', { name: '分镜 1', exact: true });
  assert.match(await emptyShot.innerText(), /未生成/, '未提交的分镜网格不能显示生成中');
  assert.doesNotMatch(await emptyShot.innerText(), /生成中/);
  assert.equal(await emptyShot.locator('[class*="spin"]').count(), 0, '未提交的分镜不能显示转圈动画');
  assert.equal(appliedScenes.length, submitsBeforeEmpty, '进入分镜页或切换视图不能提交生成');

  for (const [state, label] of [['pending', '排队中'], ['needs_check', '等待补抓结果'], ['blocked', '失败']]) {
    groupGenerationState = state;
    await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=storyboard`, { waitUntil: 'domcontentloaded' });
    if (state === 'blocked') await page.getByRole('alert').getByText('供应商安全审核未通过，请调整素材后重新生成。', { exact: true }).waitFor();
    else await page.getByText(label, { exact: true }).first().waitFor();
    await page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name: '全部', exact: true }).click();
    assert.match(await emptyShot.innerText(), new RegExp(label), '网格必须区分排队、补抓和失败');
    if (state === 'blocked') assert.equal(await emptyShot.locator('[class*="spin"]').count(), 0, '安全失败后不能继续转圈');
  }

  assert.deepEqual(pageErrors, [], '页面不应出现运行时异常');
  console.log('workbench scene/shot browser tests passed');
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else server.kill('SIGTERM');
    await exited;
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 锁文件可能仍被系统占用，交给系统清理 */ }
}
