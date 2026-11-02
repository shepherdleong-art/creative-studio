import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { importShotSetExternalAssetsFromFormData } from '@/lib/final-edit/material-import-http';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

async function __teamRouteGET(
  _request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string }> },
) {
  try {
    const { id: projectId, shotSetId } = await params;
    return NextResponse.json({ assets: getFinalEditWorkspace().listShotSetExternalAssets(projectId, shotSetId) });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}

async function __teamRoutePOST(
  request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string }> },
) {
  try {
    const { id: projectId, shotSetId } = await params;
    const workspace = getFinalEditWorkspace();
    const result = await importShotSetExternalAssetsFromFormData(
      request,
      (files, signal) => workspace.importShotSetExternalAssets({ projectId, shotSetId, files, signal }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
export const GET = withTeamRoute('/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets', 'POST', __teamRoutePOST);
