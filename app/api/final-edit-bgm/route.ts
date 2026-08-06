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
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
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
