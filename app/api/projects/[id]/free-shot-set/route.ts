import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOrCreateFreeShotSet } from '@/lib/shot-set-service';

// 前端在第 4 步下拉里选中「自由素材工位」时调用。
// 一个项目只有一个(D15):第一次会建一个空的,之后每次返回同一个。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = getOrCreateFreeShotSet(getDb(), id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ id: result.id, created: result.created });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
