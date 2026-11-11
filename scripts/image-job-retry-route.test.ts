// node scripts/image-job-retry-route.test.ts
// 图片任务「重试」路由契约：远端终态失败必须能重新提交，其余带 providerTaskId 的情况只补抓。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
// 路由用 @/ 别名、无扩展名相对导入和 'next/server'（该包没有 exports 映射），
// Node 原生 TS/ESM 不解析，先注册解析钩子；与 scripts/team-atomic-create.test.ts 同一套做法。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-image-retry-'));
const previousEnv = { ...process.env };

// lib/data-root.ts 在模块加载时就固化数据根，必须先设环境变量再 import。
// 不设置 CREATIVE_STUDIO_DEPLOYMENT_MODE 即 local 模式，withTeamRoute 会直接透传 handler。
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { getDb, closeDb } = await import('../lib/db.ts');
// 默认测当前工作区实现；RETRY_ROUTE_HEAD=1 时改测 HEAD 旧实现副本，
// 用于给「这条测试能红」留可复现证据（见 outputs/debug-shot-regenerate/）。
// 红基线副本生成：git show 'HEAD:app/api/jobs/[id]/retry/route.ts' > outputs/debug-shot-regenerate/retry-route-head.ts
// 红：$env:RETRY_ROUTE_HEAD='1'; node scripts/image-job-retry-route.test.ts
const retryRouteSpecifier = process.env.RETRY_ROUTE_HEAD === '1'
  ? '../outputs/debug-shot-regenerate/retry-route-head.ts'
  : '../app/api/jobs/[id]/retry/route.ts';
const { POST } = await import(retryRouteSpecifier);

console.log(process.env.RETRY_ROUTE_HEAD === '1'
  ? '被测实现：HEAD 旧版 route（对照基线，预期红）'
  : '被测实现：当前工作区 route（预期绿）');

const db = getDb();

db.prepare(`INSERT INTO providers (id, name, baseUrl, model)
  VALUES ('provider-retry', '重试测试供应商', 'http://127.0.0.1:9', 'gpt-image-2')`).run();
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
  VALUES ('project-retry', '重试测试项目', 'provider-retry', 'gpt-image-2', '生成一张测试图')`).run();
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path)
  VALUES ('image-retry-input', 'project-retry', 'input', 'input.png', 'originals/inputs/input.png')`).run();

interface JobSeed {
  id: string;
  status: string;
  providerTaskId: string | null;
  providerStatus?: string | null;
  errorMessage?: string | null;
  remoteImageUrl?: string | null;
  providerRawResponse?: string | null;
  submittedAt?: string | null;
}

function seedJob(seed: JobSeed): void {
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, providerId, model, prompt, status, attempt,
      providerTaskId, providerStatus, errorMessage, remoteImageUrl, providerRawResponse, submittedAt
    ) VALUES (?, 'project-retry', 'image-retry-input', 'provider-retry', 'gpt-image-2', '生成一张测试图', ?, 2,
      ?, ?, ?, ?, ?, ?)`).run(
    seed.id,
    seed.status,
    seed.providerTaskId,
    seed.providerStatus ?? null,
    seed.errorMessage ?? null,
    seed.remoteImageUrl ?? null,
    seed.providerRawResponse ?? null,
    seed.submittedAt ?? null,
  );
}

interface JobRow {
  status: string;
  providerStatus: string | null;
  providerTaskId: string | null;
  providerRawResponse: string | null;
  submittedAt: string | null;
  errorMessage: string | null;
  remoteImageUrl: string | null;
  attempt: number;
}

function readJob(id: string): JobRow {
  return db.prepare(`SELECT status, providerStatus, providerTaskId, providerRawResponse,
      submittedAt, errorMessage, remoteImageUrl, attempt FROM jobs WHERE id = ?`).get(id) as JobRow;
}

async function retryJob(id: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const request = new Request(`http://127.0.0.1/api/jobs/${id}/retry`, { method: 'POST' });
  const response = await POST(request, { params: Promise.resolve({ id }) });
  return { response, body: await response.json() as Record<string, unknown> };
}

