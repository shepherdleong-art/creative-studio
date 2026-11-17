import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { packagingPreviewAssetResponse } from '@/lib/media-core/packaging-preview-resources';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function resource(_request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  try {
    const { id, path } = await params;
    return packagingPreviewAssetResponse(getFinalEditWorkspace().load(id).packaging, path);
  } catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/final-edit-groups/[id]/packaging-layout-resources/[...path]', 'GET', resource);
