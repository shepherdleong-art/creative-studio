import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireCanvasAsset } from '@/lib/creative-canvas/assets';
import { requireCanvasDraftSource, canvasVideoMetadataForAsset } from '@/lib/creative-canvas/video-metadata';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';
export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    await assertCanvasApiReady();
    const { assetId } = await params;
    const asset = requireCanvasAsset(getDb(), assetId);
    const metadata = canvasVideoMetadataForAsset(getDb(), assetId);
    try {
      const source = requireCanvasDraftSource(getDb(), asset.canvasId, assetId);
      return NextResponse.json({ source, metadata });
    } catch (error) {
      return NextResponse.json({ source: null, metadata, reason: (error as Error).message });
    }
  } catch (error) { return canvasJsonError(error); }
}
