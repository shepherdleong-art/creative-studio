import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { importShotSetExternalAssetsFromFormData } from '@/lib/final-edit/material-import-http';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';

export const runtime = 'nodejs';

export async function GET(
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

export async function POST(
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
