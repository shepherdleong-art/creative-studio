import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mergePackageConfig } from '@/lib/final-video/types';
import type { FinalVideoJobRow, PackageConfig } from '@/lib/final-video/types';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;
  return NextResponse.json({ error: 'draft_workflow_required' }, { status: 409 });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM final_video_jobs WHERE projectId = ? AND kind = 'final' ORDER BY createdAt DESC`)
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
