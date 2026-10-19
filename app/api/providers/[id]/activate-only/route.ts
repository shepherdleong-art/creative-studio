import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const provider = db.prepare(`SELECT id FROM providers WHERE id = ?`).get(id);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE providers SET enabled = 0 WHERE id != ?`).run(id);
      db.prepare(`UPDATE providers SET enabled = 1 WHERE id = ?`).run(id);
    });
    tx();

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
