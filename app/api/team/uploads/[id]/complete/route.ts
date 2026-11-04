import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { completeTeamUpload } from '@/lib/team-service/transfers';
import { readTransferJson, teamTransferErrorResponse, teamTransferStorageRoot } from '@/lib/team-service/transfers/http';
import { teamTransferSpace } from '@/lib/team-service/transfers/space';
import path from 'node:path';
import { toStorageImageUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

async function __teamRoutePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await readTransferJson(request);
    const { id } = await params;
    const result = await completeTeamUpload(getDb(), requireAccessContext().actor, {
      storageRoot: teamTransferStorageRoot(),
      uploadId: id,
      expectedSha256: typeof body.expectedSha256 === 'string' ? body.expectedSha256 : undefined,
      sourceFingerprint: typeof body.sourceFingerprint === 'string' ? body.sourceFingerprint : undefined,
      space: teamTransferSpace(teamTransferStorageRoot()),
    });
    const image = result.resultResourceType === 'image' ? getDb().prepare(`SELECT id, filename, mimeType,
      role, usage, path, originalSizeBytes, processedSizeBytes, originalWidth, originalHeight,
      processedWidth, processedHeight FROM image_assets WHERE id=?`).get(result.resultResourceId) as {
        id: string; filename: string; mimeType: string; role: string; usage: string; path: string;
        originalSizeBytes: number; processedSizeBytes: number | null;
      } | undefined : undefined;
    const uploadedFile = image ? {
      ...image, path: undefined, size: image.processedSizeBytes ?? image.originalSizeBytes,
      relativePath: path.relative(teamTransferStorageRoot(), image.path).split(path.sep).join('/'),
      imageUrl: toStorageImageUrl(image.path),
    } : undefined;
    return Response.json({ ...result, uploadedFile }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_complete_failed');
  }
}

export const POST = withTeamRoute('/api/team/uploads/[id]/complete', 'POST', __teamRoutePOST);
