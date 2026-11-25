import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  applyPromptReview,
  applyScriptPlan,
  confirmEntry,
  getAnalysis,
  getRunForProject,
  listEntries,
  listScriptRevisions,
  restoreRetiredScripts,
  listSellingPoints,
  reviewPrompt,
} from '@/lib/one-click-film/store';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { generatePlanCopies, generateRedraft } from '@/lib/one-click-film/script-generation';

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

    if (action === 'restore-retired') {
      return NextResponse.json({ entries: restoreRetiredScripts(db, run, String(body.code ?? '')) });
    }

    if (action === 'redraft-all') {
      for (const entry of listEntries(db, run.id)) await generateRedraft(db, run, entry.code);
      return NextResponse.json({ entries: listEntries(db, run.id) });
    }

    if (action === 'apply-prompt') {
      const code = String(body.code ?? '');
      const durationSec = Number(body.durationSec);
      if (!Number.isInteger(durationSec) || durationSec < 2 || durationSec > 60) {
        throw new OneClickFilmError('invalid_input', '正文时长必须是 2–60 的整数秒');
      }
      const entry = db.transaction(() => {
        applyPromptReview(db, {
          run, code, promptText: String(body.promptText ?? ''), durationSec,
          aspectRatio: String(body.aspectRatio ?? '3:4'),
        });
        return confirmEntry(db, { run, code });
      }).immediate();
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
    if (!analysis || analysis.runId !== run.id || analysis.id !== run.currentAnalysisId) {
      throw new OneClickFilmError('invalid_input', '请先完成并确认当前项目的最新素材分析');
    }
    if (!analysis.confirmedAt) throw new OneClickFilmError('invalid_input', '请先确认产品名称与卖点');

    const input = {
      run,
      analysis,
      points: listSellingPoints(db, analysis.id),
      plan: {
        count: body.count,
        plan: body.plan,
        soundMode: body.soundMode,
        modelPreset: body.modelPreset,
        modelCustom: body.modelCustom,
        preserveIndividualModel: body.preserveIndividualModel === true,
        durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined,
        aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
        tts: body.tts as { providerId?: string; voice?: string; speed?: number } | undefined,
      },
    };
    const copies = await generatePlanCopies(db, input);
    const result = applyScriptPlan(db, { ...input, copies });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

async function __teamRouteGET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const run = getRunForProject(db, projectId);
    const history = request.nextUrl.searchParams.get('history');
    if (history) return NextResponse.json({ revisions: run ? listScriptRevisions(db, run.id, history) : [] });
    if (!run) return NextResponse.json({ entries: [] });
    return NextResponse.json({ entries: listEntries(db, run.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/scripts', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/scripts', 'POST', __teamRoutePOST);
