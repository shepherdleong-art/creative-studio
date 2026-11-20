import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  getCurrentAnalysis,
  findRunForProject,
  listAnalyses,
  listEntries,
  listSellingPoints,
} from '@/lib/one-click-film/store';
import { assertOneClickFilmApiReady, jsonError } from '@/lib/one-click-film/http';

/**
 * 一键成片项目上下文：返回 run、分析版本、当前卖点与脚本条目。
 * 页面每次进入都用这一份状态恢复「上传 → 分析 → 脚本」三个子页。
 */
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

    const project = db.prepare(`
      SELECT p.id, p.name, p.storeCode, p.productCode, p.productSubmodel, p.productionType, p.editorName, p.createdAt
      FROM projects p WHERE p.id = ?
    `).get(projectId) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'not_found', message: '项目不存在' }, { status: 404 });

    const images = (db.prepare(`
      SELECT id, filename, usage, role, path
      FROM image_assets WHERE projectId = ? AND role = 'input'
      ORDER BY createdAt ASC
    `).all(projectId) as Array<{ id: string; filename: string; usage: string; role: string; path: string }>)
      .map((image) => ({
        id: image.id,
        filename: image.filename,
        usage: image.usage || '',
        url: `/api/images/${image.path.replace(/^.*storage[\\/]/, '').split(/[\\/]/).map(encodeURIComponent).join('/')}`,
      }));

    // 只读：已有记录直接返回；没有则返回空状态，由首次上传或分析时创建。
    const run = findRunForProject(db, projectId);
    if (!run) {
      return NextResponse.json({
        project,
        run: null,
        images,
        analyses: [],
        analysis: null,
        entries: [],
      });
    }
    const current = getCurrentAnalysis(db, run);

    return NextResponse.json({
      project,
      run: { id: run.id, currentAnalysisId: run.currentAnalysisId },
      images,
      analyses: listAnalyses(db, run.id).map((analysis) => ({
        id: analysis.id,
        versionNumber: analysis.versionNumber,
        status: analysis.status,
        productName: analysis.productName,
        confirmedAt: analysis.confirmedAt,
        errorMessage: analysis.errorMessage,
        createdAt: analysis.createdAt,
      })),
      analysis: current ? {
        ...current,
        points: listSellingPoints(db, current.id),
      } : null,
      entries: listEntries(db, run.id),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]', 'GET', __teamRouteGET);
