// §9 ② 系统字体枚举（三版块下拉数据源）
// GET /api/packaging/system-fonts → { fonts: SystemFontEntry[], scannedAt, fromCache }
// GET /api/packaging/system-fonts?refresh=1 → 强制重扫（界面「刷新」按钮）
// 后端扫描：注册表 + 白名单目录 + fontkit cmap 中文检测；结果缓存按目录 mtime 失效。

import { NextResponse } from 'next/server';
import { scanSystemFonts } from '@/lib/media-core/packaging-font';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    const result = scanSystemFonts(force);
    return NextResponse.json({
      fonts: result.fonts.map(({ key, file, family, nameZh, supportsCn }) => ({ key, file, family, nameZh, supportsCn })),
      scannedAt: result.scannedAt,
      fromCache: result.fromCache,
      count: result.fonts.length,
    });
  } catch (error) {
    return NextResponse.json({ error: 'font_scan_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}