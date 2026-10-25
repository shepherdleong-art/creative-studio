import assert from 'node:assert/strict';
import fs from 'node:fs';

// 旧脚本面板（ScriptPanel 一套）已于 2026-10-25 删除，这里只保留对仍在使用的 creative-package 导出接口的检查。
const creativePackage = fs.readFileSync(new URL('../app/api/projects/[id]/creative-package/route.ts', import.meta.url), 'utf8');

assert.match(creativePackage, /manifestScript/);
assert.match(creativePackage, /fullSubtitle/);
assert.match(creativePackage, /if \(isV3\)/);

console.log('script v3 UI contract tests passed');
