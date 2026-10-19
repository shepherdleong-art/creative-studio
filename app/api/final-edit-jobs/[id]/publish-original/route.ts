// 包装 v2 兜底：跳过包装、直接发布原片（导出联动模式的逃生通道）
// POST /api/final-edit-jobs/<packagingJobId>/publish-original
// 仅限「失败的联动包装任务」：渲染任务在联动模式下只发布了封面，视频留给包装任务；
// 用户放弃包装时由此端点把渲染内部原片发布进预留目标，完成导出闭环。

import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { FinalEditError } from '@/lib/final-edit/errors';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { publishUnpackagedRender } from '@/lib/final-edit/publish-original';
import { loadSucceededRenderJob, type FinalEditPackagingSnapshot } from '@/lib/final-edit/packaging';
import { registerPublishedArtifacts } from '@/lib/final-edit/project-artifacts';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const job = db.prepare(`SELECT id, projectId, status, inputSnapshotJson FROM final_edit_jobs WHERE id=? AND kind='packaging'`).get(id) as { id: string; projectId: string; status: string; inputSnapshotJson: string } | undefined;
    if (!job) throw new FinalEditError('job_not_found', '包装任务不存在', 404);
    if (job.status === 'succeeded') throw new FinalEditError('packaging_not_skippable', '包装任务已完成，无需跳过', 409);
    if (job.status !== 'failed') throw new FinalEditError('packaging_not_skippable', '只能对失败的包装任务跳过包装', 409);
    let snapshot: FinalEditPackagingSnapshot;
    try { snapshot = JSON.parse(job.inputSnapshotJson) as FinalEditPackagingSnapshot; } catch { throw new FinalEditError('packaging_snapshot_invalid', '包装任务快照已损坏', 409); }
    let exportTarget = snapshot.exportTarget;
    if (!exportTarget) throw new FinalEditError('packaging_not_linked', '该包装任务不属于导出联动，无需跳过', 409);
    const render = loadSucceededRenderJob(db, snapshot.renderJobId);

    const storageRoot = path.join(dataRoot(), 'storage');
    const blockedRelativePaths = new Set((db.prepare('SELECT relativePath FROM project_artifacts WHERE projectId=?').all(job.projectId) as Array<{ relativePath: string }>).map(row => row.relativePath));
    exportTarget = await publishUnpackagedRender({
      storageRoot,
      target: exportTarget,
      identity: render.snapshot.exportIdentity,
      videoRelativePath: render.output.videoRelativePath,
      coverRelativePath: render.output.coverRelativePath,
      blockedRelativePaths,
    });

    const finishedAt = new Date().toISOString();
    const publishedOutput = {
      publishedVideoRelativePath: exportTarget.videoRelativePath, videoFilename: exportTarget.videoFilename,
      publishedCoverRelativePath: exportTarget.coverRelativePath, coverFilename: exportTarget.coverFilename,
      displayDirectory: exportTarget.displayDirectory,
    };
    db.transaction(() => {
      registerPublishedArtifacts(db, {
        projectId: job.projectId,
        target: exportTarget!,
        sourceJobId: snapshot.renderJobId,
        createdAt: finishedAt,
      });
      db.prepare('UPDATE final_edit_jobs SET outputJson=? WHERE id=?').run(JSON.stringify({ ...render.output, ...publishedOutput }), snapshot.renderJobId);
      db.prepare(`UPDATE final_edit_jobs SET status='skipped', phase='skipped', errorCode=NULL, errorMessage=NULL, outputJson=?, finishedAt=? WHERE id=? AND status='failed'`).run(
        JSON.stringify({ skippedPublishOriginal: true, ...publishedOutput, sourceRenderJobId: snapshot.renderJobId }),
        finishedAt,
        id,
      );
    })();
    return NextResponse.json({ id, status: 'skipped', videoFilename: exportTarget.videoFilename, displayDirectory: exportTarget.displayDirectory });
  } catch (error) { return finalEditErrorResponse(error); }
}
