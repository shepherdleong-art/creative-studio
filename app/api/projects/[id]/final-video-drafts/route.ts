import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createFinalVideoDraft, listFinalVideoDrafts } from '@/lib/final-video/draft-store';
import { parseDraftResponse, parseWorkflowConfig } from '@/lib/final-video/draft-api';

type Context = { params: Promise<{ id: string }> };
const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(request: Request, { params }: Context) {
  try {
    const { id: projectId } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
    const db = getDb();
    if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) return jsonError('项目不存在', 404);
    if (typeof body.shotSetId !== 'string' || !body.shotSetId) return jsonError('请选择分镜组', 400);
    const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(body.shotSetId) as { projectId: string } | undefined;
    if (!shotSet || shotSet.projectId !== projectId) return jsonError('分镜组不存在或不属于当前项目', 404);

    let workflowConfig;
    try { workflowConfig = parseWorkflowConfig(body.workflowConfig); }
    catch (error) { return jsonError(`工作流配置无效：${error instanceof Error ? error.message : String(error)}`, 400); }

    const scriptDraftId = body.scriptDraftId === undefined || body.scriptDraftId === null ? null : body.scriptDraftId;
    if (scriptDraftId !== null && (typeof scriptDraftId !== 'string' || !scriptDraftId)) return jsonError('脚本草稿编号无效', 400);
    if (workflowConfig.packageConfig.mode === 'narration' && scriptDraftId === null) return jsonError('口播模式必须选择脚本草稿', 400);
    if (scriptDraftId !== null) {
      const script = db.prepare(`SELECT projectId FROM script_drafts WHERE id = ?`).get(scriptDraftId) as { projectId: string } | undefined;
      if (!script || script.projectId !== projectId) return jsonError('脚本草稿不存在或不属于当前项目', 404);
    }

    const draft = createFinalVideoDraft({ projectId, shotSetId: body.shotSetId, scriptDraftId, workflowConfig });
    return NextResponse.json({ draft: parseDraftResponse(draft) });
  } catch (error) {
    return jsonError(`创建成片草稿失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: projectId } = await params;
    const shotSetId = new URL(request.url).searchParams.get('shotSetId') ?? undefined;
    return NextResponse.json({ drafts: listFinalVideoDrafts(projectId, shotSetId).map(parseDraftResponse) });
  } catch (error) {
    return jsonError(`读取成片草稿失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
