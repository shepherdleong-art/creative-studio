import path from 'node:path';
import type Database from 'better-sqlite3';
import { materializeVideoFrame } from './video-frame.ts';
import { toStorageRelativePath } from './storage-path.ts';
import { videoJobNotRejectedSql } from '../media-core/video-job-rejection.ts';

interface GroupIdentity {
  id: string;
  projectId: string;
  shotSetId: string;
}

export type ParsedCoverKey =
  | { kind: 'storyboard_image'; imageId: string }
  | { kind: 'video_keyframe'; videoJobId: string; frameUs: number };

export function parseCoverKey(coverKey: string): ParsedCoverKey | null {
  if (coverKey.startsWith('image:')) {
    const imageId = coverKey.slice('image:'.length);
    return imageId ? { kind: 'storyboard_image', imageId } : null;
  }
  const match = coverKey.match(/^video:([^:]+):(\d+)$/);
  if (!match) return null;
  const frameUs = Number(match[2]);
  return Number.isSafeInteger(frameUs) ? { kind: 'video_keyframe', videoJobId: match[1], frameUs } : null;
}

export async function resolveCoverCandidateFile(input: {
  db: Database.Database;
  storageRoot: string;
  group: GroupIdentity;
  coverKey: string;
}): Promise<{ relativePath: string; mimeType: string }> {
  const parsedKey = parseCoverKey(input.coverKey);
  if (!parsedKey) throw new Error('封面候选格式无效');
  if (parsedKey.kind === 'storyboard_image') {
    const row = input.db.prepare(`
      SELECT ia.path, ia.mimeType
      FROM image_assets ia
      JOIN shots s ON s.latestGeneratedImageId=ia.id
      WHERE ia.id=? AND s.shotSetId=?
      LIMIT 1
    `).get(parsedKey.imageId, input.group.shotSetId) as { path: string; mimeType: string } | undefined;
    if (!row) throw new Error('封面图片不存在');
    return { relativePath: toStorageRelativePath(input.storageRoot, row.path), mimeType: row.mimeType || 'image/png' };
  }

  const row = input.db.prepare(`
    SELECT vj.localVideoPath, a.generatedJson, a.fileFingerprint
    FROM video_jobs vj
    JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id
    WHERE vj.id=? AND vj.projectId=? AND vj.shotSetId=? AND vj.status='succeeded'
      AND ${videoJobNotRejectedSql(input.db, 'vj')}
  `).get(parsedKey.videoJobId, input.group.projectId, input.group.shotSetId) as { localVideoPath: string; generatedJson: string; fileFingerprint: string } | undefined;
  if (!row) throw new Error('视频封面候选不存在');
  const generated = JSON.parse(row.generatedJson || '{}') as { coverFrameTimesUs?: unknown[] };
  if (!generated.coverFrameTimesUs?.some((value) => Number(value) === parsedKey.frameUs)) throw new Error('视频封面候选不属于当前分析结果');
  const frame = await materializeVideoFrame({
    storageRoot: input.storageRoot,
    sourcePath: row.localVideoPath,
    cacheNamespace: path.join('covers', input.group.id),
    cacheKey: `${input.coverKey}:${row.fileFingerprint}`,
    frameUs: parsedKey.frameUs,
  });
  return { relativePath: frame.relativePath, mimeType: 'image/jpeg' };
}
