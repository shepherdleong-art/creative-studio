import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { parseDurationGateState } from '@/lib/final-edit/duration-gate';
import { parseRenderRevisionFromSnapshot } from '@/lib/final-edit/workspace';
import { countScriptContentCharacters, estimateNarrationDurationSec } from '@/lib/script-duration-policy';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = getDb().prepare(`SELECT id, projectId, groupId, variantId, kind, status, phase, progress, estimatedCost, costCurrency, inputSnapshotJson, outputJson, errorCode, errorMessage, attempt, startedAt, finishedAt, createdAt, detailJson FROM final_edit_jobs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return NextResponse.json({ error: 'job_not_found', message: '任务不存在' }, { status: 404 });
    // Reopening an interrupted film export resumes its persisted queue without
    // requiring another export click (which could reserve a different revision).
    if (['queued', 'running'].includes(String(row.status)) && typeof row.inputSnapshotJson === 'string') {
      try { if (JSON.parse(row.inputSnapshotJson).renderer === 'reassembled-film/1') wakeFinalEditWorker(); } catch { /* legacy/corrupt snapshots remain visible */ }
    }
    // prepare 任务的处理明细（逐条素材分析/逐句口播日志），失败/旧任务缺省为 null
    let detail: { lines: string[]; current: string } | null = null;
    if (typeof row.detailJson === 'string' && row.detailJson) {
      try {
        const parsed = JSON.parse(row.detailJson) as { lines?: unknown; current?: unknown };
        detail = {
          lines: Array.isArray(parsed.lines) ? parsed.lines.filter((line): line is string => typeof line === 'string') : [],
          current: typeof parsed.current === 'string' ? parsed.current : '',
        };
      } catch { detail = null; }
    }
    delete row.detailJson;
    let output: Record<string, unknown> | null = null;
    let target: Record<string, string> | null = null;
    let renderRevision: { groupRevision: number; variantRevision: number } | null = null;
    if (row.kind === 'render' && typeof row.inputSnapshotJson === 'string') {
      try {
        const snapshot = JSON.parse(row.inputSnapshotJson) as { exportIdentity?: Record<string, unknown>; exportTarget?: Record<string, unknown> };
        renderRevision = parseRenderRevisionFromSnapshot(snapshot);
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
    if ((row.kind === 'render' || row.kind === 'packaging') && row.status === 'succeeded' && typeof row.outputJson === 'string' && row.outputJson) {
      try {
        const parsed = JSON.parse(row.outputJson) as Record<string, unknown>;
        // 跳过包装可能换成无包装编号的发布目标；已发布文件名优先于最初预留名。
        if (target && typeof parsed.videoFilename === 'string') {
          target = { ...target, videoFilename: parsed.videoFilename,
            coverFilename: typeof parsed.coverFilename === 'string' ? parsed.coverFilename : target.coverFilename,
            displayDirectory: typeof parsed.displayDirectory === 'string' ? parsed.displayDirectory : target.displayDirectory };
        }
        output = {
          ...parsed,
          videoUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/video`,
          videoDownloadUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/video?download=1`,
          ...(parsed.coverRelativePath ? {
            coverUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/cover`,
            coverDownloadUrl: `/api/final-edit-jobs/${encodeURIComponent(id)}/cover?download=1`,
          } : {}),
        };
      } catch { /* keep legacy/corrupt output visible through outputJson only */ }
    }
    const publicRow = { ...row };
    delete publicRow.inputSnapshotJson;
    let durationReview: Record<string, unknown> | null = null;
    if (row.status === 'needs_input' && row.phase === 'duration_review' && typeof row.groupId === 'string') {
      const group = getDb().prepare(`SELECT durationGateJson, editedNarrationText FROM final_edit_groups WHERE id=?`).get(row.groupId) as { durationGateJson: string; editedNarrationText: string } | undefined;
      const gate = parseDurationGateState(group?.durationGateJson);
      if (gate?.status === 'needs_input') {
        durationReview = {
          targetTotalSec: gate.targetTotalUs / 1_000_000,
          targetNarrationSec: gate.targetNarrationUs / 1_000_000,
          estimatedNarrationSec: estimateNarrationDurationSec(countScriptContentCharacters(group?.editedNarrationText || '')),
          actualNarrationSec: gate.actualNarrationUs / 1_000_000,
          actualTotalSec: gate.actualTotalUs / 1_000_000,
          deltaSec: gate.deltaUs / 1_000_000,
          toleranceSec: gate.toleranceUs / 1_000_000,
          reason: gate.reason,
          smartFitAvailable: gate.smartFitAttempts === 0,
        };
      }
    }
    return NextResponse.json({ ...publicRow, detail, target, output, renderRevision, durationReview });
  } catch (error) { return finalEditErrorResponse(error); }
}
