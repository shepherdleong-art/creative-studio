import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { putTeamUploadPart, TransferError } from '@/lib/team-service/transfers';
import { teamTransferErrorResponse, teamTransferStorageRoot } from '@/lib/team-service/transfers/http';

export const runtime = 'nodejs';

async function __teamRoutePUT(request: Request, { params }: { params: Promise<{ id: string; part: string }> }) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    if (!request.body) throw new TransferError('invalid_input', '缺少分片字节流。');
    const { id, part } = await params;
    const result = await putTeamUploadPart(getDb(), requireAccessContext().actor, {
      storageRoot: teamTransferStorageRoot(),
      uploadId: id,
      partNumber: Number(part),
      body: request.body,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_part_failed');
  }
}

export const PUT = withTeamRoute('/api/team/uploads/[id]/parts/[part]', 'PUT', __teamRoutePUT);
