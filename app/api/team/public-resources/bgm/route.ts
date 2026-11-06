import path from 'node:path';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { listReadyFinalEditBgmTracks } from '@/lib/final-edit/bgm';
import { importFinalEditBgmFiles } from '@/lib/final-edit/bgm-import';
import { importFinalEditBgmFromFormData, bgmImportResponseStatus } from '@/lib/final-edit/bgm-import-http';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { requirePrincipal } from '@/lib/team-service/auth/request';
import { publishTeamResource } from '@/lib/team-service/files/publication';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';
function tracks() {
  const db = getDb();
  return listReadyFinalEditBgmTracks(db).map(({ id, filename, durationUs }) => ({
    id, filename, durationUs,
    published: db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType='bgm' AND resourceId=?").pluck().get(id) === 'public',
  }));
}
async function read() {
  return Response.json({ tracks: tracks() }, { headers: { 'Cache-Control': 'no-store' } });
}
async function upload(request: Request) {
  try {
    const db = getDb();
    const principal = requirePrincipal(request, { admin: true });
    const result = await importFinalEditBgmFromFormData(request, async (files) => {
      const batch = await importFinalEditBgmFiles({ db, storageRoot: path.join(dataRoot(), 'storage') }, files);
      for (const track of [...batch.imported, ...batch.reused]) publishTeamResource(db, principal, { resourceType: 'bgm', resourceId: track.id });
      return batch;
    });
    return Response.json({ ...result, tracks: tracks() }, { status: bgmImportResponseStatus(result), headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/team/public-resources/bgm', 'GET', read);
export const POST = withTeamRoute('/api/team/public-resources/bgm', 'POST', upload);
