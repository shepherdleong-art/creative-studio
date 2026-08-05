import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/batch-production/prepare/route.ts', 'utf8');

assert.match(route, /prepareBatchProductionInputs/);
assert.match(route, /getBatchProductionReadiness/);
assert.match(route, /readiness\.available/);
assert.match(route, /status:\s*503/);
assert.match(route, /await prepareBatchProductionInputs\(db, projectId\)/);
assert.doesNotMatch(route, /const message = error instanceof Error/, '500 不得回传内部错误细节');
assert.match(route, /message: '批量准备区数据读取失败'/);
assert.match(route, /projectId/);
assert.match(route, /missing_project_id/);
assert.match(route, /status:\s*400/);
assert.match(route, /项目不存在/);
assert.match(route, /status:\s*404/);
assert.match(route, /Cache-Control/);
assert.match(route, /no-store/);
assert.match(route, /runtime\s*=\s*'nodejs'/);
assert.match(route, /force-dynamic/);

console.log('batch production prepare route contract tests passed');