try {
  // ── 场景 1：远端确认终态失败（failed/failed，仍保留 providerTaskId）──
  // failRemoteImageTask（lib/queue.ts）会写 status='failed', providerStatus='failed' 并保留
  // providerTaskId。此时远端结果已确定不会产出，必须清空远端身份并回到 pending 重新提交。
  console.log('场景 1：远端终态失败（status=failed + providerStatus=failed + providerTaskId）应回到 pending');
  seedJob({
    id: 'job-remote-terminal-failed',
    status: 'failed',
    providerTaskId: 'remote-terminal-failed-1',
    providerStatus: 'failed',
    errorMessage: '远端任务失败：内容审核未通过',
    providerRawResponse: '{"id":"remote-terminal-failed-1","status":"failed"}',
    submittedAt: '2026-11-10T10:00:00.000Z',
  });
  {
    const { response, body } = await retryJob('job-remote-terminal-failed');
    assert.equal(response.status, 200, `应返回 200，实际 ${response.status}`);
    const row = readJob('job-remote-terminal-failed');
    assert.equal(
      row.status,
      'pending',
      `远端终态失败后必须回到 pending 重新提交（实际 status=${row.status}，providerTaskId=${String(row.providerTaskId)}）`,
    );
    assert.equal(row.providerTaskId, null, '重新提交前必须清空 providerTaskId');
    assert.equal(row.providerRawResponse, null, '终态失败的上游原始响应必须清空');
    assert.equal(row.submittedAt, null, '重新提交前必须清空 submittedAt');
    assert.equal(row.errorMessage, null, '回到 pending 时必须清空旧的错误信息');
    assert.equal(body.success, true, '应返回 success:true');
    assert.notEqual(body.status, 'needs_check', '远端终态失败不得再转 needs_check，否则重试永远无法重新提交');
    assert.notEqual(body.resumeRequired, true, '远端终态失败不得要求先补抓结果');
    console.log('场景 1 通过：远端终态失败 → pending，providerTaskId/providerRawResponse/submittedAt/errorMessage 已清空');
  }

  // ── 场景 2：结果下载失败（结果已生成，只差下载）──
  // providerStatus='download_failed' + remoteImageUrl 说明远端结果可补抓；重新提交会重复扣费。
  console.log('场景 2：结果下载失败（download_failed + remoteImageUrl）应保持 needs_check 且保留 providerTaskId');
  seedJob({
    id: 'job-download-failed',
    status: 'failed',
    providerTaskId: 'remote-download-failed-2',
    providerStatus: 'download_failed',
    errorMessage: '图片下载失败（HTTP 502）',
    remoteImageUrl: 'https://gateway.example.test/results/remote-download-failed-2.png',
  });
  {
    const { response, body } = await retryJob('job-download-failed');
    assert.equal(response.status, 200, `应返回 200，实际 ${response.status}`);
    assert.equal(body.success, true, '应返回 success:true');
    assert.equal(body.status, 'needs_check', '结果已生成、只差下载时必须转 needs_check 补抓');
    assert.equal(body.resumeRequired, true, '下载失败必须提示先补抓结果');

    const row = readJob('job-download-failed');
    assert.equal(row.status, 'needs_check', '下载失败必须保持 needs_check');
    assert.equal(row.providerTaskId, 'remote-download-failed-2', '下载失败必须保留 providerTaskId，避免重复提交扣费');
    assert.equal(row.remoteImageUrl, 'https://gateway.example.test/results/remote-download-failed-2.png', '下载失败必须保留 remoteImageUrl');
    console.log('场景 2 通过：下载失败保持 needs_check，providerTaskId 与 remoteImageUrl 未被清空');
  }

  // ── 场景 3：从未提交成功（providerTaskId 为空）──
  // 原有行为：直接回到 pending 重试。
  console.log('场景 3：提交前失败（providerTaskId 为空）应回到 pending');
  seedJob({
    id: 'job-never-submitted',
    status: 'failed',
    providerTaskId: null,
    providerStatus: null,
    errorMessage: '提交前网络错误',
  });
  {
    const { response, body } = await retryJob('job-never-submitted');
    assert.equal(response.status, 200, `应返回 200，实际 ${response.status}`);
    assert.equal(body.success, true, '应返回 success:true');
    assert.notEqual(body.status, 'needs_check', '没有远端任务时不得转 needs_check');

    const row = readJob('job-never-submitted');
    assert.equal(row.status, 'pending', '提交前失败应回到 pending');
    assert.equal(row.providerTaskId, null, '提交前失败不应有 providerTaskId');
    assert.equal(row.errorMessage, null, '回到 pending 时必须清空旧的错误信息');
    console.log('场景 3 通过：提交前失败 → pending');
  }

  // ── 场景 4：任务仍在执行/成功状态不允许重试 ──
  console.log('场景 4：非 failed/canceled 状态应返回 400');
  seedJob({ id: 'job-still-running', status: 'running', providerTaskId: null });
  {
    const { response, body } = await retryJob('job-still-running');
    assert.equal(response.status, 400, `运行中的任务重试应返回 400，实际 ${response.status}`);
    assert.equal(typeof body.error, 'string', '400 响应应带 error 说明');
    assert.equal(readJob('job-still-running').status, 'running', '400 时不得改写任务状态');
    console.log('场景 4 通过：运行中任务 → 400，任务行未被改写');
  }

  // ── 场景 5：其它带 providerTaskId 的情况仍只补抓 ──
  // 远端可能仍在执行（或状态未知）时，重新提交会造成第二个付费任务；必须保持原行为的 needs_check。
  console.log('场景 5：其它带 providerTaskId 的情况（providerStatus=processing）应保持 needs_check');
  seedJob({
    id: 'job-remote-processing',
    status: 'failed',
    providerTaskId: 'remote-processing-5',
    providerStatus: 'processing',
    errorMessage: '轮询中断，远端状态未知',
  });
  {
    const { response, body } = await retryJob('job-remote-processing');
    assert.equal(response.status, 200, `应返回 200，实际 ${response.status}`);
    assert.equal(body.status, 'needs_check', '远端可能仍在执行时必须转 needs_check 补抓');
    assert.equal(body.resumeRequired, true, '远端可能仍在执行时必须提示先补抓结果');
    assert.equal(readJob('job-remote-processing').providerTaskId, 'remote-processing-5', '不得清空远端可能仍在执行的任务身份');
    console.log('场景 5 通过：远端可能仍在执行 → needs_check，providerTaskId 保留');
  }

  // ── 场景 6：统一任务的人工重试必须开启新的 generation turn ──
  seedJob({
    id: 'job-unified-retry',
    status: 'failed',
    providerTaskId: null,
    providerStatus: 'failed',
    errorMessage: '两条统一通道都明确失败',
  });
  db.prepare(`UPDATE jobs SET unifiedModel = 'image2', unifiedRuleVersion = 'unified-media-2026-11-10-v1',
    unifiedTaskId = 'old-parent', unifiedGenerationId = 'old-generation',
    cancelRequestedAt = '2026-11-10T10:00:00.000Z' WHERE id = 'job-unified-retry'`).run();
  {
    const { response } = await retryJob('job-unified-retry');
    assert.equal(response.status, 200);
    assert.deepEqual(
      db.prepare(`SELECT unifiedTaskId, unifiedGenerationId, cancelRequestedAt
        FROM jobs WHERE id = 'job-unified-retry'`).get(),
      { unifiedTaskId: null, unifiedGenerationId: null, cancelRequestedAt: null },
      'manual retry must not reuse the exhausted parent or cancellation intent',
    );
  }

  console.log('image retry route ok');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
