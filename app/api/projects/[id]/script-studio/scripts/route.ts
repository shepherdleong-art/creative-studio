import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { listProjectScripts } from '@/lib/script-studio/scripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const url = new URL(request.url);
    const result = listProjectScripts(getDb(), projectId, {
      cursor: url.searchParams.get('cursor') || '',
      limit: Number(url.searchParams.get('limit')) || 50,
      includeArchived: url.searchParams.get('includeArchived') === '1',
    });
    return NextResponse.json(result);
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
