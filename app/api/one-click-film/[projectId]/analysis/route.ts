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
        analysis: { ...updated, points: listSellingPoints(db, analysisId) },
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

    // 同一组图片已有成功结果：直接复用，重复提交不重复计费。
    const reusable = db.prepare(`
      SELECT id FROM one_click_film_analyses
      WHERE runId = ? AND status = 'succeeded' AND sourceImageIdsJson = ?
      ORDER BY versionNumber DESC LIMIT 1
    `).get(run.id, JSON.stringify(imageIds)) as { id: string } | undefined;
    if (reusable) {
      const existing = getAnalysis(db, reusable.id)!;
      return NextResponse.json({ analysis: { ...existing, points: listSellingPoints(db, existing.id) }, reused: true });
    }

    const analysis = createAnalysisVersion(db, {
      run,
      sourceImageIds: imageIds,
      status: 'running',
      providerId: typeof body.providerId === 'string' ? body.providerId : '',
    });
    try {
      const finished = await runOneClickFilmAnalysis({
        analysisId: analysis.id,
        providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
        db,
      });
      return NextResponse.json({ analysis: { ...finished, points: listSellingPoints(db, finished.id) } });
    } catch (error) {
      const failed = getAnalysis(db, analysis.id);
      return NextResponse.json({
        analysis: failed ? { ...failed, points: listSellingPoints(db, failed.id) } : null,
        error: 'analysis_failed',
        message: error instanceof Error ? error.message : String(error),
      }, { status: 502 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

/** 手动改卖点文字/勾选：只更新当前分析版本，不新建版本。 */
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
