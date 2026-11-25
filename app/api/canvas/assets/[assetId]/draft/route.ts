import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireCanvasAsset } from '@/lib/creative-canvas/assets';
import { requireCanvasDraftSource, canvasVideoMetadataForAsset, canvasVideoResultInfo } from '@/lib/creative-canvas/video-metadata';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';
async function __teamRouteGET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    await assertCanvasApiReady();
    const { assetId } = await params;
    const db = getDb();
    const asset = requireCanvasAsset(db, assetId);
    const metadata = canvasVideoMetadataForAsset(db, assetId);
    const result = asset.mediaKind === 'video' ? canvasVideoResultInfo(db, asset.canvasId, assetId) : null;
    try {
      const source = requireCanvasDraftSource(db, asset.canvasId, assetId);
      return NextResponse.json({ source, metadata, result });
    } catch (error) {
      return NextResponse.json({ source: null, metadata, result, reason: (error as Error).message });
    }
  } catch (error) { return canvasJsonError(error); }
}
export const GET = withTeamRoute('/api/canvas/assets/[assetId]/draft', 'GET', __teamRouteGET);
