import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  assertFixtureReleaseUploadAllowed,
  listTeamReleaseUploadFailures,
  readCurrentTeamReleaseVersion,
  receiveTeamReleaseArchive,
  recordTeamReleaseUploadFailure,
  teamReleaseCandidateRoot,
} from '@/lib/team-service/release-candidates';
import {
  listTeamReleaseCandidates,
  prepareTeamReleaseCandidate,
} from '@/lib/team-service/maintenance/release-candidates';

async function __teamRouteGET(): Promise<Response> {
  try {
    if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
    const current = await readCurrentTeamReleaseVersion();
    return Response.json({
      current,
      candidates: await listTeamReleaseCandidates(teamReleaseCandidateRoot(), current, assertFixtureReleaseUploadAllowed()),
      failures: await listTeamReleaseUploadFailures(),
      executableUpgrade: true,
      note: '上传只准备候选；管理员另行确认版本和维护影响后，才由独立执行器升级。',
    });
  } catch (error) {
    return Response.json({ error: 'release_preview_unavailable', message: error instanceof Error ? error.message : '无法读取版本预览。' }, { status: 503 });
  }
}

async function __teamRoutePOST(request: Request): Promise<Response> {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  const requestedBy = requireAccessContext().actor.userId;
  try {
    const current = await readCurrentTeamReleaseVersion();
    const incoming = await receiveTeamReleaseArchive(request);
    try {
      const candidate = await prepareTeamReleaseCandidate({
        candidateRoot: teamReleaseCandidateRoot(), archivePath: incoming.archivePath,
        originalName: incoming.originalName, requestedBy, current,
        allowFixtureForTests: assertFixtureReleaseUploadAllowed(),
      });
      return Response.json({ candidate }, { status: candidate.status === 'ready' ? 201 : 422 });
    } finally {
      await incoming.cleanup();
    }
  } catch (error) {
    const failure = await recordTeamReleaseUploadFailure(requestedBy, error);
    return Response.json({ error: failure.code, message: failure.message, uploadId: failure.uploadId }, { status: 422 });
  }
}

export const GET = withTeamRoute('/api/team/release-candidates', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/release-candidates', 'POST', __teamRoutePOST);
