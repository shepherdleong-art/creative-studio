import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { mergePackageConfig, FinalVideoJobRow, PackageConfig } from '@/lib/final-video/types';
import { findScriptDraftForShotSet } from '@/lib/final-video/draft';
import { startFinalVideoQueue } from '@/lib/final-video/render-queue';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      shotSetId?: string;
      packageConfig?: Partial<PackageConfig>;
    };
    const shotSetId = body.shotSetId;
    if (!shotSetId) return NextResponse.json({ error: 'shotSetId is required' }, { status: 400 });

    const shotSet = db
      .prepare(`SELECT id FROM shot_sets WHERE id = ? AND projectId = ?`)
      .get(shotSetId, projectId);
    if (!shotSet) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });

    const draft = findScriptDraftForShotSet(db, projectId, shotSetId);
    if (!draft) return NextResponse.json({ error: '该分镜组还没有匹配的脚本草稿，请先在「脚本生成」中生成' }, { status: 400 });

    const clipCount = db
      .prepare(
        `SELECT COUNT(DISTINCT shotId) as count FROM video_jobs
         WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL`
      )
      .get(shotSetId) as { count: number };
    if (clipCount.count === 0) {
      return NextResponse.json({ error: '该分镜组还没有已完成的视频片段' }, { status: 400 });
    }

    const pkg = mergePackageConfig(body.packageConfig);
    const narrationMode = (pkg.narration as { mode: string }).mode;
    if (narrationMode !== 'none' && narrationMode !== 'tts') {
      return NextResponse.json({ error: `未知口播模式: ${narrationMode}` }, { status: 400 });
    }
    if (pkg.narration.mode === 'tts') {
      try {
        const { resolveNarrationRuntime } = await import('@/lib/final-video/tts');
        await resolveNarrationRuntime(pkg.narration.providerId);
      } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 400 });
      }
    }

    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO final_video_jobs (id, projectId, shotSetId, scriptDraftId, packageJson)
       VALUES (?, ?, ?, ?, ?)`
    ).run(jobId, projectId, shotSetId, draft.id, JSON.stringify(pkg));

    startFinalVideoQueue();
    return NextResponse.json({ success: true, jobId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM final_video_jobs WHERE projectId = ? ORDER BY createdAt DESC`)
      .all(projectId) as FinalVideoJobRow[];
    const jobs = rows.map((row) => {
      let packageConfig: PackageConfig | Record<string, never> = {};
      try {
        packageConfig = mergePackageConfig(JSON.parse(row.packageJson));
      } catch {
        /* keep empty */
      }
      return {
        id: row.id,
        shotSetId: row.shotSetId,
        status: row.status,
        currentStep: row.currentStep,
        progress: row.progress,
        durationSec: row.durationSec,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt,
        packageConfig,
        outputUrl: toStorageVideoUrl(row.outputPath),
        coverUrl: toStorageImageUrl(row.coverPath),
      };
    });
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
