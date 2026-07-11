import fs from 'node:fs';
import { getDb } from '../db.ts';
import { probeDurationSec } from '../ffmpeg.ts';
import type { ClipPoolItem, TimelineIssue } from './types.ts';

interface ClipCandidateRow {
  shotId: string;
  shotIndex: number;
  videoJobId: string | null;
  localVideoPath: string | null;
  sourceImageId: string | null;
  sourceImagePath: string | null;
}

function missingIssue(shotId: string, clipId: string | null, reason: string): TimelineIssue {
  return {
    code: 'clip_missing',
    severity: 'warning',
    message: `Shot ${shotId} has no usable video clip: ${reason}`,
    beatIds: [],
    clipId,
  };
}

function isRegularFile(filePath: string | null): filePath is string {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Build an immutable, deterministic snapshot of the usable videos for one shot set. */
export async function buildClipPool(shotSetId: string): Promise<{
  clips: ClipPoolItem[];
  issues: TimelineIssue[];
}> {
  const normalizedShotSetId = shotSetId.trim();
  if (!normalizedShotSetId) throw new Error('shotSetId is required');

  const db = getDb();
  const shotSet = db.prepare(`SELECT id FROM shot_sets WHERE id = ?`).get(normalizedShotSetId);
  if (!shotSet) throw new Error(`Shot set not found: ${normalizedShotSetId}`);

  const rows = db.prepare(`
    SELECT
      s.id AS shotId,
      s.indexNum AS shotIndex,
      vj.id AS videoJobId,
      vj.localVideoPath,
      vj.sourceImageId,
      ia.path AS sourceImagePath
    FROM shots s
    LEFT JOIN video_jobs vj ON vj.id = (
      SELECT candidate.id
      FROM video_jobs candidate
      WHERE candidate.shotId = s.id
        AND candidate.shotSetId = s.shotSetId
        AND candidate.status = 'succeeded'
      ORDER BY
        COALESCE(candidate.finishedAt, candidate.createdAt) DESC,
        candidate.createdAt DESC,
        candidate.id DESC
      LIMIT 1
    )
    LEFT JOIN image_assets ia ON ia.id = vj.sourceImageId
    WHERE s.shotSetId = ?
    ORDER BY s.indexNum ASC, s.id ASC
  `).all(normalizedShotSetId) as ClipCandidateRow[];

  const clips: ClipPoolItem[] = [];
  const issues: TimelineIssue[] = [];
  for (const row of rows) {
    if (!row.videoJobId) {
      issues.push(missingIssue(row.shotId, null, 'no successful video job'));
      continue;
    }
    if (!isRegularFile(row.sourceImagePath)) {
      issues.push(missingIssue(row.shotId, row.videoJobId, 'source image is missing or is not a file'));
      continue;
    }
    if (!isRegularFile(row.localVideoPath)) {
      issues.push(missingIssue(row.shotId, row.videoJobId, 'video is missing or is not a file'));
      continue;
    }

    let clipDurationSec: number;
    try {
      clipDurationSec = await probeDurationSec(row.localVideoPath);
    } catch {
      issues.push(missingIssue(row.shotId, row.videoJobId, 'video duration could not be probed'));
      continue;
    }
    if (!Number.isFinite(clipDurationSec) || clipDurationSec <= 0) {
      issues.push(missingIssue(row.shotId, row.videoJobId, 'video duration is not positive'));
      continue;
    }

    clips.push({
      clipId: row.videoJobId,
      shotId: row.shotId,
      shotIndex: row.shotIndex,
      videoPath: row.localVideoPath,
      clipDurationSec,
      sourceImageId: row.sourceImageId!,
      sourceImagePath: row.sourceImagePath,
      visualDescription: '',
      descriptionProviderId: null,
      descriptionModel: null,
    });
  }

  return { clips, issues };
}
