import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── 新任务接口 route：薄适配 + Node 常驻运行时合同 ──
const route = read('app/api/projects/[id]/script-generation/route.ts');
assert.match(route, /export const runtime = 'nodejs'/, 'script-generation route 必须声明 nodejs 运行时');
assert.match(route, /export const dynamic = 'force-dynamic'/, 'script-generation route 必须声明 force-dynamic');
assert.match(route, /export async function POST/, '必须导出 POST');
assert.match(route, /export async function GET/, '必须导出 GET');
assert.match(route, /export async function DELETE/, '必须导出 DELETE');
assert.match(route, /script-generation-route-handler/, 'route 必须把行为委托给可注入依赖的 handler');
assert.match(route, /script-generation-manager/, 'route 必须注入真实管理器');
assert.doesNotMatch(route, /request\.signal/, '任务生命周期不得再绑定到 HTTP 请求断连');

// ── handler：可注入依赖的三方法实现 ──
const handler = read('lib/script-generation-route-handler.ts');
assert.match(handler, /handleScriptGenerationPost/, 'handler 必须实现 POST');
assert.match(handler, /handleScriptGenerationGet/, 'handler 必须实现 GET');
assert.match(handler, /handleScriptGenerationDelete/, 'handler 必须实现 DELETE');
assert.match(handler, /script_generation_shutting_down/, '停机中 POST 必须返回稳定错误码');
assert.match(handler, /no-store/, 'GET 必须设置 Cache-Control: no-store');

// ── 旧 route：只保留 analyze，生成/取消一律 410 ──
const legacy = read('app/api/projects/[id]/script/route.ts');
assert.match(legacy, /410/, '旧生成/取消入口必须返回 410');
assert.match(legacy, /script_generation_endpoint_moved/, '旧入口必须使用稳定错误码');
assert.match(legacy, /action\s*(!==|===)\s*'analyze'/, '旧 route 必须保留 analyze');
assert.doesNotMatch(legacy, /handleGenerate|registerScriptGeneration|ReadableStream/, '旧 route 不得残留生成/流式实现');

// ── 旧生命周期模块与测试已删除，且全仓库无引用 ──
for (const removed of [
  'lib/script-generation-control.ts',
  'lib/script-generation-stream.ts',
  'scripts/script-generation-control.test.ts',
  'scripts/script-generation-stream.test.ts',
]) {
  assert.ok(!fs.existsSync(path.join(root, removed)), `${removed} 必须已删除`);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(rel);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) yield rel;
  }
}
for (const dir of ['app', 'components', 'lib', 'scripts']) {
  for (const file of walk(dir)) {
    if (/\.test\.(ts|tsx|mjs|js)$/.test(file)) continue; // 测试文件允许在断言中提及旧模块名
    const content = read(file);
    assert.doesNotMatch(
      content,
      /script-generation-(control|stream)/,
      `${file} 不得再引用已删除的旧生命周期模块`,
    );
  }
}

console.log('script generation route contract tests passed');
