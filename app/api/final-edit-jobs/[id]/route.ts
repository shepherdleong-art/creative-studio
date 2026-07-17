import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const row = getDb().prepare(`SELECT id, projectId, groupId, variantId, kind, status, phase, progress, estimatedCost, costCurrency, outputJson, errorCode, errorMessage, attempt, startedAt, finishedAt, createdAt FROM final_edit_jobs WHERE id=?`).get((await params).id);
    if (!row) return NextResponse.json({ error: 'job_not_found', message: '任务不存在' }, { status: 404 });
    return NextResponse.json(row);
  } catch (error) { return finalEditErrorResponse(error); }
}
