import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import {
  assertScriptStudioApiReady,
  errorResponse,
  jsonOrNull,
} from '@/lib/script-studio/http';
import {
  approveDistilledPoint,
  countDistilledStatus,
  editDistilledPoint,
  listDistilledPointsForRevision,
} from '@/lib/script-studio/distillation';
import { getCurrentLibraryRevision, getLibraryRevision } from '@/lib/script-studio/libraries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const db = getDb();
    const url = new URL(request.url);
    const revisionId = url.searchParams.get('revisionId');
    const revision = revisionId
      ? getLibraryRevision(db, projectId, revisionId)
      : getCurrentLibraryRevision(db, projectId);
    if (!revision) throw new ScriptStudioError('not_found', '卖点库修订不存在');
    const points = listDistilledPointsForRevision(db, projectId, revision.id);
    return NextResponse.json({
      revisionId: revision.id,
      points,
      stats: {
        ...countDistilledStatus(points),
        factCount: revision.sellingPoints.length,
      },
    });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const body = await jsonOrNull(request);
    const action = typeof body?.action === 'string' ? body.action : '';
    const distilledPointId = typeof body?.distilledPointId === 'string' ? body.distilledPointId : '';
    if (!distilledPointId) throw new ScriptStudioError('invalid_input', '缺少提炼卖点 ID');
    if (action === 'approve') {
      // draft → approved 只能由用户显式确认触发（方案 §3.3 / B8）。
      const point = approveDistilledPoint(getDb(), projectId, distilledPointId, () => new Date());
      if (!point) throw new ScriptStudioError('not_found', '提炼卖点不存在');
      return NextResponse.json({ point }, { status: 200 });
    }
    if (action === 'edit') {
      // 手动编辑（方案 §3.3）：旧值进编辑历史，新值回到 draft，需重新确认。
      const point = editDistilledPoint(
        getDb(),
        projectId,
        distilledPointId,
        {
          shortCopy: typeof body?.shortCopy === 'string' ? body.shortCopy : undefined,
          benefitText: typeof body?.benefitText === 'string' ? body.benefitText : undefined,
        },
        () => new Date(),
      );
      if (!point) throw new ScriptStudioError('invalid_input', '编辑内容为空或提炼卖点不存在');
      return NextResponse.json({ point }, { status: 200 });
    }
    throw new ScriptStudioError('invalid_input', '仅支持 approve / edit 操作');
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
