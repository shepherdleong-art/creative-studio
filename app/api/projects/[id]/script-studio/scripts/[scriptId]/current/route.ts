import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { setProjectScriptCurrentRevision } from '@/lib/script-studio/scripts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function __teamRoutePUT(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const body = await jsonOrNull(request);
    if (!body || typeof body.revisionId !== 'string') {
      throw new ScriptStudioError('invalid_input', '缺少 revisionId');
    }
    const script = setProjectScriptCurrentRevision(getDb(), projectId, scriptId, body.revisionId);
    return NextResponse.json({ script });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
export const PUT = withTeamRoute('/api/projects/[id]/script-studio/scripts/[scriptId]/current', 'PUT', __teamRoutePUT);
