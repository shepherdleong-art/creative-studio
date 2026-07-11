import { NextResponse } from 'next/server';
import { parseDraftResponse } from '@/lib/final-video/draft-api';
import { getFinalVideoDraft, updateFinalVideoDraft } from '@/lib/final-video/draft-store';
import { buildArrangement } from '@/lib/final-video/orchestrate';
import { parseClipPoolJson, parseFinalVideoWorkflowConfigJson, parseNarrationBeatsJson } from '@/lib/final-video/types';

type Context = { params: Promise<{ id: string }> };

const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });
const stale = () => NextResponse.json(
  { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' }, { status: 409 },
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
  const unknownKeys = Object.keys(body).filter((key) => !['revision', 'providerId'].includes(key));
  if (unknownKeys.length) return jsonError(`不支持的字段：${unknownKeys.join(', ')}`, 400);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);
  if (typeof body.providerId !== 'string' || !body.providerId.trim()) return jsonError('providerId 必须是非空字符串', 400);

  const initial = getFinalVideoDraft(id);
  if (!initial) return jsonError('成片草稿不存在', 404);

  let workflowConfig;
  let beats;
  let clips;
  try {
    workflowConfig = parseFinalVideoWorkflowConfigJson(initial.workflowConfigJson);
    beats = parseNarrationBeatsJson(initial.narrationBeatsJson);
    clips = parseClipPoolJson(initial.clipPoolJson);
  } catch (error) {
    return jsonError(`草稿内容无效：${errorMessage(error)}`, 400);
  }
  if (workflowConfig.packageConfig.mode !== 'narration') return jsonError('只有口播模式草稿可以进行 AI 编排', 400);
  if (initial.stage !== 'narration-ready' && initial.stage !== 'review') return jsonError('草稿当前状态不能进行 AI 编排', 400);
  if (beats.length === 0) return jsonError('口播节拍不能为空', 400);
  if (clips.length === 0) return jsonError('候选素材不能为空', 400);

  let arranging;
  try {
    arranging = updateFinalVideoDraft(id, body.revision as number, { stage: 'arranging' });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'stale_revision') return stale();
    return jsonError(`更新成片草稿失败：${errorMessage(error)}`, 500);
  }

  const currentRevision = arranging.revision;
  try {
    // buildArrangement converts all provider/model failures into a validated fallback plan
    // with an arrangement_fallback_used warning, so a successful call always reaches review.
    const arrangement = await buildArrangement({
      beats,
      clips,
      maxClipSeconds: workflowConfig.packageConfig.maxClipSeconds,
      providerId: body.providerId.trim(),
    });
    const draft = updateFinalVideoDraft(id, currentRevision, {
      stage: 'review',
      arrangementJson: JSON.stringify(arrangement.plan),
      issuesJson: JSON.stringify(arrangement.issues),
      previewJobId: null,
      previewRevision: null,
      errorMessage: null,
    });
    return NextResponse.json({ draft: parseDraftResponse(draft) });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'stale_revision') return stale();
    try {
      const draft = updateFinalVideoDraft(id, currentRevision, {
        stage: 'failed',
        errorMessage: errorMessage(error),
      });
      return NextResponse.json({ draft: parseDraftResponse(draft) });
    } catch (recoveryError) {
      if (recoveryError instanceof Error && (recoveryError as Error & { code?: string }).code === 'stale_revision') return stale();
      return jsonError(`编排素材失败：${errorMessage(error)}`, 500);
    }
  }
}
