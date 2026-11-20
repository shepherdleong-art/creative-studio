import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  applyPromptReview,
  applyScriptPlan,
  getAnalysis,
  getRunForProject,
  listEntries,
  listSellingPoints,
  redraftAll,
  reviewPrompt,
} from '@/lib/one-click-film/store';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/**
 * 脚本阶段：应用数量/结构/声音，整批重写，以及生成设置变化后的提示词复核。
 */
async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
    const run = getRunForProject(db, projectId);
    if (!run) throw new OneClickFilmError('not_found', '项目还没有一键成片记录', 404);
    const body = await readJsonBody(request);
    const action = String(body.action ?? 'apply');

    if (action === 'redraft-all') {
      return NextResponse.json({ entries: redraftAll(db, run) });
    }

    if (action === 'apply-prompt') {
      const code = String(body.code ?? '');
      const durationSec = Number(body.durationSec);
      if (!Number.isInteger(durationSec) || durationSec < 2 || durationSec > 60) {
        throw new OneClickFilmError('invalid_input', '正文时长必须是 2–60 的整数秒');
      }
      const entry = applyPromptReview(db, {
        run, code,
        promptText: String(body.promptText ?? ''),
        durationSec,
        aspectRatio: String(body.aspectRatio ?? '3:4'),
      });
      return NextResponse.json({ entry });
    }

    if (action === 'review-prompt') {
      const durationSec = Number(body.durationSec);
      if (!Number.isInteger(durationSec) || durationSec < 2 || durationSec > 60) {
        throw new OneClickFilmError('invalid_input', '正文时长必须是 2–60 的整数秒');
      }
      return NextResponse.json({
        reviews: reviewPrompt(db, { run, durationSec, aspectRatio: String(body.aspectRatio ?? '3:4') }),
      });
    }

    const analysisId = typeof body.analysisId === 'string' && body.analysisId
      ? body.analysisId
      : run.currentAnalysisId;
    const analysis = analysisId ? getAnalysis(db, analysisId) : null;
    if (!analysis) throw new OneClickFilmError('invalid_input', '请先完成并确认素材分析');
    if (!analysis.confirmedAt) throw new OneClickFilmError('invalid_input', '请先确认产品名称与卖点');

    const result = applyScriptPlan(db, {
      run,
      analysis,
      points: listSellingPoints(db, analysis.id),
      plan: {
        count: body.count,
        plan: body.plan,
        soundMode: body.soundMode,
        durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined,
        aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
        tts: body.tts as { providerId?: string; voice?: string; speed?: number } | undefined,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const run = getRunForProject(db, projectId);
    if (!run) return NextResponse.json({ entries: [] });
    return NextResponse.json({ entries: listEntries(db, run.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/scripts', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/scripts', 'POST', __teamRoutePOST);
