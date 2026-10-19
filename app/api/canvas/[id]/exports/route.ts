import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { canvasStorageRoot } from '@/lib/creative-canvas/assets';
import { createCanvasExport } from '@/lib/creative-canvas/export';
import { assertCanvasApiReady, canvasJsonError, readCanvasJson } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 固定选中节点的当前结果并生成 ZIP；生成完整后才返回可下载入口。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const body = await readCanvasJson(request);
    const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.map((value) => String(value)) : [];
    if (nodeIds.length === 0) throw new CanvasError('invalid_input', '请先选中要打包的结果节点。');
    const record = await createCanvasExport({
      db: getDb(),
      canvasId: id,
      storageRoot: canvasStorageRoot(dataRoot()),
      nodeIds,
    });
    return NextResponse.json({
      export: {
        id: record.id,
        status: record.status,
        manifest: record.manifest,
        downloadUrl: `/api/canvas/exports/${record.id}?download=1`,
      },
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
