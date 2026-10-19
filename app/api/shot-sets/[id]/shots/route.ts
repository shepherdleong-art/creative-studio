import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { appendShotToFreeSet } from '@/lib/shot-set-service';

// 自由素材工位的「再加一张图」。只允许 kind='free'——普通分镜组的分镜
// 由第 2 步的场景生成流程产生,不能从这里塞。
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = appendShotToFreeSet(getDb(), id, body.imageId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ shotId: result.shotId, indexNum: result.indexNum });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
