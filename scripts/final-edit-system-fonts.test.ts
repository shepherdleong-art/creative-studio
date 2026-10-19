import assert from 'node:assert/strict';
import { listSystemFonts } from '../lib/final-edit/system-fonts.ts';

// lib/final-edit/system-fonts.ts 的冒烟测试（技术计划 §3.1/§10.5）。
// 字体扫描读真实系统目录，结果随平台变化：只在 macOS 上断言非空与 .ttc 标记，
// 其他平台只断言返回形状合法（CI/Windows 打包机不做字体内容假设）。

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
  assert.ok(fonts.some((font) => font.format === 'ttc'), 'macOS 字体列表必须包含 .ttc 标记（如 PingFang.ttc）');
}

console.log('final-edit-system-fonts tests passed');
