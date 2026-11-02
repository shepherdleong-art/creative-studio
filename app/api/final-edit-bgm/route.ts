import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { listReadyFinalEditBgmTracks } from '@/lib/final-edit/bgm';
import { importFinalEditBgmFiles } from '@/lib/final-edit/bgm-import';
import {
  bgmImportResponseStatus,
  importFinalEditBgmFromFormData,
} from '@/lib/final-edit/bgm-import-http';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

async function __teamRoutePOST(request: Request) {
  try {
    const db = getDb();
    const storageRoot = path.join(dataRoot(), 'storage');
    const result = await importFinalEditBgmFromFormData(
      request,
      (files) => importFinalEditBgmFiles({ db, storageRoot }, files),
    );
    const body = {
      ...result,
      tracks: listReadyFinalEditBgmTracks(db),
    };
    const status = bgmImportResponseStatus(result);
    return NextResponse.json(body, { status });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
export const POST = withTeamRoute('/api/final-edit-bgm', 'POST', __teamRoutePOST);
