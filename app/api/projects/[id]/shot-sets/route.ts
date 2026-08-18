import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createShotSet } from '@/lib/shot-set-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const sets = db.prepare(`
      SELECT ss.*,
        (SELECT COUNT(*) FROM shots WHERE shotSetId = ss.id) as shotCount,
        (SELECT COUNT(*) FROM shots WHERE shotSetId = ss.id AND latestGeneratedImageId IS NOT NULL) as generatedCount,
        (SELECT COUNT(*) FROM shots WHERE shotSetId = ss.id AND reviewMark = 'available') as approvedCount
      FROM shot_sets ss
      WHERE ss.projectId = ?
      ORDER BY ss.createdAt DESC
    `).all(id);
    return NextResponse.json(sets);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const result = createShotSet(getDb(), {
      projectId: id,
      name: body.name,
      shotImageIds: body.shotImageIds,
      kind: body.kind,
      productCode: body.productCode,
      category: body.category,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ id: result.id, name: result.name, kind: result.kind });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
