/** npm run build && node scripts/script-studio-progress.playwright.test.mjs
 * 真实生产前端 + 受控 API 夹具：运行中逐条展示、继续轮询、取消保留、真实错误提示。
 * 临时数据根、调度器关闭；不读取用户项目，不调用真实模型。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-progress-'));
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  let state = { status: 'running', succeededCount: 0, failedCount: 0 };
  let painMode = false;
  let submitted;
  const painOpportunity = { version: 'pain-solving-v1', path: 'direct', audience: '靠坐看剧的人', scenario: '晚上看剧', problem: '头颈缺少承托',
    main: { label: '高靠背承托', factIds: ['point-1'] }, support: null, proposition: '靠坐看剧时高靠背承托头颈', matchReason: '高靠背事实对应承托需求' };
  let polls = 0;
  let distillRequests = 0;
  let savedSelection;
  let library = { id: 'library-1', revisionNumber: 1, productName: '测试沙发', sellingPoints: [
    { id: 'point-1', title: '高靠背', factText: '高靠背托住头颈', usable: 1, disabledByUser: 0, evidenceGate: 'passed' },
    { id: 'point-2', title: '柔软扶手', factText: '扶手包覆面料', usable: 1, disabledByUser: 0, evidenceGate: 'passed' },
    { id: 'point-3', title: '未核验参数', factText: '未核验的内容', usable: 0, disabledByUser: 0, evidenceGate: 'failed' },
  ] };
  const snapshot = () => ({
    id: 'task-fixture', projectId: 'p1', requestedCount: 3, mode: 'reuse',
    ...state, currentStage: 'generate', inputSnapshot: { targetDurationSec: 15, requestedCount: 3, providerModel: 'fixture', ...(painMode ? { productionMode: 'pain_solving_15s' } : {}) },
    startedAt, updatedAt: startedAt, createdAt: startedAt,
    stages: [...(painMode ? [{ stage: 'plan', status: 'succeeded', payload: { opportunityCount: 1, shortageCount: 2, painPlanning: { shortageReason: '只有一个有依据的内容机会' } } }] : []), { stage: 'generate', status: state.status === 'running' ? 'running' : 'succeeded',
      startedAt, finishedAt: state.status === 'running' ? null : new Date().toISOString(),
      payload: { generated: state.succeededCount, requested: 3, errors: state.status === 'partial' ? ['Gemini 返回了无效 JSON。'] : [] } }],
  });
  const script = (index) => ({
    id: `script-${index}`, projectId: 'p1', generationTaskId: 'task-fixture', currentRevisionId: `revision-${index}`,
    createdAt: startedAt, updatedAt: startedAt,
    currentRevision: {
      id: `revision-${index}`, revisionNumber: 1, origin: 'ai_generate', createdAt: startedAt,
      contentJson: JSON.stringify({ ...(painMode ? { productionMode: 'pain_solving_15s', painSolving: painOpportunity } : {}), title: `已完成的脚本${index}`, fullScript: '沙发托住疲惫的身体，想了解这款就看看这些细节。',
        fullSubtitle: '', segments: [], sellingPointUsage: [], targetDurationSec: 15, contentCharacterCount: 28,
        estimatedNarrationDurationSec: 8, durationStatus: 'too_short', template: '场景种草' }),
      validationJson: '{}', targetDurationSec: 15,
    },
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname === '/api/projects/p1') body = {
      id: 'p1', name: '脚本进度测试', images: [], jobs: [], provider: null, model: 'fixture',
      status: 'draft', concurrency: 2, maxAttempts: 1, prompt: '',
    };
    else if (pathname.endsWith('/script-studio/tasks/task-fixture/cancel')) {
      state = { ...state, status: 'cancelled' }; body = { task: snapshot() };
    } else if (pathname.endsWith('/script-studio/tasks/task-fixture')) {
      polls++; body = { task: snapshot() };
    } else if (pathname.endsWith('/script-studio/tasks')) {
      if (route.request().method() === 'POST') {
        submitted = route.request().postDataJSON();
        body = { task: snapshot(), schedulerEnabled: false };
      } else body = { tasks: [snapshot()] };
    }
    else if (pathname.endsWith('/script-studio/scripts')) body = { scripts: Array.from({ length: state.succeededCount }, (_, i) => script(i + 1)) };
    else if (pathname.endsWith('/script-studio/library')) {
      if (route.request().method() === 'POST') {
        savedSelection = route.request().postDataJSON();
        assert.equal(savedSelection.baseRevisionId, library.id);
        library = { ...library, id: `library-${library.revisionNumber + 1}`, revisionNumber: library.revisionNumber + 1,
          sellingPoints: library.sellingPoints.map((point) => {
            const edit = savedSelection.edits.find((edit) => edit.sellingPointId === point.id);
            return edit ? { ...point, usable: Number(edit.usable), disabledByUser: Number(edit.disabledByUser) } : point;
          }) };
        body = { revision: library };
      } else body = { current: library };
    } else if (pathname.endsWith('/script-studio/distilled-points')) { distillRequests++; body = { points: [] }; }
    else if (pathname === '/api/providers/script') body = [{ id: 'fixture-provider', name: '测试模型', model: 'fixture', configured: true, supportsVision: true, executionScope: 'external' }];
    else if (pathname === '/api/providers') body = { providers: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${baseUrl}/projects/p1?tab=script`);
  await expect(page.getByText('正在撰写脚本方案', { exact: true })).toBeVisible();
  state = { ...state, succeededCount: 1 };
  await expect(page.getByText('已保存 1 / 3 条，其他方案仍在生成')).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('heading', { name: /已完成的脚本1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '再生成一组', exact: true })).toBeDisabled();
  const firstPolls = polls;
  state = { ...state, succeededCount: 2 };
  await expect(page.getByText('已保存 2 / 3 条，其他方案仍在生成')).toBeVisible();
  await expect(page.getByRole('heading', { name: /已完成的脚本2/ })).toBeVisible();
  assert.ok(polls > firstPolls, '显示结果后必须继续轮询');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByText('任务已停止，已保存的脚本仍可使用。', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /已完成的脚本1/ })).toBeVisible();
  state = { status: 'partial', succeededCount: 2, failedCount: 1 };
  await page.reload();
  await expect(page.getByText('Gemini 返回了无效 JSON。', { exact: true })).toBeVisible();
  await expect(page.getByText('差异检查', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认可用', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '选择 / 排除卖点', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '保留卖点：高靠背', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '保留卖点：未核验参数', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: '保留卖点：高靠背', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 / 排除卖点', exact: true })).toBeVisible();
  assert.equal(savedSelection.edits.find((edit) => edit.sellingPointId === 'point-1').disabledByUser, true);
  await page.reload();
  await page.getByRole('button', { name: '选择 / 排除卖点', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '保留卖点：高靠背', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '保留卖点：高靠背', exact: true }).check();
  await page.getByRole('button', { name: '保存选择', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 / 排除卖点', exact: true })).toBeVisible();
  assert.equal(savedSelection.edits.find((edit) => edit.sellingPointId === 'point-1').disabledByUser, false);
  assert.equal(distillRequests, 0, '默认页面不再请求第二份提炼列表');
  painMode = true;
  state = { status: 'succeeded', succeededCount: 1, failedCount: 0 };
  await page.reload();
  await expect(page.getByText('目标 3 条，找到 1 个内容机会，已保存 1 条。')).toBeVisible();
  await expect(page.getByText(/这部分不计为生成失败/)).toBeVisible();
  await expect(page.getByRole('button', { name: '补跑缺失条目', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('再生成模式')).toHaveValue('pain_solving_15s');
  await expect(page.getByLabel('再生成时长')).toBeDisabled();
  await page.getByText('查看内容策划依据 · 直接解决').click();
  await expect(page.getByText('核心问题：头颈缺少承托')).toBeVisible();
  await expect(page.getByRole('button', { name: '换一个框架/钩子', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '再生成一组', exact: true }).click();
  await expect.poll(() => submitted?.productionMode).toBe('pain_solving_15s');
  assert.equal(submitted.targetDurationSec, 15);
  assert.match(submitted.requestKey, /^regenerate-group:/);
  await page.reload();
  await page.getByRole('button', { name: '返回第 1 页', exact: true }).click();
  await page.getByLabel('生产模式', { exact: true }).selectOption('pain_solving_15s');
  await expect(page.getByText('先筛选有依据的内容机会，再生成脚本；机会不足时少产，不凑数量。')).toBeVisible();
  await page.screenshot({ path: path.resolve('outputs/script-pain-mode-form.png'), fullPage: true });
  submitted = undefined;
  await page.getByRole('button', { name: '分析并生成脚本', exact: true }).click();
  await expect.poll(() => submitted?.productionMode).toBe('pain_solving_15s');
  assert.equal(submitted.targetDurationSec, 15);
  await page.reload();
  await page.getByText('查看内容策划依据 · 直接解决').click();
  await page.screenshot({ path: path.resolve('outputs/script-pain-mode-results.png'), fullPage: true });
  assert.deepEqual(pageErrors, [], '页面不应出现运行时异常');
  console.log('script-studio-progress.playwright.test.mjs: ok (early results, continued polling, cancellation, actual error, pain mode submit/regeneration/shortage/details)');
} finally {
  await browser?.close();
  const exited = new Promise((resolve) => server.once('exit', resolve));
  if (server.exitCode === null) { server.kill('SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}
