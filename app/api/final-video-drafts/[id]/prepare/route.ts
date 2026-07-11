import { NextResponse } from 'next/server';
import { prepareFinalVideoDraft } from '@/lib/final-video/prepare-draft';
import { parseDraftResponse } from '@/lib/final-video/draft-api';
import { errorCode, jsonError, stale } from '@/lib/final-video/route-helpers';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);

  try {
    const draft = await prepareFinalVideoDraft({ draftId: id, expectedRevision: body.revision as number });
    return NextResponse.json({ draft: parseDraftResponse(draft) });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'not_found') return jsonError('成片草稿不存在', 404);
    if (code === 'stale_revision') return stale();
    if (code === 'invalid_input') return jsonError(error instanceof Error ? error.message : String(error), 400);
    return jsonError(`准备成片草稿失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
