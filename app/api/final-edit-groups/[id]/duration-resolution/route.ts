import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { DurationResolutionInput } from '@/lib/final-edit/workspace';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as Omit<DurationResolutionInput, 'groupId'>;
    if (!body || !['smart_fit', 'retry_with_changes', 'accept_actual'].includes(String(body.action))) {
      return NextResponse.json({ error: 'duration_resolution_invalid', message: '不支持的时长处理动作' }, { status: 400 });
    }
    return NextResponse.json(await getFinalEditWorkspace().resolveDuration({ ...body, groupId: id } as DurationResolutionInput));
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
