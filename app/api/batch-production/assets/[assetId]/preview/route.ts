import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { resolveVerifiedProjectAssetMedia, projectAssetMimeType } from '@/lib/batch-production/project-asset-media';
import { projectAssetMediaResponse } from '@/lib/batch-production/project-asset-media-response';
import { ensureBrowserPreview } from '@/lib/video-browser-preview';
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
    // 本路由只服务浏览器播放（下载/导出不经此）：视频原片可能是 HEVC/10bit
    // （Seedance 2.5 1080p），浏览器放不动，统一换（必要时懒生成的）H.264
    // 预览衍生物；衍生物不是被追踪的素材本体，跳过文件身份校验。
    const mimeType = projectAssetMimeType(media.filePath);
    const served = mimeType.startsWith('video/')
      ? await ensureBrowserPreview(media.filePath)
      : media.filePath;
    return projectAssetMediaResponse(
      request,
      served,
      served === media.filePath ? mimeType : 'video/mp4',
      {},
      served === media.filePath ? media.fileIdentity : undefined,
    );
  } catch (error) {
    return batchRouteErrorResponse(error, 'asset_preview_failed', '素材预览失败');
  }
}
