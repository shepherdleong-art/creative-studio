import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string; assetId: string }> },
) {
  try {
    const { id: projectId, shotSetId, assetId } = await params;
    const media = getFinalEditWorkspace().resolveShotSetExternalAssetMedia(projectId, shotSetId, assetId, 'thumbnail');
    return mediaResponse(request, media.relativePath, media.mimeType);
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
