import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { recordTeamDownloadReceipt } from '@/lib/team-service/transfers/devices';
import { readTransferJson, teamTransferErrorResponse } from '@/lib/team-service/transfers/http';

export const runtime = 'nodejs';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await readTransferJson(request);
    const receipt = recordTeamDownloadReceipt(getDb(), requireAccessContext().actor, {
      deviceId: body.deviceId as string,
      fileId: body.fileId as string,
      artifactVersion: body.artifactVersion as number,
      state: body.state as 'pending' | 'downloading' | 'completed' | 'failed' | 'suppressed',
      etag: body.etag as string | undefined,
      verifiedSha256: body.verifiedSha256 as string | undefined,
      failureCode: body.failureCode as string | undefined,
    });
    return Response.json(receipt, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'download_receipt_failed');
  }
}

export const POST = withTeamRoute('/api/team/downloads/receipts', 'POST', __teamRoutePOST);
