import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import {
  assertScriptStudioApiReady,
  errorResponse,
  jsonOrNull,
} from '@/lib/script-studio/http';
import {
  getCurrentLibraryRevision,
  getLibraryRevision,
  listLibraryRevisions,
  manualEditLibraryRevision,
} from '@/lib/script-studio/libraries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const db = getDb();
    const url = new URL(request.url);
    const revisionId = url.searchParams.get('revisionId');
    if (revisionId) {
      const revision = getLibraryRevision(db, projectId, revisionId);
      if (!revision) throw new ScriptStudioError('not_found', '卖点库修订不存在');
      return NextResponse.json({ revision });
    }
    const current = getCurrentLibraryRevision(db, projectId);
    const history = listLibraryRevisions(db, projectId, {
      cursor: url.searchParams.get('cursor') || '',
      limit: Number(url.searchParams.get('limit')) || 50,
    });
    return NextResponse.json({ current, revisions: history.revisions, nextCursor: history.nextCursor });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const body = await jsonOrNull(request);
    const edits = Array.isArray(body?.edits) ? body!.edits.map((item) => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        sellingPointId: String(value.sellingPointId || ''),
        usable: typeof value.usable === 'boolean' ? value.usable : undefined,
        disabledByUser: typeof value.disabledByUser === 'boolean' ? value.disabledByUser : undefined,
        factText: typeof value.factText === 'string' ? value.factText : undefined,
        title: typeof value.title === 'string' ? value.title : undefined,
      };
    }) : [];
    if (edits.length === 0) throw new ScriptStudioError('invalid_input', '至少需要修改一条卖点');
    const revision = manualEditLibraryRevision(getDb(), projectId, edits);
    return NextResponse.json({ revision }, { status: 201 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
