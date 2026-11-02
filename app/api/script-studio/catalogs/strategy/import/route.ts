import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, readCatalogImportUpload } from '@/lib/script-studio/http';
import { importStrategyCatalog } from '@/lib/script-studio/catalog-service';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

async function __teamRoutePOST(request: NextRequest) {
  try {
    await assertScriptStudioApiReady();
    const upload = await readCatalogImportUpload(request);
    if ('error' in upload) return upload.error;
    const buffer = Buffer.from(await upload.file.arrayBuffer());
    const outcome = await importStrategyCatalog(getDb(), buffer, upload.file.name);
    return NextResponse.json(outcome, { status: outcome.created ? 201 : 200 });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
export const POST = withTeamRoute('/api/script-studio/catalogs/strategy/import', 'POST', __teamRoutePOST);
