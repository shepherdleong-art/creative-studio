import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getCatalogRevisionView } from '@/lib/script-studio/catalogs';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ catalogId: string; revisionId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { catalogId, revisionId } = await params;
    const view = getCatalogRevisionView(getDb(), revisionId);
    if (!view || view.catalogId !== catalogId) {
      return NextResponse.json({ error: 'not_found', message: '目录修订不存在' }, { status: 404 });
    }
    return NextResponse.json({ revision: view });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
