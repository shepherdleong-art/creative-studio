import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { FinalEditCommand } from '@/lib/final-edit/workspace';
import { getDb } from '@/lib/db';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as Omit<Extract<FinalEditCommand, { scope: 'variant' }>, 'scope' | 'variantId'>;
    return NextResponse.json(getFinalEditWorkspace().apply({ ...body, scope: 'variant', variantId: id } as Extract<FinalEditCommand, { scope: 'variant' }>));
  } catch (error) { return finalEditErrorResponse(error); }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rendered = getDb().prepare(`SELECT 1 FROM final_edit_jobs WHERE variantId=? AND kind='render' AND status='succeeded' LIMIT 1`).get(id);
    if (rendered) return NextResponse.json({ error: 'variant_already_rendered', message: '已导出的草稿不能直接删除' }, { status: 409 });
    const result = getDb().transaction(() => {
      getDb().prepare(`DELETE FROM final_edit_usage WHERE variantId=?`).run(id);
      getDb().prepare(`DELETE FROM final_edit_revisions WHERE scopeKind='variant' AND scopeId=?`).run(id);
      return getDb().prepare(`DELETE FROM final_edit_variants WHERE id=?`).run(id);
    })();
    return result.changes ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: 'variant_not_found' }, { status: 404 });
  } catch (error) { return finalEditErrorResponse(error); }
}
