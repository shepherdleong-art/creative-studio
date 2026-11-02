import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { createBackupPin } from '@/lib/team-service/lifecycle/index';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as { releaseId?: unknown; configVersion?: unknown; fileIds?: unknown };
    if (typeof body.releaseId !== 'string' || typeof body.configVersion !== 'string'
      || !Array.isArray(body.fileIds) || body.fileIds.some((id) => typeof id !== 'string')) {
      return Response.json({ error: 'invalid_input', message: '备份 pin 参数不完整。' }, { status: 400 });
    }
    const pin = createBackupPin(getDb(), requireAccessContext().actor, {
      releaseId: body.releaseId, configVersion: body.configVersion, fileIds: body.fileIds as string[],
    });
    return Response.json({ pin }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: 'backup_pin_failed', message: '无法建立备份 pin。' }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/team/backup-pins', 'POST', __teamRoutePOST);
