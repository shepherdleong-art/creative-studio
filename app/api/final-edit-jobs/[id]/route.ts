import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = getDb().prepare(`SELECT id, projectId, groupId, variantId, kind, status, phase, progress, estimatedCost, costCurrency, inputSnapshotJson, outputJson, errorCode, errorMessage, attempt, startedAt, finishedAt, createdAt FROM final_edit_jobs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return NextResponse.json({ error: 'job_not_found', message: '任务不存在' }, { status: 404 });
    let output: Record<string, unknown> | null = null;
    let target: Record<string, string> | null = null;
    if (row.kind === 'render' && typeof row.inputSnapshotJson === 'string') {
      try {
        const snapshot = JSON.parse(row.inputSnapshotJson) as { exportIdentity?: Record<string, unknown>; exportTarget?: Record<string, unknown> };
        const identity = snapshot.exportIdentity;
        const exportTarget = snapshot.exportTarget;
        if (identity && exportTarget) target = {
          taskName: String(identity.taskName || ''),
          productCode: String(identity.productCode || ''),
          taskDate: String(identity.taskDate || ''),
          videoFilename: String(exportTarget.videoFilename || ''),
          coverFilename: String(exportTarget.coverFilename || ''),
          displayDirectory: String(exportTarget.displayDirectory || ''),
        };
      } catch { /* older non-export snapshot */ }
    }
    if (row.kind === 'render' && row.status === 'succeeded' && typeof row.outputJson === 'string' && row.outputJson) {
      try {
        const parsed = JSON.parse(row.outputJson) as Record<string, unknown>;
        output = {
          ...parsed,
          videoUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/video`,
          videoDownloadUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/video?download=1`,
          coverUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/cover`,
          coverDownloadUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/cover?download=1`,
        };
      } catch { /* keep legacy/corrupt output visible through outputJson only */ }
    }
    const publicRow = { ...row };
    delete publicRow.inputSnapshotJson;
    return NextResponse.json({ ...publicRow, target, output });
  } catch (error) { return finalEditErrorResponse(error); }
}
