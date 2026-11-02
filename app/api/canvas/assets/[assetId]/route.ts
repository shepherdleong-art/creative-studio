import { dataRoot } from '@/lib/data-root';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { canvasAssetAbsolutePath, canvasStorageRoot, requireCanvasAsset } from '@/lib/creative-canvas/assets';
import { canvasAssetDownloadFilename } from '@/lib/creative-canvas/asset-naming';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';
import { BrowserPreviewPendingError, ensureBrowserPreview } from '@/lib/video-browser-preview';
import { fileResponse } from '@/lib/media-core/file-response';
import { authorizeManagedFileRead, registerManagedFile } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';

async function __teamRouteGET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { assetId } = await params;
    const db = getDb();
    const asset = requireCanvasAsset(db, assetId);
    const originalPath = canvasAssetAbsolutePath(asset, canvasStorageRoot(dataRoot()));
    const originalGrant = authorizeManagedFileRead(originalPath);
    const download = new URL(request.url).searchParams.get('download') === '1';
    let served = originalPath;
    let mimeType = asset.mimeType;
    if (!download && asset.mediaKind === 'video') {
      served = await ensureBrowserPreview(originalPath);
      if (served !== originalPath) {
        mimeType = 'video/mp4';
        if (originalGrant) {
          registerManagedFile({ absolutePath: served, mimeType, derivedFromFileId: originalGrant.fileId });
        }
      }
    }
    return fileResponse(request, served, mimeType, {
      cacheControl: 'private, max-age=3600',
      ...(download ? { downloadName: canvasAssetDownloadFilename(db, asset) } : {}),
    });
  } catch (error) {
    if (error instanceof BrowserPreviewPendingError) {
      return Response.json({ error: 'preview_pending', retryAfterMs: error.retryAfterMs }, { status: 202 });
    }
    if (error instanceof CanvasError) return canvasJsonError(error);
    return canvasJsonError(error);
  }
}
export const GET = withTeamRoute('/api/canvas/assets/[assetId]', 'GET', __teamRouteGET);
