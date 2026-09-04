import assert from 'node:assert/strict';
import { listSystemFonts } from '../lib/final-edit/system-fonts.ts';

// lib/final-edit/system-fonts.ts 的冒烟测试（技术计划 §1 问题一修复）。
// 该模块现在是 media-core 的兼容再导出；完整断言见 scripts/media-core-system-fonts.test.ts。
// 字体扫描读真实系统目录，结果随平台变化：只在 macOS 上断言非空，其他平台只断言返回形状合法。

const fonts = listSystemFonts();
assert.ok(Array.isArray(fonts));
for (const font of fonts) {
  assert.ok(font.family && typeof font.family === 'string');
  assert.ok(['ttf', 'otf', 'ttc'].includes(font.format), `未知字体格式：${font.format}`);
}
const families = fonts.map((font) => font.family);
assert.deepEqual(families, [...families].sort((a, b) => a.localeCompare(b)), '字体列表必须按 family 排序');
assert.equal(new Set(families).size, families.length, 'family 必须去重');

if (process.platform === 'darwin') {
  assert.ok(fonts.length > 0, 'macOS 系统字体目录不应为空');
}

console.log('final-edit-system-fonts tests passed');
