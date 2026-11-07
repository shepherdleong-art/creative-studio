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
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  },
  stdio: 'ignore',
});

/** 96×128 纯色 PNG（上传夹具用；不联网、不依赖 sharp）。 */
function solidPng(rgb) {
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
  ihdr.writeUInt32BE(96, 0);
  ihdr.writeUInt32BE(128, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + 96 * 3);
  for (let x = 0; x < 96; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 128 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = solidPng([210, 210, 214]);
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
let queueStatus = 'idle';

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
  return {
    shots: [
      {
        id: 'shot-1', indexNum: 1,
        sourceImageId: a.id, sourceFilename: NAMES.a, sourceImageUrl: a.imageUrl,
        latestGeneratedImageId: 'shot-1-v2', generatedImageUrl: '/api/images/outputs/shot-1-v2.png',
        latestJobId: 'shot-job-1', jobStatus: 'succeeded', jobPrompt: '第 1 镜：产品全景', reviewMark: '',
        resultCandidates: [
          { shotId: 'shot-1', jobId: 'shot-job-1a', imageAssetId: 'shot-1-v1', createdAt: '2026-11-01T00:00:00Z', imageUrl: '/api/images/outputs/shot-1-v1.png', jobStatus: 'succeeded', jobPrompt: '第 1 镜：旧版' },
          { shotId: 'shot-1', jobId: 'shot-job-1', imageAssetId: 'shot-1-v2', createdAt: '2026-11-02T00:00:00Z', imageUrl: '/api/images/outputs/shot-1-v2.png', jobStatus: 'succeeded', jobPrompt: '第 1 镜：产品全景' },
        ],
      },
      {
        id: 'shot-2', indexNum: 2,
        sourceImageId: b.id, sourceFilename: NAMES.b, sourceImageUrl: b.imageUrl,
        latestJobId: 'shot-job-2', jobStatus: 'failed', jobPrompt: '第 2 镜：细节', resultCandidates: [],
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
    if (pathname === `/api/projects/${PROJECT_ID}/scene-references`) return json([]);
    if (pathname === `/api/projects/${PROJECT_ID}/creative-package`) return png();
    if (pathname === `/api/projects/${PROJECT_ID}/shot-sets`) {
      if (method === 'POST') {
        createdShotSets.push(body);
        return json({ id: 'set-created', name: body.name, kind: 'storyboard' });
      }
      return json([{ id: 'set-1', name: '验收分镜组', shotCount: 2, generatedCount: 1, approvedCount: 0, status: 'draft', createdAt: '2026-11-01T00:00:00Z' }]);
    }
    if (pathname === '/api/shot-sets/set-1' && method === 'GET') return json({ id: 'set-1', name: '验收分镜组', ...shotDetail() });
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
    if (pathname.startsWith('/api/jobs/') && (pathname.endsWith('/retry') || pathname.endsWith('/resume-poll'))) return json({ success: true });
    if (pathname === '/api/team/models') return json([{ id: 'provider-1', name: '验收供应商', model: 'gpt-image-2', type: 'openai', enabled: 1, hasApiKey: true }]);
    if (pathname === '/api/team/auth/session') return json({ authenticated: true, role: 'employee', displayName: '验收员工' });
    if (pathname.startsWith('/api/images/')) return png();
    return json({});
  });
}

/** 多选上传：点上传按钮 → 在 filechooser 里一次给多个文件。 */
async function uploadViaChooser(page, label, files) {
  const chooser = page.waitForEvent('filechooser', { timeout: 30_000 });
  await page.getByRole('button', { name: new RegExp(label) }).first().click();
  await (await chooser).setFiles(files.map((name) => ({ name, mimeType: 'image/png', buffer: PNG })));
}

let browser;
const pageErrors = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server.exitCode !== null) throw new Error('夹具服务提前退出');
    try { ready = (await fetch(baseUrl)).ok; } catch { /* 启动中 */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, '夹具服务必须可访问');

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
  await page.goto(`${baseUrl}/projects/${PROJECT_ID}?tab=storyboard`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workbench-storyboard').waitFor({ timeout: 60_000 });

  // 左栏有「上传原始分镜图」（可拖入 + 可多选）
  await page.getByRole('button', { name: /上传原始分镜图/ }).first().waitFor({ timeout: 30_000 });
  await uploadViaChooser(page, '上传原始分镜图', [NAMES.a, NAMES.b, NAMES.c]);

  // 默认原图与结果并排
  await page.getByAltText('原图', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText('结果', { exact: true }).first().waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('shot-version').innerText(), /第 \d 版（共 \d 版）/, '结果必须显示「第 N 版（共 M 版）」');

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
