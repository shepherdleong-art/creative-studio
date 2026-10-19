// §8 ⑤ / §10 ② 用户本地字体上传（自定义字体入口，补充系统字体下拉；默认写卖点槽）
// POST multipart(form-data) field "font" [slot="point"|"title"|"subtitle"] → 校验扩展名+魔数+大小上限
//    → 内容寻址存 dataRoot()/storage/packaging/fonts/；损坏/非法 400，不落盘。
// GET  → { font: "<卖点槽最新文件>" | null }
// DELETE → 拒绝删除可能被历史任务引用的字体；通过配置选择原生字体即可解除当前使用。

import path from 'node:path';
import { NextResponse } from 'next/server';
import { FONT_SLOT_ALIASES, materializeFontBuffer, readUserFontFilename, sniffFontMagic, USER_FONT_EXTENSIONS, USER_FONT_MAX_BYTES, type FontSlot } from '@/lib/media-core/packaging-font';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ font: readUserFontFilename() });
}

export async function POST(request: Request): Promise<NextResponse> {
  let file: File | null = null;
  let slot: FontSlot = 'point';
  try {
    const form = await request.formData();
    const entry = form.get('font');
    const slotEntry = form.get('slot');
    if (entry instanceof File) file = entry;
    if (typeof slotEntry === 'string' && slotEntry in FONT_SLOT_ALIASES) slot = slotEntry as FontSlot;
  } catch { /* 非法 multipart 按无文件处理 */ }
  if (!file || file.size === 0) return NextResponse.json({ error: 'font_missing', message: '请选择字体文件上传' }, { status: 400 });
  if (file.size > USER_FONT_MAX_BYTES) return NextResponse.json({ error: 'font_too_large', message: '字体文件不能超过 20MB' }, { status: 400 });
  const ext = path.extname(file.name).toLowerCase();
  if (!USER_FONT_EXTENSIONS.has(ext)) return NextResponse.json({ error: 'font_type_invalid', message: '仅支持 .ttf / .otf / .woff2 字体文件' }, { status: 400 });
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!sniffFontMagic(buffer, ext)) return NextResponse.json({ error: 'font_corrupted', message: '字体文件已损坏或格式不符，未保存（已回退默认字体）' }, { status: 400 });

  try {
    const filename = materializeFontBuffer(buffer, ext, slot);
    return NextResponse.json({ font: filename, slot });
  } catch {
    return NextResponse.json({ error: 'font_write_failed', message: '字体目录不可写' }, { status: 500 });
  }
}

// Content-addressed fonts may still be referenced by frozen render snapshots.
export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ error: 'font_snapshot_protected', message: '请在包装配置中选择模板原生字体；已使用字体保留供历史任务渲染' }, { status: 409 });
}
