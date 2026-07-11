import { NextResponse } from 'next/server';
import { deleteFinalVideoDraft, getFinalVideoDraft, updateFinalVideoDraft } from '@/lib/final-video/draft-store';
import { buildDraftApiPatch, parseArrangement, parseDraftResponse, parseWorkflowConfig } from '@/lib/final-video/draft-api';

type Context = { params: Promise<{ id: string }> };
const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });
const stale = () => NextResponse.json(
  { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' }, { status: 409 },
);

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const row = getFinalVideoDraft(id);
  if (!row) return jsonError('成片草稿不存在', 404);
  return NextResponse.json({ draft: parseDraftResponse(row) });
}

export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
  const unknownKeys = Object.keys(body).filter((key) => !['revision', 'workflowConfig', 'arrangement'].includes(key));
  if (unknownKeys.length) return jsonError(`不支持的字段：${unknownKeys.join(', ')}`, 400);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);

  let workflowConfig;
  let arrangement;
  try {
    if ('workflowConfig' in body) workflowConfig = parseWorkflowConfig(body.workflowConfig);
    if ('arrangement' in body) arrangement = parseArrangement(body.arrangement);
  } catch (error) {
    return jsonError(`草稿内容无效：${error instanceof Error ? error.message : String(error)}`, 400);
  }

  const row = getFinalVideoDraft(id);
  if (!row) return stale();
  try {
    const patch = buildDraftApiPatch({ row, workflowConfig, arrangement });
    const draft = updateFinalVideoDraft(id, body.revision as number, patch);
    return NextResponse.json({ draft: parseDraftResponse(draft) });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'stale_revision') return stale();
    return jsonError(`更新成片草稿失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  if (!getFinalVideoDraft(id)) return jsonError('成片草稿不存在', 404);
  deleteFinalVideoDraft(id);
  return NextResponse.json({ success: true });
}
