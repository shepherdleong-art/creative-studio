/** npm run build && node scripts/script-studio-template-rewrite.playwright.test.mjs
 * 爆文模板改写浏览器回归（迁移方案 §7 浏览器覆盖）：
 * 导入预览 → 确认保存；推荐勾选 → 提交数量语义；详解编辑；
 * 结果对照（文字差异）与诚实展示；部分完成/停止。
 * 真实生产前端 + 受控 API 夹具：临时数据根、调度器关闭；不读取用户项目，不调用真实模型。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-tpl-rewrite-e2e-'));
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.resolve('.next/standalone/server.js')], {
  env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production',
    CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0' },
  stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('fixture server exited');
    try { ready = (await fetch(baseUrl)).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'fixture server ready');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // ---------------- 夹具状态 ----------------
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  let viralRevisionNumber = 0;
  let viralCurrent = null;
  let importConfirmed = false;
  let submitted;
  let savedSelection;
  let state = { status: 'succeeded', succeededCount: 2, failedCount: 0 };
  const tplEntry = (id, name, category) => ({
    id, revisionId: 'vtpl-rev-1', sourceTemplateId: `src-${id}`, category, subCategory: '伸缩餐桌',
    name, title: `${name}标题`, refText: `标题：${name}\n正文：这是${name}的参考文案，姐妹们真的要看看，小户型也能用上，真心推荐。`,
    structureRaw: '', structureSummary: '', structure: '钩子>痛点>卖点>逼单', structureOrigin: 'fallback',
    rawColumnsJson: '{}', sourceSheet: '全部模板', sourceRow: 2, sourceFileSha256: 'f', contentHash: `h-${id}`,
    status: 'usable', statusReason: '', statusUpdatedBy: 'import', createdAt: startedAt,
  });
  const entries = [tplEntry('e1', '小户型餐桌爆款', '餐桌椅'), tplEntry('e2', '岩板餐桌测评', '餐桌椅'), tplEntry('e3', '实木床爆款', '床')];
  const viralView = () => ({
    library: { id: 'vtpl-lib', currentRevisionId: viralCurrent?.id ?? null, createdAt: startedAt, updatedAt: startedAt },
    current: viralCurrent,
    revisions: viralCurrent ? [{ ...viralCurrent, current: true, entryCount: 3 }] : [],
  });
  let library = { id: 'library-1', revisionNumber: 1, productName: '测试餐桌', category: '餐桌椅', brand: '林氏', sellingPoints: [
    { id: 'point-1', title: '伸缩桌面', factText: '桌面可伸缩', usable: 1, disabledByUser: 0, evidenceGate: 'passed', detailText: '平时四人位，拉开变六人位', detailStatus: 'verified' },
    { id: 'point-2', title: '岩板台面', factText: '台面为岩板', usable: 1, disabledByUser: 0, evidenceGate: 'passed', detailText: '', detailStatus: 'missing' },
  ] };
  const taskSnapshot = () => ({
    id: 'task-fixture', projectId: 'p1', requestedCount: 2, mode: 'reuse',
    ...state, currentStage: 'generate',
    inputSnapshot: { targetDurationSec: 20, requestedCount: 2, providerModel: 'fixture', productionMode: 'template_rewrite' },
    startedAt, updatedAt: startedAt, createdAt: startedAt,
    stages: [{ stage: 'generate', status: 'succeeded', startedAt, finishedAt: startedAt, payload: { generated: state.succeededCount, requested: 2, errors: [] } }],
  });
  const rewriteContent = (index, entry) => ({
    productionMode: 'template_rewrite', version: 4, title: `改写脚本${index}`,
    coverTitleParts: { primary: '测试餐桌', secondary: '', source: 'system_split' },
    templateRewrite: {
      version: 'template-rewrite-v1', entryId: entry.id, revisionId: 'vtpl-rev-1', sourceTemplateId: entry.sourceTemplateId,
      templateName: entry.name, templateTitle: entry.title, category: entry.category, subCategory: entry.subCategory,
      refText: entry.refText, structure: entry.structure, structureOrigin: 'fallback', contentHash: entry.contentHash,
      stylePresetKey: 'friend', stylePresetName: '💬 闺蜜安利（快消/食品/日百）',
      styleAnalysis: { 说话感觉: '像朋友聊天' }, styleDegraded: '',
      whitelistPointIds: ['point-1'], filterDegraded: '', targetChars: 120,
      note: index === 1 ? '把参考里的产品换成本家餐桌，痛点精简为 1 个' : '', noteMissing: index !== 1,
      humanizeDegraded: '', smoothDegraded: '',
    },
    fullScript: '小户型也能用上大餐桌这款伸缩岩板餐桌真的绝了姐妹们一定要看看',
    fullSubtitle: '', segments: [{ id: 'segment-1', narration: '小户型也能用上大餐桌这款伸缩岩板餐桌真的绝了姐妹们一定要看看', subtitle: '', sellingPointIdRefs: ['point-1'], sellingPointRefs: ['伸缩桌面'], visualIntent: '', visualKeywords: [] }],
    sellingPointUsage: [{ sellingPointId: 'point-1', title: '伸缩桌面', status: 'used', reason: '正文已引用' }],
    targetDurationSec: 20, contentCharacterCount: 32, estimatedNarrationDurationSec: 8.5,
    durationStatus: 'too_short', direction: '爆文模板改写', libraryRevisionId: 'library-1',
    templateId: `viral:${entry.sourceTemplateId}`, template: entry.name, templateVersion: 1, templateRationale: entry.name,
  });
  const script = (index) => ({
    id: `script-${index}`, projectId: 'p1', generationTaskId: 'task-fixture', currentRevisionId: `revision-${index}`,
    createdAt: startedAt, updatedAt: startedAt,
    currentRevision: {
      id: `revision-${index}`, revisionNumber: 1, origin: 'ai_generate', createdAt: startedAt,
      contentJson: JSON.stringify(rewriteContent(index, entries[index - 1])),
      validationJson: JSON.stringify({ copyCheck: { endingStatus: 'not_required', semanticReview: 'not_required', policyVersion: 'template-rewrite-v1' }, generationPlanIndex: index }),
      targetDurationSec: 20,
    },
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    let body = {};
    if (pathname === '/api/projects/p1') body = {
      id: 'p1', name: '模板改写测试', images: [], jobs: [], provider: null, model: 'fixture',
      status: 'draft', concurrency: 2, maxAttempts: 1, prompt: '',
    };
    else if (pathname === '/api/script-studio/viral-templates' && method === 'GET') body = viralView();
    else if (pathname === '/api/script-studio/viral-templates/import') {
      if (url.searchParams.get('mode') === 'preview') {
        body = { preview: true, report: { totalRows: 380, validRows: 376, canActivate: true, mergedCategorySheets: false,
          statusCounts: { usable: 376, unusable: 3, review: 1 },
          issues: [{ code: 'entry_unusable', message: '「占位模板」（第 37 行）：参考文案为占位内容（无有效文案）' }] } };
      } else {
        importConfirmed = true;
        viralRevisionNumber += 1;
        viralCurrent = { id: `vtpl-rev-${viralRevisionNumber}`, libraryId: 'vtpl-lib', revisionNumber: viralRevisionNumber,
          sourceFilename: '种草爆文库_模板文案_按类目_20260917.xlsx', sourceSha256: 'abc', createdAt: startedAt,
          entryCounts: { total: 380, usable: 376, unusable: 3, review: 1 }, report: { issues: [] } };
        body = { libraryId: 'vtpl-lib', revisionId: viralCurrent.id, created: true, report: { statusCounts: { usable: 376, unusable: 3, review: 1 } } };
      }
    }
    else if (pathname === '/api/script-studio/viral-templates/entries') {
      const q = (url.searchParams.get('q') || '').trim();
      body = { entries: q ? entries.filter((entry) => [entry.name, entry.title, entry.refText, entry.category].some((field) => field.includes(q))) : entries };
    }
    else if (pathname.endsWith('/script-studio/viral-template-recommend')) body = {
      libraryRevisionId: library.id, usableCount: 3,
      recommendations: [
        { entry: entries[0], score: 14, reasons: ['同类目：餐桌椅', '命中卖点关键词：伸缩、桌面'] },
        { entry: entries[1], score: 10, reasons: ['同类目：餐桌椅'] },
      ],
    };
    else if (pathname.endsWith('/script-studio/tasks/task-fixture/cancel')) {
      state = { ...state, status: 'cancelled' }; body = { task: taskSnapshot() };
    }
    else if (pathname.endsWith('/script-studio/tasks/task-fixture')) body = { task: taskSnapshot() };
    else if (pathname.endsWith('/script-studio/tasks')) {
      if (method === 'POST') {
        submitted = route.request().postDataJSON();
        body = { task: taskSnapshot(), created: true, schedulerEnabled: false };
      } else body = { tasks: ['queued', 'running'].includes(state.status) ? [taskSnapshot()] : [] };
    }
    else if (pathname.endsWith('/script-studio/scripts')) body = { scripts: Array.from({ length: state.succeededCount }, (_, i) => script(i + 1)) };
    else if (pathname.endsWith('/script-studio/library')) {
      if (method === 'POST') {
        savedSelection = route.request().postDataJSON();
        assert.equal(savedSelection.baseRevisionId, library.id);
        library = { ...library, id: 'library-2', revisionNumber: 2,
          sellingPoints: library.sellingPoints.map((point) => {
            const edit = savedSelection.edits.find((item) => item.sellingPointId === point.id);
            return edit ? { ...point, detailText: edit.detailText ?? point.detailText, detailStatus: typeof edit.detailText === 'string' ? 'verified' : point.detailStatus } : point;
          }) };
        body = { revision: library };
      } else body = { current: library };
    }
    else if (pathname === '/api/providers/script') body = [{ id: 'fixture-provider', name: '测试模型', model: 'fixture', configured: true, supportsVision: true, executionScope: 'external' }];
    else if (pathname === '/api/providers') body = { providers: [] };
    await route.fulfill({ status: pathname.endsWith('/script-studio/tasks') && method === 'POST' ? 202 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  // ---------------- 1. 设置页：导入预览 → 确认保存 ----------------
  await page.goto(`${baseUrl}/settings`);
  await page.getByRole('button', { name: '脚本知识', exact: false }).first().click().catch(() => {});
  await expect(page.getByText('爆文模板库', { exact: true })).toBeVisible({ timeout: 8000 });
  const xlsxPath = path.join(root, 'fixture.xlsx');
  fs.writeFileSync(xlsxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));
  await page.locator('input[type="file"][accept=".xlsx"]').last().setInputFiles(xlsxPath);
  await expect(page.getByText('导入预览（确认后才保存）')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('去重后模板：').first()).toBeVisible();
  await expect(page.getByText('380', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('占位不可用：').first()).toBeVisible();
  await page.getByRole('button', { name: '确认保存为模板库版本', exact: true }).click();
  await expect(page.getByText(/导入完成，已保存为新版本（可用 376/)).toBeVisible({ timeout: 8000 });
  assert.equal(importConfirmed, true, '确认后才真正落库');
  await expect(page.getByText(/380 个模板（可用 376 · 占位 3 · 待检查 1）/)).toBeVisible();

  // ---------------- 2. 项目页：第 1 步直达第 2 步 → 推荐勾选+条数 → 提交数量语义 ----------------
  await page.goto(`${baseUrl}/projects/p1?tab=script`);
  await page.getByLabel('生产模式', { exact: true }).selectOption('template_rewrite');
  await expect(page.getByText('先提取卖点建库，再在第 2 步挑选爆文模板，按参考文风改写成一条本家脚本。')).toBeVisible();
  await expect(page.getByText(/写作估算 ≈ 90 中文字\/条/)).toBeVisible(); // 默认 15 秒
  await expect(page.getByText('第 2 步挑选爆文模板时决定')).toBeVisible();
  // 第 1 步不再内嵌勾选区
  await expect(page.getByRole('checkbox', { name: '选择模板：小户型餐桌爆款' })).toHaveCount(0);
  // 已有卖点库：第 1 步直达第 2 步挑选模板
  await page.getByRole('button', { name: '下一步：挑选爆文模板', exact: true }).click();
  await expect(page.getByText('推荐模板（按卖点库本地匹配，原因如实展示）')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('命中卖点关键词：伸缩、桌面').first()).toBeVisible();
  // 参考全文预览
  await page.getByRole('button', { name: '查看参考全文' }).first().click();
  await expect(page.getByText(/这是小户型餐桌爆款的参考文案/).first()).toBeVisible();
  // 勾选 2 个模板
  await page.getByRole('checkbox', { name: '选择模板：小户型餐桌爆款' }).check();
  await page.getByRole('checkbox', { name: '选择模板：岩板餐桌测评' }).check();
  await expect(page.getByText(/已选 2 个模板 · 共 2 \/ 6 条/)).toBeVisible();
  // 同一模板可加条数生成变体：「小户型餐桌爆款」调到 2 条
  await page.getByRole('button', { name: '增加「小户型餐桌爆款」条数' }).click();
  await expect(page.getByText(/已选 2 个模板 · 共 3 \/ 6 条/)).toBeVisible();
  // 搜索入口
  await page.getByPlaceholder('搜索模板名称 / 标题 / 参考文案 / 类目').fill('实木床');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('搜索结果（1）')).toBeVisible();
  await expect(page.getByText('实木床爆款').first()).toBeVisible();
  await page.getByText('返回推荐').click();
  // 提交：templateEntryIds 按条数展开（同一模板重复）且 requestedCount 等于总条数
  await page.getByRole('button', { name: '按 2 个模板生成脚本（共 3 条）', exact: true }).click();
  await expect.poll(() => submitted?.productionMode).toBe('template_rewrite');
  assert.deepEqual(submitted.templateEntryIds, ['e1', 'e1', 'e2'], '同一模板按所选条数重复展开提交');
  assert.equal(submitted.requestedCount, 3, '生成数量等于全部模板条数之和');
  assert.equal(submitted.targetDurationSec, 15);
  const firstRequestKey = submitted.requestKey;
  assert.match(firstRequestKey, /^regenerate-group:/);

  // ---------------- 3. 结果对照与诚实展示 ----------------
  await expect(page.getByText('爆文模板：小户型餐桌爆款').first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('文风：💬 闺蜜安利（快消/食品/日百）').first()).toBeVisible();
  await expect(page.getByText('结构：默认（表格未提供）').first()).toBeVisible();
  await expect(page.getByText('写作目标 ≈120 中文字').first()).toBeVisible();
  await expect(page.getByText('修改说明（模型自述，非证据审核）').first()).toBeVisible();
  await expect(page.getByText('把参考里的产品换成本家餐桌，痛点精简为 1 个')).toBeVisible();
  // 第二条说明缺失如实展示
  await expect(page.getByText('未生成修改说明。')).toBeVisible();
  // 原文对照（文字差异渲染，非原创率）
  await page.getByRole('button', { name: '对比参考文案（文字差异）' }).first().click();
  await expect(page.getByText('这只是文字差异对照，不是原创率或合规证明。')).toBeVisible();
  await expect(page.getByText('参考文案', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('生成文案', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: '再生成模式', exact: true })).toHaveValue('template_rewrite');

  // ---------------- 4. 详解编辑 ----------------
  const expand = page.getByRole('button', { name: '展开卖点', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '选择 / 排除卖点', exact: true }).click();
  await expect(page.getByText('详解可用').first()).toBeVisible();
  await expect(page.getByText('无详解（爆文模板改写模式不可用，可编辑补充）').first()).toBeVisible();
  await page.getByRole('button', { name: '编辑详解', exact: true }).nth(1).click();
  await page.locator('textarea').last().fill('台面为岩板，热锅直接上桌不怕烫');
  await page.getByRole('button', { name: '应用（待保存）', exact: true }).click();
  await expect(page.getByText('详解已修改，保存后重新校验')).toBeVisible();
  await page.getByRole('button', { name: '保存选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 / 排除卖点', exact: true })).toBeVisible();
  const detailEdit = savedSelection.edits.find((edit) => edit.sellingPointId === 'point-2');
  assert.equal(detailEdit.detailText, '台面为岩板，热锅直接上桌不怕烫', '详解编辑随选择一起提交');

  // 结果页再次生成仍能挑模板，数量由模板份数决定，复用最新卖点修订。
  await expect(page.getByRole('combobox', { name: '再生成模式', exact: true })).toHaveValue('template_rewrite');
  await page.getByRole('combobox', { name: '再生成时长', exact: true }).selectOption('30');
  await page.getByRole('button', { name: '挑选模板再生成', exact: true }).click();
  await expect(page.getByRole('heading', { name: '挑选爆文模板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '按 2 个模板生成脚本（共 3 条）', exact: true }).click();
  await expect.poll(() => submitted?.targetDurationSec).toBe(30);
  assert.equal(submitted.libraryRevisionId, 'library-2');
  assert.deepEqual(submitted.templateEntryIds, ['e1', 'e1', 'e2']);
  assert.equal(submitted.requestedCount, 3);
  assert.notEqual(submitted.requestKey, firstRequestKey, '再次生成必须创建新任务，不能命中旧组');

  // ---------------- 5. 部分完成 / 停止 ----------------
  state = { status: 'running', succeededCount: 1, failedCount: 0 };
  await page.reload();
  await expect(page.getByText('已保存 1 / 2 条，其他方案仍在生成')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('爆文模板：小户型餐桌爆款').first()).toBeVisible();
  await page.getByRole('button', { name: '停止任务', exact: true }).first().click();
  await expect(page.getByText('任务已停止，已保存的脚本仍可使用。', { exact: true })).toBeVisible();
  await expect(page.getByText('爆文模板：小户型餐桌爆款').first()).toBeVisible();

  await page.screenshot({ path: path.resolve('outputs/script-template-rewrite-results.png'), fullPage: true });
  assert.deepEqual(pageErrors, [], '页面不应出现运行时异常');
  console.log('script-studio-template-rewrite.playwright.test.mjs: ok (import preview/confirm, recommend & pick, detail edit, compare & honest display, partial/stop)');
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) { server.kill('SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
