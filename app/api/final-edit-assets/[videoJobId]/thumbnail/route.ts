import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { probeVideoMedia } from '@/lib/ffmpeg';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { resolveStoragePath } from '@/lib/final-edit/storage-path';
import { materializeVideoFrame } from '@/lib/final-edit/video-frame';

// JC-5 (gap-fill, not in plan §3.1's table): bare module-4 video thumbnail,
// reusing the existing flat app/api/final-edit-assets/[videoJobId]/... route
// namespace (siblings: analysis/route.ts, reanalyze/route.ts). Needed because
// MixcutContextResponse.videoAssets[].thumbnailUrl must point somewhere, and
// no existing route serves a module-4 video thumbnail outside an
// already-created final_edit_groups context (the group-scoped sibling at
// app/api/final-edit-groups/[id]/assets/[videoJobId]/thumbnail/route.ts
// requires a group join this stage doesn't have).
export async function GET(request: Request, { params }: { params: Promise<{ videoJobId: string }> }) {
  const { videoJobId } = await params;
  const db = getDb();
  const row = db.prepare(`
    SELECT localVideoPath FROM video_jobs WHERE id = ? AND status = 'succeeded'
  `).get(videoJobId) as { localVideoPath: string | null } | undefined;
  if (!row?.localVideoPath) return NextResponse.json({ error: 'asset_not_found' }, { status: 404 });
  try {
    const storageRoot = path.join(dataRoot(), 'storage');
    const absolutePath = resolveStoragePath(storageRoot, row.localVideoPath, { allowAbsolute: true });
    const media = await probeVideoMedia(absolutePath);
    // JUDGMENT CALL (JC-5): pick a safe frame timestamp — 10% into the clip,
    // capped at 1s, floored at 0 (matches a probe that failed and returned
    // durationUs: 0 by just grabbing the very first frame instead of erroring).
    const frameUs = Math.max(0, Math.min(1_000_000, Math.floor(media.durationUs * 0.1)));
    // JUDGMENT CALL: mirrors the group-scoped sibling route's
    // `${videoJobId}:${fileFingerprint}:${frameUs}` cache key shape
    // (app/api/final-edit-groups/[id]/assets/[videoJobId]/thumbnail/route.ts)
    // so the cache doesn't permanently pin whatever frame was materialized
    // first (materializeVideoFrame treats any existing file at
    // sha256(cacheKey).jpg as a cache hit). video_jobs has no
    // fileFingerprint column (that only lives on final_edit_asset_analysis,
    // keyed by videoJobId, and won't exist yet for most Phase-1 videos), so
    // the file's mtime+size stand in as the cheap per-file identity signal
    // instead — the cache still naturally invalidates if the underlying
    // file is ever replaced, without requiring a fingerprint column these
    // rows don't have.
    const stat = fs.statSync(absolutePath);
    const frame = await materializeVideoFrame({
      storageRoot,
      sourcePath: row.localVideoPath,
      // Distinct cache namespace from the group-scoped sibling route
      // (`thumbnails/${groupId}`) so caches never collide.
      cacheNamespace: `thumbnails/module4/${videoJobId}`,
      cacheKey: `${videoJobId}:${stat.mtimeMs}:${stat.size}:${frameUs}`,
      frameUs,
    });
    return mediaResponse(request, frame.relativePath, 'image/jpeg');
  } catch (error) {
    return NextResponse.json({ error: 'thumbnail_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
