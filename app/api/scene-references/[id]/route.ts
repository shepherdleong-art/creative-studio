import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const ref = db.prepare(`SELECT * FROM scene_references WHERE id = ?`).get(id);
    if (!ref) return NextResponse.json({ error: '场景参考图不存在' }, { status: 404 });

    if (body.status === 'archived') {
      db.prepare(`UPDATE scene_references SET status = 'archived' WHERE id = ?`).run(id);
    }
    if (body.status === 'active') {
      db.prepare(`UPDATE scene_references SET status = 'active' WHERE id = ?`).run(id);
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      db.prepare(`UPDATE scene_references SET name = ? WHERE id = ?`).run(body.name.trim(), id);
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
    db.prepare(`DELETE FROM scene_references WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
