import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 系统字体扫描（技术计划 §3.1/§10.5）：浏览器封面编辑器通过 /api/system-fonts
// 消费这份列表；.ttc（TrueType Collection，macOS 大量中文字体的形态）必须显式
// 标记，因为单个文件包含多个字型、且文件名推导的 family 名可能不等于真实 family。

export interface SystemFontEntry {
  /** 从文件名推导的字体族名（去掉扩展名与常见字重后缀） */
  family: string;
  fullName: string;
  /** 字体文件格式；ttc 为 TrueType Collection（一个文件含多个字型） */
  format: 'ttf' | 'otf' | 'ttc';
}

const FONT_DIRECTORIES: Record<string, string[]> = {
  darwin: ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')],
  win32: [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')],
  linux: ['/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')],
};

/** 按平台扫描字体目录（最多 3 层），按 family 去重排序 */
export function listSystemFonts(): SystemFontEntry[] {
  const directories = FONT_DIRECTORIES[process.platform] || FONT_DIRECTORIES.linux;
  const fonts = new Map<string, SystemFontEntry>();
  const visit = (directory: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(full, depth + 1); continue; }
      const format = /\.ttc$/i.test(entry.name) ? 'ttc' : /\.otf$/i.test(entry.name) ? 'otf' : /\.ttf$/i.test(entry.name) ? 'ttf' : null;
      if (!format) continue;
      const family = path.basename(entry.name, path.extname(entry.name)).replace(/[-_](Regular|Bold|Light|Medium|Semibold).*$/i, '');
      if (!fonts.has(family)) fonts.set(family, { family, fullName: family, format });
    }
  };
  directories.forEach((directory) => visit(directory, 0));
  return [...fonts.values()].sort((a, b) => a.family.localeCompare(b.family));
}
