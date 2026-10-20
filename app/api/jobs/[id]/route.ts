import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isReassembledImageJob } from '@/lib/reassembled-shot-guard';
import { filmWriteActor } from '@/lib/final-edit/reassembled/access';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    if (isReassembledImageJob(db, id)) {
      try {
        if (filmWriteActor(request) === 'agent') return NextResponse.json({ error: '实拍制作的人工审核标记不能由 Agent 覆盖' }, { status: 409 });
      } catch (error) { return finalEditErrorResponse(error); }
    }
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
