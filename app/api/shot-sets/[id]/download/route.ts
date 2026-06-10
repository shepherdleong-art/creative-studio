import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildZipStream, ZipImageEntry } from '@/lib/zip-download';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const set = db.prepare(`SELECT id, name FROM shot_sets WHERE id = ?`).get(id) as { id: string; name: string } | undefined;
    if (!set) return NextResponse.json({ error: 'Shot set not found' }, { status: 404 });

    const rows = db.prepare(`
      SELECT s.indexNum, src.filename as sourceFilename, out.path as filePath, out.filename as outputFilename
      FROM shots s
      JOIN image_assets out ON out.id = s.latestGeneratedImageId
      LEFT JOIN image_assets src ON src.id = s.sourceImageId
      WHERE s.shotSetId = ? AND s.latestGeneratedImageId IS NOT NULL
      ORDER BY s.indexNum
    `).all(id) as Array<{ indexNum: number; sourceFilename: string | null; filePath: string; outputFilename: string | null }>;

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No generated shot images to download' }, { status: 404 });
    }

    const entries: ZipImageEntry[] = rows.map((row) => ({
      filePath: row.filePath,
      filename: `${String(row.indexNum).padStart(2, '0')}-${row.outputFilename || row.sourceFilename || 'shot.png'}`,
    }));

    const stream = buildZipStream(entries);
    const zipName = encodeURIComponent(`${set.name || 'shot-set'}-generated.zip`);
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${zipName}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
