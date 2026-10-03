import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { updateViralTemplateEntryStatus } from '@/lib/script-studio/viral-templates';

export const runtime = 'nodejs';

/** 人工调整模板条目可用状态（占位/待检查可改为可用，或反向标记）。 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ entryId: string }> }) {
  try {
    await assertScriptStudioApiReady();
    const { entryId } = await context.params;
    const body = await jsonOrNull(request);
    const status = typeof body?.status === 'string' ? body.status : '';
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    if (!['usable', 'unusable', 'review'].includes(status)) {
      return NextResponse.json({ error: 'invalid_input', message: 'status 必须是 usable / unusable / review' }, { status: 400 });
    }
    const entry = updateViralTemplateEntryStatus(getDb(), entryId, status as 'usable' | 'unusable' | 'review', reason || '人工调整');
    return NextResponse.json({ entry });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
