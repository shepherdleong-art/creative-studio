import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { canvasStorageRoot, importCanvasAsset } from '@/lib/creative-canvas/assets';
import { requireCanvas } from '@/lib/creative-canvas/repository';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 导入本地素材：只接受上传文件，不接受客户端传来的任意本机路径。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    requireCanvas(getDb(), id);

    let file: File | null = null;
    try {
      const formData = await request.formData();
      file = formData.get('file') instanceof File ? formData.get('file') as File : null;
    } catch {
      file = null;
    }
    if (!file) throw new CanvasError('invalid_input', '缺少上传文件。');

    const data = Buffer.from(await file.arrayBuffer());
    const asset = await importCanvasAsset({
      db: getDb(),
      canvasId: id,
      storageRoot: canvasStorageRoot(dataRoot()),
      filename: file.name || 'upload',
      mimeType: file.type || '',
      data,
    });

    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return canvasJsonError(error);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    requireCanvas(getDb(), id);
    const rows = getDb().prepare(
      `SELECT id, canvasId, mediaKind, mimeType, byteSize, width, height, durationSec, ready, createdAt
         FROM creative_canvas_assets WHERE canvasId = ? ORDER BY createdAt DESC`,
    ).all(id);
    return NextResponse.json({ assets: rows });
  } catch (error) {
    return canvasJsonError(error);
  }
}
