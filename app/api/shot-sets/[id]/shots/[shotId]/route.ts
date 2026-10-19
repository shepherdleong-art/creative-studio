import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteShotFromFreeSet } from '@/lib/shot-set-service';

// D21:自由工位的「删掉这张图」,只允许在还没生成之前删。
// 返回 sourceImageId,前端据此再 best-effort 删图片资源——图片能不能删
// 由 /api/images/[id] 自己的引用检查决定(和尾帧 deleteTailFrameAsset 同一套)。
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; shotId: string }> }
) {
  try {
    const { id, shotId } = await params;
    const result = deleteShotFromFreeSet(getDb(), id, shotId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, sourceImageId: result.sourceImageId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
