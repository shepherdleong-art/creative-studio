import assert from 'node:assert/strict';
import fs from 'node:fs';
import { batchErrorResponse } from '../lib/batch-production/http-errors.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';

// 路由级契约测试:Node 无法直接加载 Next 路由模块(@/ 别名),这里分两层验证
// 「非法输入返回 400 而非 500」——
// 1. 源码契约:两个路由都在 try 内先过 assertBatchApiReady、catch 统一交
//    batchRouteErrorResponse,且形状校验的廉价 400 在任何 getDb() 之前;
// 2. 行为断言:batchErrorResponse 对 BatchDomainError 的真实状态码映射。

const collectionRoute = fs.readFileSync('app/api/batch-production/scripts/route.ts', 'utf8');
const itemRoute = fs.readFileSync('app/api/batch-production/scripts/[scriptId]/route.ts', 'utf8');

for (const [name, route] of [['collection', collectionRoute], ['item', itemRoute]] as const) {
  assert.match(route, /runtime\s*=\s*'nodejs'/, `${name} 路由必须使用 nodejs runtime`);
  assert.match(route, /dynamic\s*=\s*'force-dynamic'/, `${name} 路由必须关闭缓存`);
  assert.match(route, /assertBatchApiReady/, `${name} 路由必须先过 readiness 门禁`);
  assert.match(route, /batchRouteErrorResponse\(/, `${name} 路由的 catch 必须交统一错误映射`);
  assert.match(route, /BATCH_NO_STORE_HEADERS/, `${name} 路由全部响应必须带 no-store`);
  assert.match(route, /status:\s*400/, `${name} 路由必须有廉价 400 形状校验`);
  assert.doesNotMatch(route, /zod/, `${name} 路由不得引入 zod(本树手写 typeof 校验)`);
  // 廉价 400 必须出现在 getDb() 之前
  const first400 = route.indexOf('status: 400');
  const firstGetDb = route.indexOf('getDb()');
  assert.ok(first400 !== -1 && firstGetDb !== -1 && first400 < firstGetDb,
    `${name} 路由的廉价 400 必须在任何 getDb() 之前`);
}

// POST:整批事务、显式 404、201 返回
assert.match(collectionRoute, /project_not_found/, 'POST 必须显式区分项目不存在');
assert.match(collectionRoute, /status:\s*404/, 'POST 项目不存在必须返回 404');
assert.match(collectionRoute, /status:\s*201/, 'POST 成功必须返回 201');
assert.match(collectionRoute, /db\.transaction\(/, 'POST 整批必须包在一个事务里(全成功或全失败)');
assert.match(collectionRoute, /normalizeManualScriptBatch/, 'POST 服务端必须独立校验批量上限,不能只信前端');
assert.match(collectionRoute, /createManualProjectScript/, 'POST 必须走领域层创建函数');

// PUT / DELETE:projectId 走 query string,限定 manual: 脚本由领域层保证
assert.match(itemRoute, /missing_project_id/, 'PUT/DELETE 缺 projectId 必须返回 400');
assert.match(itemRoute, /searchParams\.get\('projectId'\)/, 'projectId 必须走 query string');
assert.match(itemRoute, /updateManualProjectScript/, 'PUT 必须走手动脚本专用更新(不得复用 updateProjectScript)');
assert.match(itemRoute, /deleteManualProjectScript/, 'DELETE 必须走手动脚本专用删除');

// 行为断言:错误码 → HTTP 状态码映射,非法输入必须是 400 而不是被脱敏的 500
const invalidInput = batchErrorResponse(
  new BatchDomainError('invalid_input', '脚本正文必须包含有效文字内容'),
  { error: 'manual_script_create_failed', message: '自定义脚本导入失败' },
);
assert.equal(invalidInput.status, 400, 'invalid_input 必须映射 400 而非 500');
assert.equal(invalidInput.body.code, 'invalid_input');
assert.equal(invalidInput.body.message, '脚本正文必须包含有效文字内容', '领域文案必须透传给前端');

const notFound = batchErrorResponse(
  new BatchDomainError('not_found', '手动脚本不存在'),
  { error: 'manual_script_update_failed', message: '手动脚本保存失败' },
);
assert.equal(notFound.status, 404, 'not_found 必须映射 404');

const conflict = batchErrorResponse(
  new BatchDomainError('conflict', '该脚本已被删除'),
  { error: 'manual_script_update_failed', message: '手动脚本保存失败' },
);
assert.equal(conflict.status, 409, '软删后更新必须映射 409');

const unexpected = batchErrorResponse(
  new Error('sqlite 内部细节 / 绝对路径'),
  { error: 'manual_script_create_failed', message: '自定义脚本导入失败' },
);
assert.equal(unexpected.status, 500, '裸 Error 兜底为 500');
assert.equal(unexpected.body.message, '自定义脚本导入失败', '500 不得回传内部错误细节');

console.log('batch manual script route contract tests passed');
