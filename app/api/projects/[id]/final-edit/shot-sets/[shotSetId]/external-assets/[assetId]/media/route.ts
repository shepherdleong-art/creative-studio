import path from 'node:path';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { mediaResponse, resolveFinalEditMedia } from '@/lib/final-edit/media-response';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { dataRoot } from '@/lib/data-root';
import { ensureBrowserPreview } from '@/lib/video-browser-preview';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string; assetId: string }> },
) {
  try {
    const { id: projectId, shotSetId, assetId } = await params;
    const media = getFinalEditWorkspace().resolveShotSetExternalAssetMedia(projectId, shotSetId, assetId, 'video');
    // 浏览器播放入口（?preview=1）：HEVC/10bit 原件浏览器放不动，换成
    // （必要时懒生成的）H.264 预览衍生物；不带参数的 GET 始终给原件。
    if (new URL(request.url).searchParams.get('preview') === '1' && media.mimeType.startsWith('video/')) {
      const absolute = resolveFinalEditMedia(media.relativePath);
      const served = await ensureBrowserPreview(absolute);
      if (served !== absolute) {
        const storageRoot = path.resolve(dataRoot(), 'storage');
        return mediaResponse(request, path.relative(storageRoot, served), 'video/mp4');
      }
    }
    return mediaResponse(request, media.relativePath, media.mimeType);
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
