import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { FinalEditCommand } from '@/lib/final-edit/workspace';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(getFinalEditWorkspace().load((await params).id)); }
  catch (error) { return finalEditErrorResponse(error); }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const body = await request.json() as Omit<Extract<FinalEditCommand, { scope: 'group' }>, 'scope' | 'groupId'>;
    return NextResponse.json(getFinalEditWorkspace().apply({ ...body, scope: 'group', groupId: id } as Extract<FinalEditCommand, { scope: 'group' }>));
  } catch (error) { return finalEditErrorResponse(error); }
}
