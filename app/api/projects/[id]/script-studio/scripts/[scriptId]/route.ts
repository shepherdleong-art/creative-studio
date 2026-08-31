import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { getCurrentLibraryRevision } from '@/lib/script-studio/libraries';
import { addProjectScriptRevision, getProjectScript, getProjectScriptRevision } from '@/lib/script-studio/scripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const script = getProjectScript(getDb(), projectId, scriptId);
    if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在');
    const revisionId = new URL(request.url).searchParams.get('revisionId') || '';
    const revision = revisionId ? getProjectScriptRevision(getDb(), projectId, scriptId, revisionId) : null;
    return NextResponse.json({ script, revision });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const body = await jsonOrNull(request);
    if (!body) throw new ScriptStudioError('invalid_input', '请求体必须是 JSON 对象');
    const db = getDb();
    const script = getProjectScript(db, projectId, scriptId);
    if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在');
    const currentLibrary = getCurrentLibraryRevision(db, projectId);
    if (!currentLibrary) throw new ScriptStudioError('not_found', '当前项目没有可复用的卖点库');
    const contentJson = body.contentJson && typeof body.contentJson === 'object'
      ? body.contentJson as Record<string, unknown>
      : {};
    if (!contentJson.segments || !Array.isArray(contentJson.segments)) {
      throw new ScriptStudioError('invalid_input', '人工编辑必须包含完整脚本内容');
    }
    const targetDurationSec = Number(body.targetDurationSec || script.currentRevision?.targetDurationSec || 15);
    const updated = addProjectScriptRevision(db, projectId, scriptId, {
      origin: body.origin === 'ai_regenerate' ? 'ai_regenerate' : 'manual_edit',
      libraryRevisionId: currentLibrary.id,
      templateId: typeof body.templateId === 'string' ? body.templateId : script.currentRevision?.templateId || '',
      templateVersion: Number(body.templateVersion || script.currentRevision?.templateVersion || 1),
      contentJson,
      targetDurationSec,
      estimatedDurationSec: typeof body.estimatedDurationSec === 'number' ? body.estimatedDurationSec : null,
    });
    return NextResponse.json({ script: updated }, { status: 201 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
