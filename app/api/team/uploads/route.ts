import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { createTeamUpload, type CreateTeamUploadInput } from '@/lib/team-service/transfers';
import { readTransferJson, teamTransferErrorResponse, teamTransferStorageRoot } from '@/lib/team-service/transfers/http';
import { teamTransferSpace } from '@/lib/team-service/transfers/space';

export const runtime = 'nodejs';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await readTransferJson(request);
    const entries = Array.isArray(body.files) ? body.files : [body];
    if (entries.length < 1 || entries.length > 100) return Response.json({ error: 'invalid_input' }, { status: 400 });
    const uploads = [];
    for (const value of entries) {
      const entry = value as Record<string, unknown>;
      const target = entry.target as { resourceType: string; resourceId: string } | undefined;
      const targetScope = entry.targetScope as { resourceType: string; resourceId: string } | undefined;
      const input = {
        storageRoot: teamTransferStorageRoot(),
        target: target ?? (entry.targetResourceType ? { resourceType: entry.targetResourceType, resourceId: entry.targetResourceId } : undefined),
        targetKind: entry.targetKind,
        targetScope,
        deviceId: entry.deviceId,
        relativeName: entry.relativeName,
        mimeType: entry.mimeType,
        usage: entry.usage,
        expectedSize: entry.expectedSize,
        expectedSha256: entry.expectedSha256,
        sourceFingerprint: entry.sourceFingerprint,
        idempotencyKey: entry.idempotencyKey,
        partSize: entry.partSize,
      } as CreateTeamUploadInput;
      await teamTransferSpace(input.storageRoot).probe(input.expectedSize);
      uploads.push(createTeamUpload(getDb(), requireAccessContext().actor, input));
    }
    const first = uploads[0];
    return Response.json({
      uploads,
      upload: first,
      uploadId: first.id,
      partSize: first.partSize,
      missingParts: first.missingParts,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_create_failed');
  }
}

export const POST = withTeamRoute('/api/team/uploads', 'POST', __teamRoutePOST);
