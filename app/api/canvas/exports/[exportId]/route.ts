import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { getDb } from '@/lib/db';
import { canvasExportAbsolutePath, requireCanvasExport } from '@/lib/creative-canvas/export';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 查询导出状态；带 ?download=1 时交付完整 ZIP。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ exportId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { exportId } = await params;
    const record = requireCanvasExport(getDb(), exportId);
    const download = new URL(request.url).searchParams.get('download') === '1';
    if (!download) {
      return NextResponse.json({
        export: {
          id: record.id,
          status: record.status,
          manifest: record.manifest,
          errorMessage: record.errorMessage,
          downloadUrl: record.status === 'ready' ? `/api/canvas/exports/${record.id}?download=1` : null,
        },
      });
    }
    if (record.status !== 'ready') {
      return NextResponse.json({ error: 'conflict', message: '导出还没有完成。' }, { status: 409 });
    }
    const absolutePath = canvasExportAbsolutePath(record, `${dataRoot()}/storage`);
    const body = fs.readFileSync(absolutePath);
    const safeName = record.manifest.canvasName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'canvas';
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.zip"`,
      },
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
