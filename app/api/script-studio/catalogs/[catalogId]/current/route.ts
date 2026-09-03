import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { setCatalogCurrentRevision } from '@/lib/script-studio/catalogs';

export const runtime = 'nodejs';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ catalogId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { catalogId } = await params;
    const body = await request.json().catch(() => ({})) as { revisionId?: unknown };
    if (typeof body.revisionId !== 'string' || !body.revisionId) {
      return NextResponse.json({ error: 'invalid_input', message: '缺少 revisionId' }, { status: 400 });
    }
    const db = getDb();
    const catalog = db.prepare(`SELECT id, kind FROM script_studio_catalogs WHERE id = ?`).get(catalogId) as { id: string; kind: string } | undefined;
    if (!catalog) return NextResponse.json({ error: 'not_found', message: '目录不存在' }, { status: 404 });
    setCatalogCurrentRevision(db, catalogId, body.revisionId);
    return NextResponse.json({ ok: true, catalogId, kind: catalog.kind, currentRevisionId: body.revisionId });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
