import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const set = db.prepare(`SELECT * FROM shot_sets WHERE id = ?`).get(id);
    if (!set) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });

    const shots = db.prepare(`
      SELECT s.*,
        sia.filename as sourceFilename,
        sia.path as sourcePath,
        gia.filename as generatedFilename,
        j.status as jobStatus,
        j.outputImageId,
        j.prompt as jobPrompt,
        j.referenceImageIds,
        j.providerId,
        j.model,
        j.size,
        j.quality
      FROM shots s
      LEFT JOIN image_assets sia ON s.sourceImageId = sia.id
      LEFT JOIN image_assets gia ON s.latestGeneratedImageId = gia.id
      LEFT JOIN jobs j ON s.latestJobId = j.id
      WHERE s.shotSetId = ?
      ORDER BY s.indexNum
    `).all(id);

    const storageRoot = path.resolve(process.cwd(), 'storage');

    // Fetch attached scene reference image info
    let sceneRefName: string | null = null;
    let sceneRefImageUrl: string | null = null;
    const shotSetRecord = set as { sceneReferenceId?: string };
    if (shotSetRecord.sceneReferenceId) {
      const sceneRef = db.prepare(`
        SELECT sr.name, ia.path as imagePath
        FROM scene_references sr
        LEFT JOIN image_assets ia ON sr.imageAssetId = ia.id
        WHERE sr.id = ?
      `).get(shotSetRecord.sceneReferenceId) as { name?: string; imagePath?: string } | undefined;
      if (sceneRef?.imagePath) {
        sceneRefName = sceneRef?.name || null;
        sceneRefImageUrl = `/api/images/${path.relative(storageRoot, path.resolve(sceneRef.imagePath)).split(path.sep).join('/')}`;
      }
    }

    const shotsWithUrls = (shots as Array<Record<string, unknown>>).map((s) => {
      const sourceUrl = s.sourcePath ? `/api/images/${path.relative(storageRoot, path.resolve(s.sourcePath as string)).split(path.sep).join('/')}` : '';
      const genAsset = db.prepare(`SELECT path FROM image_assets WHERE id = ?`).get(s.latestGeneratedImageId) as { path?: string } | undefined;
      let generatedUrl = '';
      if (genAsset?.path) {
        generatedUrl = `/api/images/${path.relative(storageRoot, path.resolve(genAsset.path)).split(path.sep).join('/')}`;
      }
      return { ...s, sourceImageUrl: sourceUrl, generatedImageUrl: generatedUrl };
    });

    return NextResponse.json({ ...(set as object), shots: shotsWithUrls, sceneRefName, sceneRefImageUrl });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    if (typeof body.status === 'string') {
      db.prepare(`UPDATE shot_sets SET status = ? WHERE id = ?`).run(body.status, id);
    }

    // Update individual shot review
    if (body.shotId && body.reviewMark) {
      db.prepare(`UPDATE shots SET reviewMark = ? WHERE id = ? AND shotSetId = ?`)
        .run(body.reviewMark, body.shotId, id);
    }

    // Repoint a shot to a newly regenerated job (used by per-shot redo)
    if (body.shotId && typeof body.latestJobId === 'string' && body.latestJobId.length > 0) {
      db.prepare(`UPDATE shots SET latestJobId = ? WHERE id = ? AND shotSetId = ?`)
        .run(body.latestJobId, body.shotId, id);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    db.prepare(`DELETE FROM shot_sets WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
