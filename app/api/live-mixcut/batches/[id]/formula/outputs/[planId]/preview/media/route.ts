import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { resolveFormulaPreviewMedia } from '@/lib/live-mixcut/formula/preview';
import { projectAssetMediaResponse } from '@/lib/live-mixcut/project-asset-media-response';
import { batchRouteErrorResponse } from '@/app/api/live-mixcut/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, route: { params: Promise<{ id: string; planId: string }> }) {
  try {
    const { id, planId } = await route.params;
    const query = request.nextUrl.searchParams;
    const projectId = query.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    const media = await resolveFormulaPreviewMedia(getDb(), projectId, id, planId, query.get('selectionStageId') ?? '',
      query.get('timelineStageId') ?? '', query.get('kind') ?? '', query.get('mediaId') ?? '', request.signal,
      { outputVersionId: query.get('outputVersionId') ?? '', sourceFingerprint: query.get('sourceFingerprint') ?? '' });
    return projectAssetMediaResponse(request, media.absolutePath, media.mimeType, {}, media.identity);
  } catch (error) { return batchRouteErrorResponse(error, 'formula_preview_media_failed', '预览文件无法读取，请检查素材'); }
}
