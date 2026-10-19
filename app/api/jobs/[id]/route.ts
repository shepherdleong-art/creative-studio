import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();

    const { mark } = body; // 'available' | 'rework' | 'discard' | '' (clear)

    if (mark && !['available', 'rework', 'discard'].includes(mark)) {
      return NextResponse.json({ error: 'Invalid mark value' }, { status: 400 });
    }

    db.prepare(`UPDATE jobs SET reviewMark = ? WHERE id = ?`).run(mark || '', id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
