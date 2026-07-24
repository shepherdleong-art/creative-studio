import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { readShotSetExternalAssetImportFormData } from '@/lib/final-edit/material-import-http';
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
    const { files } = await readShotSetExternalAssetImportFormData(request);
    const result = await getFinalEditWorkspace().importShotSetExternalAssets({ projectId, shotSetId, files });
    if (!result.assets.some((asset) => asset.status === 'ready')) {
      return NextResponse.json({
        error: 'external_asset_import_failed',
        message: '没有文件导入成功',
        ...result,
      }, { status: 400 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
