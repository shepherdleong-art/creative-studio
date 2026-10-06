import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { canvasStorageRoot, readCanvasAsset, readCanvasAssetPreview } from '@/lib/creative-canvas/assets';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 读取素材内容：经过所属画布与文件边界检查，视频支持 Range 按需加载。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { assetId } = await params;
    const download = new URL(request.url).searchParams.get('download') === '1';
    const result = await (download ? readCanvasAsset : readCanvasAssetPreview)({
      db: getDb(),
      storageRoot: canvasStorageRoot(dataRoot()),
      assetId,
      rangeHeader: request.headers.get('range'),
    });
    if (result.status === 416 || !result.body) {
      return new NextResponse(null, { status: 416, headers: result.headers });
    }
    const headers = { ...result.headers };
    if (new URL(request.url).searchParams.get('download') === '1') {
      // 单文件下载：文件名按节点当前结果的真实媒体类型给出，不用缩略图代替成品
      const extension = result.filePath.slice(result.filePath.lastIndexOf('.'));
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(assetId)}${extension}"`;
    }
    return new NextResponse(new Uint8Array(result.body), {
      status: result.status,
      headers,
    });
  } catch (error) {
    if (error instanceof CanvasError) {
      return canvasJsonError(error);
    }
    return canvasJsonError(error);
  }
}
