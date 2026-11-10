import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-system-fonts-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { listSystemFonts, resolveSystemFontFile } = await import('../lib/media-core/system-fonts.ts');
const { sharedSystemFontRoots } = await import('../lib/media-core/system-font-roots.ts');
try {
  const directory = path.join(root, 'storage', 'fonts');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'server-font.ttf');
  fs.copyFileSync('packaging/fonts/ZCOOLKuaiLe-Regular.ttf', file);
  const font = listSystemFonts({ forceRefresh: true }).find(entry => entry.previewUrl && resolveSystemFontFile(entry.previewUrl.split('/')[3]) === file);
  assert.ok(font, '共享字体目录中的字体必须出现在字幕目录中，不依赖服务账号的 LOCALAPPDATA');
  assert.ok(sharedSystemFontRoots().includes(directory));
  assert.ok(!JSON.stringify(font).includes(root), '目录响应不得暴露服务器路径');
  assert.equal(resolveSystemFontFile('../server-font.ttf'), null);
  assert.equal(resolveSystemFontFile('0'.repeat(64)), null);
  fs.unlinkSync(file);
  assert.equal(resolveSystemFontFile(font.previewUrl!.split('/')[3]), null, '被删除的字体不能通过旧 ID 读取');
  console.log('shared system font directory and opaque file IDs passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
