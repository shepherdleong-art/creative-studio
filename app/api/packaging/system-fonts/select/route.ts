// §9 ② 系统字体物化：选中字体 → 内容寻址拷贝到 packaging/fonts/user/user-<slot>-<hash>.<ext>
// （复用 §8.5 已验证的别名注入链：预览 iframe 与成片渲染共用同一文件）
// POST body: { key: "system:<绝对路径>", slot?: "point"|"title"|"subtitle" }（slot 缺省 point）
// 白名单校验防目录穿越；TTC 合集仅首 face（§10.2-3 已知限制）。

import { NextResponse } from 'next/server';
import { FONT_SLOT_ALIASES, materializeSystemFont, type FontSlot } from '@/lib/media-core/packaging-font';

export async function POST(request: Request): Promise<NextResponse> {
  let key = '';
  let slot: FontSlot = 'point';
  try {
    const body = await request.json() as { key?: unknown; slot?: unknown };
    if (typeof body.key === 'string') key = body.key;
    if (typeof body.slot === 'string' && body.slot in FONT_SLOT_ALIASES) slot = body.slot as FontSlot;
  } catch { /* 非法 JSON 按缺 key 处理 */ }
  if (!key.startsWith('system:') || key.length <= 'system:'.length) {
    return NextResponse.json({ error: 'font_key_invalid', message: '字体标识无效' }, { status: 400 });
  }
  const absPath = key.slice('system:'.length);
  try {
    const filename = materializeSystemFont(absPath, slot);
    return NextResponse.json({ font: filename, key, slot });
  } catch (error) {
    return NextResponse.json({ error: 'font_materialize_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}