import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, ZipImageEntry } from '@/lib/zip-download';

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
      SELECT
        s.indexNum,
        src.filename as sourceFilename,
        out.path as filePath,
        out.filename as outputFilename,
        CASE WHEN s.latestGeneratedImageId = COALESCE(c.imageAssetId, s.latestGeneratedImageId) THEN 1 ELSE 0 END as isSelected
      FROM shots s
      LEFT JOIN shot_result_candidates c ON c.shotId = s.id
      JOIN image_assets out ON out.id = COALESCE(c.imageAssetId, s.latestGeneratedImageId)
      LEFT JOIN image_assets src ON src.id = s.sourceImageId
      WHERE s.shotSetId = ? AND (c.imageAssetId IS NOT NULL OR s.latestGeneratedImageId IS NOT NULL)
      ORDER BY s.indexNum, c.createdAt
    `).all(id) as Array<{ indexNum: number; sourceFilename: string | null; filePath: string; outputFilename: string | null; isSelected: number }>;

    const resultCountByShot = new Map<number, number>();
    const entries: ZipImageEntry[] = rows.map((row) => {
      const nextCount = (resultCountByShot.get(row.indexNum) || 0) + 1;
      resultCountByShot.set(row.indexNum, nextCount);
      return {
        filePath: row.filePath,
        filename: `${String(row.indexNum).padStart(2, '0')}-result-${String(nextCount).padStart(2, '0')}${row.isSelected ? '-selected' : ''}-${row.outputFilename || row.sourceFilename || 'shot.png'}`,
      };
    });

    // Include succeeded video files
    const videoRows = db.prepare(`
      SELECT vj.shotId, vj.filename, vj.localVideoPath, s.indexNum
      FROM video_jobs vj
      JOIN shots s ON s.id = vj.shotId
      WHERE vj.shotSetId = ? AND vj.status = 'succeeded' AND vj.localVideoPath IS NOT NULL
      ORDER BY s.indexNum, vj.createdAt
    `).all(id) as Array<{ shotId: string; filename: string | null; localVideoPath: string; indexNum: number }>;

    for (const v of videoRows) {
      entries.push({
        filePath: v.localVideoPath,
        filename: `${String(v.indexNum).padStart(2, '0')}-${v.filename || 'video.mp4'}`,
      });
    }

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No generated shot images to download' }, { status: 404 });
    }

    const stream = buildGenericZipStream(entries);
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
