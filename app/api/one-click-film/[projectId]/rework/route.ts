import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import {
  adoptCandidate,
  createCandidate,
  listCandidates,
  listVersions,
  revertAdoption,
  setCandidateResult,
  setCandidateTrim,
  type ReworkReference,
} from '@/lib/one-click-film/rework';
import { planHdSources, registerHdSources } from '@/lib/one-click-film/hd';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** 局部返工、等长采用、撤销/恢复与高清来源清单。 */
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
    if (!run) return NextResponse.json({ candidates: [], hd: null });
    let hd = null;
    try { hd = planHdSources(db, run); } catch { hd = null; }
    return NextResponse.json({ candidates: listCandidates(db, run), hd });
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
      const candidate = createCandidate(db, {
        run,
        entryId: String(body.entryId ?? ''),
        entryCode: String(body.entryCode ?? ''),
        reviewJobId: String(body.reviewJobId ?? ''),
        shotId: String(body.shotId ?? ''),
        replaceStartUs: Number(body.replaceStartUs),
        replaceEndUs: Number(body.replaceEndUs),
        minimumGenerationUs: Number(body.minimumGenerationUs) || undefined,
        prompt: String(body.prompt ?? ''),
        references,
        providerId: String(body.providerId ?? ''),
        model: String(body.model ?? ''),
      });
      return NextResponse.json({ candidate });
    }
    if (action === 'result') {
      setCandidateResult(db, {
        run,
        candidateId: String(body.candidateId ?? ''),
        status: body.status === 'ready' ? 'ready' : body.status === 'failed' ? 'failed' : 'running',
        localVideoPath: typeof body.localVideoPath === 'string' ? body.localVideoPath : undefined,
        durationUs: Number(body.durationUs) || undefined,
        errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
      });
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'trim') {
      setCandidateTrim(db, { run, candidateId: String(body.candidateId ?? ''), trimStartUs: Number(body.trimStartUs) });
      return NextResponse.json({ candidates: listCandidates(db, run) });
    }
    if (action === 'adopt') {
      adoptCandidate(db, { run, candidateId: String(body.candidateId ?? '') });
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
    if (action === 'plan-hd') {
      const plan = planHdSources(db, run);
      if (body.register === true) registerHdSources(db, { run, sources: plan.sources });
      return NextResponse.json({ hd: plan });
    }
    throw new OneClickFilmError('invalid_input', '不支持的返工操作');
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/rework', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/rework', 'POST', __teamRoutePOST);
