import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSystemFonts } from '../lib/media-core/system-fonts.ts';

// lib/media-core/system-fonts.ts 的冒烟测试（技术计划 §1 问题一修复）。
// 字体扫描读真实系统目录，结果随平台变化：跨平台只断言形状/排序/去重，
// macOS 额外断言「不再出现文件名推导的无效名」，并用系统上存在的已知
// 多字型 .ttc 验证「一个 ttc 能产出多个真实 family」。

function fontDirectories(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      path.join(os.homedir(), 'Library', 'Fonts'),
    ];
  }
  if (process.platform === 'win32') return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
  return ['/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')];
}

function findFontFile(targetName: string): string | null {
  const visit = (directory: string, depth: number): string | null => {
    if (depth > 3) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = visit(full, depth + 1);
        if (found) return found;
      } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
        return full;
      }
    }
    return null;
  };
  for (const directory of fontDirectories()) {
    const found = visit(directory, 0);
    if (found) return found;
  }
  return null;
}

const fonts = listSystemFonts();
assert.ok(Array.isArray(fonts));
for (const font of fonts) {
  assert.ok(font.family && typeof font.family === 'string');
  assert.ok(font.displayName && typeof font.displayName === 'string', 'displayName 必须存在');
  assert.ok(['ttf', 'otf', 'ttc'].includes(font.format), `未知字体格式：${font.format}`);
  assert.equal(font.source, 'system', '本卡字体来源应固定为 system');
}
const families = fonts.map((font) => font.family);
assert.deepEqual(families, [...families].sort((a, b) => a.localeCompare(b)), '字体列表必须按 family 排序');
assert.equal(new Set(families).size, families.length, 'family 必须去重');

// 中文系统字体应携带中文 displayName（如「等线」「微软雅黑」）。
if (process.platform === 'win32') {
  const dengxian = fonts.find((font) => font.family === 'DengXian');
  if (dengxian) assert.equal(dengxian.displayName, '等线', 'DengXian 的 displayName 应为「等线」');
  const yahei = fonts.find((font) => font.family === 'Microsoft YaHei');
  if (yahei) assert.equal(yahei.displayName, '微软雅黑', 'Microsoft YaHei 的 displayName 应为「微软雅黑」');
}

// .ttc 一个文件应产出多于一个真实 family（用系统上存在的已知多字型 ttc 验证，存在才断言）。
const knownMultiFamilyTtc: Array<{ file: string; families: string[] }> = [
  { file: 'cambria.ttc', families: ['Cambria', 'Cambria Math'] },
  { file: 'simsun.ttc', families: ['SimSun', 'NSimSun'] },
  { file: 'msyh.ttc', families: ['Microsoft YaHei', 'Microsoft YaHei UI'] },
  { file: 'Songti.ttc', families: ['Songti SC', 'Songti TC'] },
];
for (const candidate of knownMultiFamilyTtc) {
  if (findFontFile(candidate.file)) {
    const present = candidate.families.filter((family) => families.includes(family));
    assert.ok(present.length >= 2, `${candidate.file} 应产出多个真实 family，实际命中：${present.join(', ')}`);
  }
}

if (process.platform === 'darwin') {
  assert.ok(fonts.length > 0, 'macOS 系统字体目录不应为空');
  // 文件名推导产物必须消失（全库 69% 的旧 bug）。
  assert.ok(!families.includes('Songti'), '不应再出现文件名推导的 Songti');
  assert.ok(!families.includes('STHeiti Light'), '不应再出现文件名推导的 STHeiti Light');
  if (findFontFile('Songti.ttc')) {
    assert.ok(families.includes('Songti SC'), '系统存在 Songti.ttc 时应包含真实 family Songti SC');
  }
}

console.log('media-core-system-fonts tests passed');
