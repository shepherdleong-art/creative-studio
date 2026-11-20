import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import { exportEligibility, exportEntries, listExports } from '@/lib/one-click-film/exports';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { listPackaging } from '@/lib/one-click-film/packaging';
import { renderFilmPackaging } from '@/lib/one-click-film/packaging-render';

/** 已导出成片总览与导出提交。 */
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
    return NextResponse.json({
      exports: run ? listExports(db, run) : [],
      eligibility: run ? exportEligibility(db, run) : [],
    });
  } catch (error) {
    return jsonError(error);
  }
}

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
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : undefined;
    const records = listPackaging(db, run).filter((record) => body.all === true || codes?.includes(record.entryCode));
    if (records.length === 0) throw new OneClickFilmError('invalid_input', '请先选择要导出的成片');
    const revisions = body.revisions && typeof body.revisions === 'object' ? body.revisions as Record<string, unknown> : null;
    if (revisions && records.some((record) => revisions[record.entryCode] !== record.revision)) {
      throw new OneClickFilmError('conflict', '选中的包装草稿已更新，请确认后再导出', 409);
    }
    const rendered: string[] = [];
    const failed: Array<{ entryCode: string; reason: string }> = [];
    for (const record of records) {
      try {
        if (!record.canExport) throw new Error(record.reason || '成片待复核');
        await renderFilmPackaging(db, run, record.entryCode, false, record.revision);
        rendered.push(record.entryCode);
      } catch (cause) {
        failed.push({ entryCode: record.entryCode, reason: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    const current = new Map(listPackaging(db, run).map((record) => [record.entryCode, record]));
    const unchanged = rendered.filter((code) => {
      if (current.get(code)?.revision === records.find((record) => record.entryCode === code)?.revision) return true;
      failed.push({ entryCode: code, reason: '包装草稿已更新，请确认后再导出' });
      return false;
    });
    const result = unchanged.length ? exportEntries(db, { run, codes: unchanged, all: false }) : { exported: [], failed: [], reused: [] };
    result.failed.push(...failed);
    return NextResponse.json({ ...result, exports: listExports(db, run) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/exports', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/exports', 'POST', __teamRoutePOST);
