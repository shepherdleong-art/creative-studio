import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { listViralTemplateEntries } from '@/lib/script-studio/viral-templates';

export const runtime = 'nodejs';

/** 爆文模板条目浏览/搜索：?status=&category=&q=&revisionId=&limit=。 */
export async function GET(request: NextRequest) {
  try {
    await assertScriptStudioApiReady();
    const params = request.nextUrl.searchParams;
    const status = params.get('status');
    const entries = listViralTemplateEntries(getDb(), {
      ...(params.get('revisionId') ? { revisionId: params.get('revisionId')! } : {}),
      ...(status ? { status: status as 'usable' | 'unusable' | 'review' | 'all' } : {}),
      ...(params.get('category') ? { category: params.get('category')! } : {}),
      ...(params.get('q') ? { q: params.get('q')! } : {}),
      ...(params.get('limit') ? { limit: Number(params.get('limit')) } : {}),
    });
    return NextResponse.json({ entries });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
