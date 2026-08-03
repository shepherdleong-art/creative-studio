import assert from 'node:assert/strict';
import fs from 'node:fs';

const batchesRoute = fs.readFileSync('app/api/batch-production/batches/route.ts', 'utf8');
const batchRoute = fs.readFileSync('app/api/batch-production/batches/[id]/route.ts', 'utf8');
const snapshotRoutePath = 'app/api/batch-production/batches/[id]/snapshot/route.ts';
const startRoutePath = 'app/api/batch-production/batches/[id]/start/route.ts';
assert.ok(fs.existsSync(snapshotRoutePath), '必须实现文档约定的 /batches/[id]/snapshot 子路由');
assert.ok(fs.existsSync(startRoutePath), '必须实现文档约定的 /batches/[id]/start 子路由');
const snapshotRoute = fs.readFileSync(snapshotRoutePath, 'utf8');
const startRoute = fs.readFileSync(startRoutePath, 'utf8');
const responseHelper = fs.readFileSync('app/api/batch-production/batches/response.ts', 'utf8');
const httpErrors = fs.readFileSync('lib/batch-production/http-errors.ts', 'utf8');

// 创建与列表
assert.match(batchesRoute, /createBatchProduction/);
assert.match(batchesRoute, /listProjectBatchProductions/);
assert.match(batchesRoute, /projectId 与 name 不能为空/);
assert.match(batchesRoute, /status:\s*400/);
assert.match(batchesRoute, /项目不存在/);
assert.match(batchesRoute, /status:\s*404/);
assert.match(batchesRoute, /status:\s*201/);

// 详情、快照与开跑使用无歧义的独立路由
assert.match(batchRoute, /getBatchSnapshotDetail/);
assert.match(batchRoute, /batch_detail_failed/);
assert.doesNotMatch(batchRoute, /export async function (POST|PUT)/, '详情路由不得保留未发布的歧义 POST/PUT');
assert.match(snapshotRoute, /export async function POST/);
assert.match(snapshotRoute, /createBatchSnapshot/);
assert.match(snapshotRoute, /scriptSelections 不能为空/);
assert.match(snapshotRoute, /assetSelections 不能为空/);
assert.match(snapshotRoute, /batch_snapshot_failed/);
assert.match(startRoute, /export async function PUT/);
assert.match(startRoute, /startBatchProduction/);
assert.match(startRoute, /ensureBatchSchedulerStarted/);
assert.match(startRoute, /ensureBatchSchedulerStarted\(\)/, '开跑建立任务后必须唤醒进程内调度器');
assert.match(startRoute, /batch_start_failed/);

// 应用进程启动时也必须经过 readiness 门禁恢复调度,不能依赖用户再点控制/重试。
const instrumentationPath = 'instrumentation.ts';
assert.ok(fs.existsSync(instrumentationPath), '必须提供 Next.js Node 运行时启动恢复入口');
const instrumentation = fs.readFileSync(instrumentationPath, 'utf8');
assert.match(instrumentation, /startBatchSchedulerAfterReadiness/);
assert.match(instrumentation, /NEXT_RUNTIME/);

// readiness 门禁:每个 handler 在读写 batch_* 数据前必须通过统一 guard,失败返回 503
for (const route of [batchesRoute, batchRoute, snapshotRoute, startRoute]) {
  assert.match(route, /assertBatchApiReady/);
  assert.match(route, /await assertBatchApiReady\(\)/);
  assert.match(route, /batchRouteErrorResponse/);
}
assert.match(responseHelper, /batchErrorResponse/);
assert.match(httpErrors, /BatchApiUnavailableError/);
assert.match(httpErrors, /batch_api_unavailable/);
assert.match(httpErrors, /status:\s*503/);

// 公共约定
for (const route of [batchesRoute, batchRoute, snapshotRoute, startRoute]) {
  assert.match(route, /BATCH_NO_STORE_HEADERS/);
  assert.match(route, /runtime\s*=\s*'nodejs'/);
  assert.match(route, /force-dynamic/);
}
assert.match(responseHelper, /Cache-Control/);
assert.match(responseHelper, /no-store/);

// HTTP 状态必须按具名领域错误码映射，不能比较中文 message。
for (const route of [batchesRoute, batchRoute, snapshotRoute, startRoute]) {
  assert.match(route, /batchRouteErrorResponse/);
  assert.doesNotMatch(route, /message\s*===/);
}
for (const code of ['not_found', 'invalid_input', 'conflict']) {
  assert.match(httpErrors, new RegExp(`error\.code === '${code}'|${code}`));
}

console.log('batch production batches route contract tests passed');
