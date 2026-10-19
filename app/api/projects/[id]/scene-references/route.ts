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
    const refs = db.prepare(`
      SELECT sr.*, ia.filename as imageFilename
      FROM scene_references sr
      LEFT JOIN image_assets ia ON sr.imageAssetId = ia.id
      WHERE sr.projectId = ?
      ORDER BY sr.createdAt DESC
    `).all(id);
    return NextResponse.json(refs);
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
    const imageAssetId = body.imageAssetId as string;
    const sourceJobId = (body.sourceJobId as string) || null;

    if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
    if (!imageAssetId) return NextResponse.json({ error: '缺少图片' }, { status: 400 });

    // Verify image belongs to project
    const img = db.prepare(`SELECT id FROM image_assets WHERE id = ? AND projectId = ?`).get(imageAssetId, id);
    if (!img) return NextResponse.json({ error: '图片不属于当前项目' }, { status: 400 });

    const refId = uuidv4();
    db.prepare(`
      INSERT INTO scene_references (id, projectId, imageAssetId, sourceJobId, name, productCode, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(refId, id, imageAssetId, sourceJobId, name, (body.productCode as string) || '', (body.category as string) || '');

    return NextResponse.json({ id: refId, name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
