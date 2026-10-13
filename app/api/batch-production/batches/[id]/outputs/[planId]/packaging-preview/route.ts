import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getBatchOutputArrangementView } from '@/lib/batch-production/output-arrangement';
import { batchPackagingDefaults } from '@/lib/batch-production/packaging';
import { parsePackagingConfig } from '@/lib/media-core/packaging-vars';
import { packagingPreviewHtml } from '@/lib/media-core/packaging-preview';
import { FINAL_EDIT_INTRO_DURATION_US } from '@/lib/media-core/render-contract';
import { materializeProjectAssetThumbnail } from '@/lib/batch-production/project-asset-media';
import { extractPackagingPalette, resolveTemplateHueMode } from '@/lib/media-core/packaging-palette';
import { resolvePackagingDir, resolvePackagingTemplateDir } from '@/lib/media-core/packaging-runtime';
import { batchProjectIdFromRequest, batchRouteErrorResponse, BATCH_NO_STORE_HEADERS } from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; planId: string }> }) {
  try {
    await assertBatchApiReady();
    const { id, planId } = await context.params;
    const projectId = batchProjectIdFromRequest(request);
    if (!projectId) return NextResponse.json({ message: '缺少项目 ID' }, { status: 400 });
    const db = getDb();
    const view = getBatchOutputArrangementView(db, projectId, id, planId);
    const config = parsePackagingConfig(view.packaging);
    const defaults = batchPackagingDefaults(db, projectId, view);
    const vars = { ...defaults, ...config.varsOverrides };
    const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
    const totalSec = Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) / 1e6 + coverSec;
    if (request.nextUrl.searchParams.get('format') !== 'html') return NextResponse.json({ config, defaults, vars, coverSec, totalSec }, { headers: BATCH_NO_STORE_HEADERS });
    let palette = null;
    const coverAssetId = view.coverAssetId ?? view.clips[0]?.assetId;
    if (coverAssetId) {
      try {
        const thumbnail = await materializeProjectAssetThumbnail(db, projectId, coverAssetId);
        palette = await extractPackagingPalette(thumbnail.absolutePath, resolveTemplateHueMode(resolvePackagingTemplateDir(resolvePackagingDir(), config.template)));
      } catch { /* 素材缩略图暂不可用时，模板保留默认配色。正式导出按实际封面取色。 */ }
    }
    return new Response(packagingPreviewHtml({ config, vars, coverSec, totalSec, palette, edit: request.nextUrl.searchParams.get('edit') === '1' }), { headers: { ...BATCH_NO_STORE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) { return batchRouteErrorResponse(error, 'packaging_preview_failed', '读取包装预览失败'); }
}
