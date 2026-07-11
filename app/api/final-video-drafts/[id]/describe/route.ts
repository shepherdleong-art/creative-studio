import { NextResponse } from 'next/server';
import { parseDraftResponse } from '@/lib/final-video/draft-api';
import { getFinalVideoDraft, updateFinalVideoDraft } from '@/lib/final-video/draft-store';
import { describeClipPool } from '@/lib/final-video/vision';
import { parseClipPoolJson, parseFinalVideoWorkflowConfigJson } from '@/lib/final-video/types';
import { resolveStoredScriptProvider } from '@/lib/script-providers/store';

type Context = { params: Promise<{ id: string }> };
const EMPTY_ARRANGEMENT = JSON.stringify({ assignments: [], gaps: [] });
const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });
const stale = () => NextResponse.json(
  { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' }, { status: 409 },
);

function invalidInputError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

function validateVisionProvider(providerId: string): void {
  let provider;
  try {
    provider = resolveStoredScriptProvider(providerId);
  } catch (error) {
    throw invalidInputError(error instanceof Error ? error.message : String(error));
  }
  if (!provider.supportsVision) throw invalidInputError(`${provider.name} 未开启图片理解能力`);
  if (!provider.configured) throw invalidInputError(`${provider.name} 未配置完整：${provider.missing.join(', ')}`);
}

function failureMessage(failures: Array<{ clipId: string; message: string }>): string {
  return `素材描述失败：${failures.map((failure) => `${failure.clipId}: ${failure.message}`).join('；')}`;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
  const unknownKeys = Object.keys(body).filter((key) => !['revision', 'force'].includes(key));
  if (unknownKeys.length) return jsonError(`不支持的字段：${unknownKeys.join(', ')}`, 400);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);
  if ('force' in body && typeof body.force !== 'boolean') return jsonError('force 必须是布尔值', 400);

  const initial = getFinalVideoDraft(id);
  if (!initial) return jsonError('成片草稿不存在', 404);

  let clips;
  try {
    const workflowConfig = parseFinalVideoWorkflowConfigJson(initial.workflowConfigJson);
    validateVisionProvider(workflowConfig.visionProviderId);
    clips = parseClipPoolJson(initial.clipPoolJson);
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (code === 'invalid_input') return jsonError(error instanceof Error ? error.message : String(error), 400);
    return jsonError(`草稿内容无效：${error instanceof Error ? error.message : String(error)}`, 400);
  }

  let describing;
  try {
    describing = updateFinalVideoDraft(id, body.revision as number, { stage: 'describing' });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'stale_revision') return stale();
    return jsonError(`更新成片草稿失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }

  const workflowConfig = parseFinalVideoWorkflowConfigJson(describing.workflowConfigJson);
  const currentRevision = describing.revision;
  try {
    const described = await describeClipPool({
      clips,
      providerId: workflowConfig.visionProviderId,
      force: body.force as boolean | undefined,
    });
    const failed = described.failures.length > 0;
    const draft = updateFinalVideoDraft(id, currentRevision, {
      stage: failed ? 'failed' : 'narration-ready',
      clipPoolJson: JSON.stringify(described.clips),
      arrangementJson: EMPTY_ARRANGEMENT,
      issuesJson: '[]',
      previewJobId: null,
      previewRevision: null,
      errorMessage: failed ? failureMessage(described.failures) : null,
    });
    return NextResponse.json({ draft: parseDraftResponse(draft) });
  } catch (error) {
    try {
      const draft = updateFinalVideoDraft(id, currentRevision, {
        stage: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ draft: parseDraftResponse(draft) });
    } catch {
      const current = getFinalVideoDraft(id);
      if (current) return NextResponse.json({ draft: parseDraftResponse(current) });
      return jsonError(`描述素材失败：${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }
}
