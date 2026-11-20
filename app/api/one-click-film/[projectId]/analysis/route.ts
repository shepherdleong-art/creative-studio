import { tryFilmRequestLock } from '@/lib/one-click-film/request-lock';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  confirmAnalysis,
  createAnalysisVersion,
  getAnalysis,
  getOrCreateRun,
  getRunForProject,
  listSellingPoints,
  replaceSellingPoints,
} from '@/lib/one-click-film/store';
import { runOneClickFilmAnalysis } from '@/lib/one-click-film/analysis';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { validateConfirmation } from '@/lib/one-click-film/selling-points';

/**
 * 分析：发起 / 确认。
 *
 * - POST { action: 'analyze', imageIds, providerId? }：换图后重新分析会追加新版本；
 *   同一组图片重复提交返回已有结果，不重复计费。
 * - POST { action: 'confirm', analysisId, productName, points }：写入选用文字与来源。
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
    const body = await readJsonBody(request);
    const action = String(body.action ?? 'analyze');
    const run = getRunForProject(db, projectId) ?? getOrCreateRun(db, projectId);

    if (action === 'confirm') {
      const analysisId = typeof body.analysisId === 'string' ? body.analysisId : '';
      const analysis = getAnalysis(db, analysisId);
      if (!analysis || analysis.runId !== run.id) {
        throw new OneClickFilmError('not_found', '分析版本不存在或不属于当前项目', 404);
      }
      const rawPoints = Array.isArray(body.points) ? body.points : [];
      const existing = listSellingPoints(db, analysisId);
      const merged = existing.map((point, index) => {
        const incoming = rawPoints[index] as Record<string, unknown> | undefined;
        return {
          ...point,
          text: typeof incoming?.text === 'string' && incoming.text.trim() ? incoming.text.trim() : point.text,
          selected: incoming?.selected === undefined ? point.selected : incoming.selected !== false,
          edited: true,
        };
      });
      const confirmed = validateConfirmation({
        productName: typeof body.productName === 'string' ? body.productName : analysis.productName,
        points: merged,
      });
      const updated = confirmAnalysis(db, {
        analysisId,
        productName: confirmed.productName,
        points: merged,
      });
      return NextResponse.json({
        analysis: { ...updated, points: listSellingPoints(db, updated.id) },
        confirmed,
      });
    }

    const imageIds = Array.isArray(body.imageIds)
      ? body.imageIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
    if (imageIds.length === 0) throw new OneClickFilmError('invalid_input', '请先上传至少一份素材再分析');
    const owned = db.prepare(`
      SELECT COUNT(*) AS n FROM image_assets WHERE projectId = ? AND role = 'input' AND id IN (${imageIds.map(() => '?').join(',')})
    `).get(projectId, ...imageIds) as { n: number };
    if (owned.n !== new Set(imageIds).size) {
      throw new OneClickFilmError('invalid_input', '存在不属于当前项目的素材图片');
    }

    const lock = await tryFilmRequestLock('analysis', [run.id, ...imageIds]);
    try {
      const previous = db.prepare(`
        SELECT id, status FROM one_click_film_analyses
        WHERE runId=? AND status IN ('running','succeeded') AND sourceImageIdsJson=?
        ORDER BY versionNumber DESC LIMIT 1
      `).get(run.id, JSON.stringify(imageIds)) as { id: string; status: string } | undefined;
      if (!lock || previous?.status === 'succeeded') {
        if (!previous) throw new OneClickFilmError('conflict', '分析正在启动，请稍后刷新', 409);
        if (lock) db.prepare('UPDATE one_click_film_runs SET currentAnalysisId=? WHERE id=?').run(previous.id, run.id);
        return NextResponse.json({ analysis: { ...getAnalysis(db, previous.id), points: listSellingPoints(db, previous.id) }, reused: true });
      }
      const analysis = previous ? getAnalysis(db, previous.id)! : createAnalysisVersion(db, {
        run, sourceImageIds: imageIds, status: 'running',
        providerId: typeof body.providerId === 'string' ? body.providerId : '',
      });
      if (previous) db.prepare('UPDATE one_click_film_runs SET currentAnalysisId=? WHERE id=?').run(analysis.id, run.id);
      try {
        const finished = await runOneClickFilmAnalysis({ analysisId: analysis.id, providerId: analysis.providerId || undefined, db });
        return NextResponse.json({ analysis: { ...finished, points: listSellingPoints(db, finished.id) } });
      } catch (error) {
        const failed = getAnalysis(db, analysis.id);
        return NextResponse.json({
          analysis: failed ? { ...failed, points: listSellingPoints(db, failed.id) } : null,
          error: 'analysis_failed', message: error instanceof Error ? error.message : String(error),
        }, { status: 502 });
      }
    } finally {
      lock?.release();
    }
  } catch (error) {
    return jsonError(error);
  }
}

/** 未确认的分析可以保存草稿，已确认的分析只能另存新版本。 */
async function __teamRoutePATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
    const body = await readJsonBody(request);
    const analysisId = typeof body.analysisId === 'string' ? body.analysisId : '';
    const analysis = getAnalysis(db, analysisId);
    if (!analysis || analysis.projectId !== projectId) {
      throw new OneClickFilmError('not_found', '分析版本不存在或不属于当前项目', 404);
    }
    if (analysis.confirmedAt) throw new OneClickFilmError('invalid_input', '请通过确认创建新的卖点版本');
    const rawPoints = Array.isArray(body.points) ? body.points : [];
    const merged = listSellingPoints(db, analysisId).map((point, index) => {
      const incoming = rawPoints[index] as Record<string, unknown> | undefined;
      return {
        ...point,
        text: typeof incoming?.text === 'string' && incoming.text.trim() ? incoming.text.trim() : point.text,
        selected: incoming?.selected === undefined ? point.selected : incoming.selected !== false,
        edited: true,
      };
    });
    replaceSellingPoints(db, analysisId, merged);
    return NextResponse.json({ analysis: { ...analysis, points: merged } });
  } catch (error) {
    return jsonError(error);
  }
}

export const POST = withTeamRoute('/api/one-click-film/[projectId]/analysis', 'POST', __teamRoutePOST);
export const PATCH = withTeamRoute('/api/one-click-film/[projectId]/analysis', 'PATCH', __teamRoutePATCH);
