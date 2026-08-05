import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { resolveVerifiedProjectAssetMedia, projectAssetMimeType } from '@/lib/batch-production/project-asset-media';
import { projectAssetMediaResponse } from '@/lib/batch-production/project-asset-media-response';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 项目素材原片预览：只接受 projectId + assetId，按 Range 流式读取。 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const media = await resolveVerifiedProjectAssetMedia(getDb(), projectId, assetId);
    return projectAssetMediaResponse(
      request,
      media.filePath,
      projectAssetMimeType(media.filePath),
      {},
      media.fileIdentity,
    );
  } catch (error) {
    return batchRouteErrorResponse(error, 'asset_preview_failed', '素材预览失败');
  }
}
