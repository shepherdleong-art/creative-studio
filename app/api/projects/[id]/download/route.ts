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
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as { id: string; name: string } | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // ── Generated images ──
    const imageRows = db.prepare(`
      SELECT oa.path as filePath, oa.filename as filename, ia.filename as inputFilename, j.revision
      FROM jobs j
      JOIN image_assets oa ON oa.id = j.outputImageId
      LEFT JOIN image_assets ia ON ia.id = j.inputImageId
      WHERE j.projectId = ? AND j.status = 'succeeded' AND j.outputImageId IS NOT NULL
      ORDER BY ia.filename, j.revision, j.id
    `).all(id) as Array<{ filePath: string; filename: string; inputFilename: string | null; revision: number | null }>;

    const entries: ZipImageEntry[] = imageRows.map((row, index) => ({
      filePath: row.filePath,
      filename: `images/${row.filename || `${String(index + 1).padStart(2, '0')}-${row.inputFilename || 'output'}.png`}`,
    }));

    // ── Generated videos ──
    const videoRows = db.prepare(`
      SELECT vj.filename, vj.localVideoPath,
             s.indexNum, ss.name as shotSetName,
             vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN shots s ON s.id = vj.shotId
      LEFT JOIN shot_sets ss ON ss.id = vj.shotSetId
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.projectId = ? AND vj.status = 'succeeded' AND vj.localVideoPath IS NOT NULL
      ORDER BY ss.createdAt, s.indexNum, vj.createdAt
    `).all(id) as Array<{
      filename: string | null;
      localVideoPath: string;
      indexNum: number | null;
      shotSetName: string | null;
      providerName: string | null;
      templateName: string | null;
    }>;

    videoRows.forEach((row, index) => {
      const shotPart = row.indexNum != null ? `shot-${String(row.indexNum).padStart(2, '0')}` : `video-${String(index + 1).padStart(2, '0')}`;
      const providerPart = (row.providerName || 'provider').replace(/\s+/g, '-');
      const name = row.filename || 'video.mp4';
      entries.push({
        filePath: row.localVideoPath,
        filename: `videos/${shotPart}-${providerPart}-${name}`,
      });
    });

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No generated images or videos to download' }, { status: 404 });
    }

    const stream = buildGenericZipStream(entries);
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
