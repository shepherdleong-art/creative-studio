import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TeamFileAccessError, teamFileResponse } from '@/lib/team-service/files';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';

async function __teamRouteGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (readRuntimeConfig().mode !== 'server') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  try {
    const access = requireAccessContext();
    const { id } = await params;
    return teamFileResponse(request, getDb(), access.actor, {
      storageRoot: path.join(dataRoot(), 'storage'),
      fileId: id,
      downloadName: new URL(request.url).searchParams.get('download') === '1' ? id : undefined,
    });
  } catch (error) {
    if (error instanceof TeamFileAccessError || (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return NextResponse.json({ error: 'file_not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'file_read_failed' }, { status: 500 });
  }
}

export const GET = withTeamRoute('/api/team/files/[id]', 'GET', __teamRouteGET);
