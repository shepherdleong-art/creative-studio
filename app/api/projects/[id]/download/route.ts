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
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as { id: string; name: string } | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const rows = db.prepare(`
      SELECT oa.path as filePath, oa.filename as filename, ia.filename as inputFilename, j.revision
      FROM jobs j
      JOIN image_assets oa ON oa.id = j.outputImageId
      LEFT JOIN image_assets ia ON ia.id = j.inputImageId
      WHERE j.projectId = ? AND j.status = 'succeeded' AND j.outputImageId IS NOT NULL
      ORDER BY ia.filename, j.revision, j.id
    `).all(id) as Array<{ filePath: string; filename: string; inputFilename: string | null; revision: number | null }>;

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No generated images to download' }, { status: 404 });
    }

    const entries: ZipImageEntry[] = rows.map((row, index) => ({
      filePath: row.filePath,
      filename: row.filename || `${String(index + 1).padStart(2, '0')}-${row.inputFilename || 'output'}.png`,
    }));

    const stream = buildZipStream(entries);
    const zipName = encodeURIComponent(`${project.name || 'project'}-outputs.zip`);
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
