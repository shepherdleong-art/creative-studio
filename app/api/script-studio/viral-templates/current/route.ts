import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { setViralTemplateCurrentRevision } from '@/lib/script-studio/viral-templates';

export const runtime = 'nodejs';

/** 激活爆文模板库历史修订（只切当前指针）。 */
export async function PUT(request: NextRequest) {
  try {
    await assertScriptStudioApiReady();
    const body = await jsonOrNull(request);
    const revisionId = typeof body?.revisionId === 'string' ? body.revisionId : '';
    if (!revisionId) {
      return NextResponse.json({ error: 'invalid_input', message: '缺少 revisionId' }, { status: 400 });
    }
    const result = setViralTemplateCurrentRevision(getDb(), revisionId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
