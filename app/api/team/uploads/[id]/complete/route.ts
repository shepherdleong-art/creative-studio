import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { completeTeamUpload } from '@/lib/team-service/transfers';
import { readTransferJson, teamTransferErrorResponse, teamTransferStorageRoot } from '@/lib/team-service/transfers/http';

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
    });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_complete_failed');
  }
}

export const POST = withTeamRoute('/api/team/uploads/[id]/complete', 'POST', __teamRoutePOST);
