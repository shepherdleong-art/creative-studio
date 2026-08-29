import assert from 'node:assert/strict';
import fs from 'node:fs';

const tasksRoute = fs.readFileSync('app/api/batch-production/batches/[id]/tasks/route.ts', 'utf8');
const controlRoute = fs.readFileSync('app/api/batch-production/batches/[id]/control/route.ts', 'utf8');
const retryRoute = fs.readFileSync('app/api/batch-production/tasks/[taskId]/retry/route.ts', 'utf8');

// 任务视图
assert.match(tasksRoute, /getBatchTasksView/);
assert.match(tasksRoute, /getBatchTasksView\(db, projectId, id\)/);
assert.match(tasksRoute, /batch_tasks_failed/);

// 错误映射:所有 handler 必须走共享 batchRouteErrorResponse(不再比较中文文案)
for (const route of [tasksRoute, controlRoute, retryRoute]) {
  assert.match(route, /batchRouteErrorResponse/);
  assert.match(route, /batchRouteErrorResponse\(error,/);
}

// 控制:暂停/继续/停止
assert.match(controlRoute, /pauseBatch/);
assert.match(controlRoute, /resumeBatch/);
assert.match(controlRoute, /stopBatch/);
assert.match(controlRoute, /action 必须是 pause、resume 或 stop/);
assert.match(controlRoute, /status:\s*400/);
assert.match(controlRoute, /batch_control_failed/);

// 重试
assert.match(retryRoute, /retryTask/);
assert.match(retryRoute, /retryTask\(db, projectId, taskId\)/);
assert.ok(retryRoute.indexOf('retryTask(db, projectId, taskId)') < retryRoute.lastIndexOf('clearBatchSubtitleOverridesForNarrationRetry'), '重试失败时不得先清理人工字幕覆盖');
assert.match(retryRoute, /task_retry_failed/);

// readiness 门禁与公共约定
for (const route of [tasksRoute, controlRoute, retryRoute]) {
  assert.match(route, /assertBatchApiReady/);
  assert.match(route, /await assertBatchApiReady\(\)/);
  assert.match(route, /BATCH_NO_STORE_HEADERS/);
  assert.match(route, /runtime\s*=\s*'nodejs'/);
  assert.match(route, /force-dynamic/);
}
const responseHelper = fs.readFileSync('app/api/batch-production/batches/response.ts', 'utf8');
assert.match(responseHelper, /Cache-Control/);
assert.match(responseHelper, /no-store/);

// 共享错误映射:503(batch_api_unavailable)由 http-errors.ts 统一提供
const httpErrors = fs.readFileSync('lib/batch-production/http-errors.ts', 'utf8');
assert.match(httpErrors, /batch_api_unavailable/);
assert.match(httpErrors, /status: 503/);
assert.match(httpErrors, /= 404/);
assert.match(httpErrors, /= 409/);
assert.match(httpErrors, /= 400/);
assert.match(httpErrors, /BatchApiUnavailableError/);
assert.match(httpErrors, /BatchDomainError/);

console.log('batch production control route contract tests passed');
