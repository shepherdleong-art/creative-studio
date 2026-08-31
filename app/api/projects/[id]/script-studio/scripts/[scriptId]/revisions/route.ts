import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { listProjectScriptRevisions } from '@/lib/script-studio/scripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const url = new URL(request.url);
    const result = listProjectScriptRevisions(getDb(), projectId, scriptId, {
      cursor: url.searchParams.get('cursor') || '',
      limit: Number(url.searchParams.get('limit')) || 50,
    });
    return NextResponse.json(result);
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
