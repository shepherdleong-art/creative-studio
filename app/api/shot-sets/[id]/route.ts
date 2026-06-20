import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';

function toImageUrl(storageRoot: string, imagePath: string | null | undefined): string {
  return imagePath ? `/api/images/${path.relative(storageRoot, path.resolve(imagePath)).split(path.sep).join('/')}` : '';
}

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

    const candidateRows = db.prepare(`
      SELECT
        c.shotId,
        c.jobId,
        c.imageAssetId,
        c.createdAt,
        ia.filename,
        ia.path as imagePath,
        j.status as jobStatus,
        j.prompt as jobPrompt,
        j.referenceImageIds,
        j.providerId,
        j.model,
        j.size,
        j.quality
      FROM shot_result_candidates c
      JOIN image_assets ia ON ia.id = c.imageAssetId
      LEFT JOIN jobs j ON j.id = c.jobId
      WHERE c.shotId IN (${(shots as Array<Record<string, unknown>>).map(() => '?').join(',') || "''"})
      ORDER BY c.createdAt ASC
    `).all(...(shots as Array<Record<string, unknown>>).map((s) => s.id)) as Array<Record<string, unknown>>;

    const candidatesByShotId = new Map<string, Array<Record<string, unknown>>>();
    for (const row of candidateRows) {
      const shotId = String(row.shotId || '');
      if (!shotId) continue;
      const list = candidatesByShotId.get(shotId) || [];
      list.push({
        ...row,
        imageUrl: toImageUrl(storageRoot, row.imagePath as string | null | undefined),
      });
      candidatesByShotId.set(shotId, list);
    }

    const shotsWithUrls = (shots as Array<Record<string, unknown>>).map((s) => {
      const sourceUrl = toImageUrl(storageRoot, s.sourcePath as string | null | undefined);
      const genAsset = db.prepare(`SELECT path FROM image_assets WHERE id = ?`).get(s.latestGeneratedImageId) as { path?: string } | undefined;
      const generatedUrl = toImageUrl(storageRoot, genAsset?.path);
      return {
        ...s,
        sourceImageUrl: sourceUrl,
        generatedImageUrl: generatedUrl,
        resultCandidates: candidatesByShotId.get(String(s.id)) || [],
      };
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

    if (body.shotId && typeof body.selectedImageAssetId === 'string' && body.selectedImageAssetId.length > 0) {
      const candidate = db.prepare(`
        SELECT jobId, imageAssetId
        FROM shot_result_candidates
        WHERE shotId = ? AND imageAssetId = ?
      `).get(body.shotId, body.selectedImageAssetId) as { jobId: string; imageAssetId: string } | undefined;
      if (!candidate) {
        return NextResponse.json({ error: '候选结果不存在' }, { status: 400 });
      }
      const result = db.prepare(`
        UPDATE shots
        SET latestGeneratedImageId = ?, latestJobId = ?
        WHERE id = ? AND shotSetId = ?
      `).run(candidate.imageAssetId, candidate.jobId, body.shotId, id);
      if (result.changes === 0) {
        return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
      }
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
