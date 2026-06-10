import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

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
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const name = (body.name as string)?.trim();
    const rawIds = body.shotImageIds;

    if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
    if (!Array.isArray(rawIds)) return NextResponse.json({ error: 'shotImageIds 必须是数组' }, { status: 400 });

    const shotImageIds: string[] = [...new Set(
      rawIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    )];

    if (shotImageIds.length === 0) return NextResponse.json({ error: '至少需要1张分镜图' }, { status: 400 });
    if (shotImageIds.length > 9) return NextResponse.json({ error: '分镜图最多9张' }, { status: 400 });

    // Validate all images exist and belong to this project
    const placeholders = shotImageIds.map(() => '?').join(',');
    const validCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM image_assets WHERE id IN (${placeholders}) AND projectId = ?`
    ).get(...shotImageIds, id) as { cnt: number };
    if (validCount.cnt !== shotImageIds.length) {
      return NextResponse.json({ error: '部分图片不存在或不属于当前项目' }, { status: 400 });
    }

    const setId = uuidv4();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO shot_sets (id, projectId, name, productCode, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(setId, id, name, (body.productCode as string) || '', (body.category as string) || '');

      const insertShot = db.prepare(`
        INSERT INTO shots (id, shotSetId, indexNum, sourceImageId)
        VALUES (?, ?, ?, ?)
      `);
      shotImageIds.forEach((imgId, i) => {
        insertShot.run(uuidv4(), setId, i + 1, imgId);
      });
    })();

    return NextResponse.json({ id: setId, name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
