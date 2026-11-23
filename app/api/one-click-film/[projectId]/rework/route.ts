import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import {
  adoptCandidate,
  listCandidates,
  listVersions,
  restoreFilmVersion,
  revertAdoption,
  setCandidateTrim,
  type ReworkReference,
} from '@/lib/one-click-film/rework';
import { getRedrawQuote, submitRework, syncRework } from '@/lib/one-click-film/rework-generation';
import { approveHd, currentHdPlan, submitHdConversions, syncHdConversions } from '@/lib/one-click-film/hd-production';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { bodyWithCandidate, getFilmPreview } from '@/lib/one-click-film/composition';

/** 局部返工、等长采用、撤销/恢复与高清来源清单。 */
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
    if (!run) return NextResponse.json({ candidates: [], hd: null });
    await syncRework(db, run);
    syncHdConversions(db, run);
    return NextResponse.json({
      candidates: listCandidates(db, run), hd: currentHdPlan(db, run),
      versions: listVersions(db, run, request.nextUrl.searchParams.get('entryId') ?? ''),
      redraw: getRedrawQuote(db, run, request.nextUrl.searchParams.get('reviewJobId') ?? ''),
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
    const action = String(body.action ?? '');

    if (action === 'create') {
      const references = Array.isArray(body.references) ? body.references as ReworkReference[] : [];
      if (body.redrawPrompt !== undefined && typeof body.redrawPrompt !== 'string') {
        throw new OneClickFilmError('invalid_input', '整条重抽的提示词必须是文本');
      }
      const candidate = await submitRework(db, {
        run,
        reviewJobId: String(body.reviewJobId ?? ''),
        shotId: String(body.shotId ?? ''),
        prompt: String(body.prompt ?? '').trim().slice(0, 4000),
        redrawPrompt: body.redrawPrompt,
        references,
        requestKey: typeof body.requestKey === 'string' ? body.requestKey.slice(0, 100) : undefined,
      });
      return NextResponse.json({ candidate });
    }
    if (action === 'trim') {
      setCandidateTrim(db, { run, candidateId: String(body.candidateId ?? ''), trimStartUs: Number(body.trimStartUs) });
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'preview' || action === 'adopt') {
      const candidateId = String(body.candidateId ?? '');
      const trimStartUs = typeof body.trimStartUs === 'number' ? body.trimStartUs : undefined;
      if (action === 'preview') {
        return NextResponse.json({ previewUrl: await getFilmPreview(db, run, bodyWithCandidate(db, run, candidateId, trimStartUs)) });
      }
      adoptCandidate(db, { run, candidateId, trimStartUs });
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'revert') {
      revertAdoption(db, {
        run,
        entryId: String(body.entryId ?? ''),
        entryCode: String(body.entryCode ?? ''),
        shotId: String(body.shotId ?? ''),
      });
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'versions') {
      return NextResponse.json({ versions: listVersions(db, run, String(body.entryId ?? '')) });
    }
    if (action === 'restore-version') {
      restoreFilmVersion(db, run, String(body.reviewJobId ?? ''), String(body.versionId ?? ''));
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'convert-hd' || action === 'approve-hd') {
      const entryCode = String(body.entryCode ?? '');
      syncHdConversions(db, run);
      if (action === 'convert-hd') await submitHdConversions(db, run, entryCode);
      else await approveHd(db, run, entryCode);
      return NextResponse.json({ hd: currentHdPlan(db, run) });
    }
    throw new OneClickFilmError('invalid_input', '不支持的返工操作');
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/rework', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/rework', 'POST', __teamRoutePOST);
