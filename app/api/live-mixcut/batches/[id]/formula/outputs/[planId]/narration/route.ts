import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { resolveFormulaNarrationMedia } from '@/lib/live-mixcut/formula/narration-store';
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
    const media = resolveFormulaNarrationMedia(getDb(), projectId, id, planId, query.get('selectionStageId') ?? '', query.get('narrationId') ?? '');
    return projectAssetMediaResponse(request, media.absolutePath, 'audio/wav', {}, media.identity);
  } catch (error) { return batchRouteErrorResponse(error, 'formula_narration_read_failed', '配音试听失败，请检查文件后重试'); }
}
