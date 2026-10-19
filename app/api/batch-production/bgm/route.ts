import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { listBatchBgmTracks } from '@/lib/batch-production/bgm';
import { scanFinalEditBgm } from '@/lib/final-edit/bgm';
import {
  BATCH_NO_STORE_HEADERS,
  batchRouteErrorResponse,
} from '../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批量 BGM 曲库:与单条模式共用 storage/bgm/ 与 final_edit_bgm_tracks,不建独立曲库。 */
export async function GET() {
  try {
    await assertBatchApiReady();
    const tracks = listBatchBgmTracks(getDb());
    return NextResponse.json({ tracks, count: tracks.length }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_bgm_list_failed', '曲库列表读取失败');
  }
}

/** 重新扫描 storage/bgm/ 目录(用户放完文件无需重启应用)。 */
export async function POST(request: NextRequest) {
  if (request.headers.get('x-creative-studio-action') !== 'rescan') {
    return NextResponse.json({ error: 'invalid_rescan_request', message: '曲库扫描请求缺少工作台标记' }, {
      status: 403,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    await scanFinalEditBgm(db, path.join(dataRoot(), 'storage'));
    const tracks = listBatchBgmTracks(db);
    return NextResponse.json({ tracks, count: tracks.length }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_bgm_rescan_failed', '曲库重新扫描失败');
  }
}
