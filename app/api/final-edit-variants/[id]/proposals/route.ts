import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { timelineGaps } from '@/lib/final-edit/domain';
import { findAvailableSourceWindow } from '@/lib/final-edit/proposal';
import type { VideoTimeline } from '@/lib/final-edit/types';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

const MIN_AUTO_CLIP_FRAMES = 24;

function parse<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const variantId = (await params).id;
    const body = await request.json().catch(() => ({})) as { kind?: string };
    const kind = body.kind === 'fill_gap' ? 'fill_gap' : 'fill_all_gaps';
    const db = getDb();
    const row = db.prepare(`SELECT v.revision, v.timelineJson, g.projectId, g.shotSetId, COALESCE(s.autoUseLimit, 2) AS autoUseLimit FROM final_edit_variants v JOIN final_edit_groups g ON g.id=v.groupId LEFT JOIN final_edit_project_settings s ON s.projectId=g.projectId WHERE v.id=?`).get(variantId) as { revision: number; timelineJson: string; projectId: string; shotSetId: string; autoUseLimit: number } | undefined;
    if (!row) return NextResponse.json({ error: 'variant_not_found' }, { status: 404 });
    const timeline = parse<VideoTimeline>(row.timelineJson, { fps: 24, introFrames: 20, bodyFrames: 0, clips: [] });
    const gaps = timelineGaps(timeline.bodyFrames, timeline.clips);
    const targets = kind === 'fill_gap' ? gaps.slice(0, 1) : gaps;
    const assets = db.prepare(`SELECT a.videoJobId, a.fileFingerprint, a.generatedJson, a.manualOverrideJson, (SELECT COUNT(DISTINCT u.scopeId) FROM final_edit_usage u WHERE u.projectId=? AND u.shotSetId=a.shotSetId AND u.assetKind='video' AND u.assetKey=a.fileFingerprint) AS usageCount FROM final_edit_asset_analysis a JOIN video_jobs vj ON vj.id=a.videoJobId WHERE a.shotSetId=? AND a.status='succeeded' AND a.autoUseDisabled=0 AND vj.status='succeeded'`).all(row.projectId, row.shotSetId) as Array<{ videoJobId: string; fileFingerprint: string; generatedJson: string; manualOverrideJson: string; usageCount: number }>;
    const candidate = structuredClone(timeline);
    const occupiedByAsset = new Map<string, Array<{ startFrame: number; endFrame: number }>>();
    for (const clip of candidate.clips) {
      const occupied = occupiedByAsset.get(clip.sourceFingerprint) || [];
      occupied.push({ startFrame: clip.sourceInFrame, endFrame: clip.sourceOutFrame });
      occupiedByAsset.set(clip.sourceFingerprint, occupied);
    }
    const alreadyUsed = new Set(candidate.clips.map((clip) => clip.sourceFingerprint));
    const eligibleAssets = assets
      .filter((asset) => alreadyUsed.has(asset.fileFingerprint) || asset.usageCount < Math.max(1, row.autoUseLimit))
      .sort((a, b) => Number(alreadyUsed.has(a.fileFingerprint)) - Number(alreadyUsed.has(b.fileFingerprint)) || a.usageCount - b.usageCount);
    for (let index = 0; index < targets.length; index += 1) {
      const gap = targets[index];
      const requestedFrames = gap.endFrame - gap.startFrame;
      if (requestedFrames < MIN_AUTO_CLIP_FRAMES) continue;
      let selected: { asset: typeof eligibleAssets[number]; window: { startFrame: number; endFrame: number } } | null = null;
      let foundExact = false;
      for (let offset = 0; offset < eligibleAssets.length && !foundExact; offset += 1) {
        const asset = eligibleAssets[(index + offset) % eligibleAssets.length];
        const generated = parse<{ usableRanges?: Array<{ startUs: number; endUs: number }> }>(asset.generatedJson, {});
        const manual = parse<{ usableRanges?: Array<{ startUs: number; endUs: number }> }>(asset.manualOverrideJson, {});
        const ranges = Object.hasOwn(manual, 'usableRanges') ? manual.usableRanges || [] : generated.usableRanges || [];
        for (const range of ranges) {
          const window = findAvailableSourceWindow({
            startFrame: Math.max(0, Math.ceil(range.startUs * 24 / 1_000_000)),
            endFrame: Math.max(0, Math.floor(range.endUs * 24 / 1_000_000)),
          }, occupiedByAsset.get(asset.fileFingerprint) || [], requestedFrames, MIN_AUTO_CLIP_FRAMES);
          if (window && (!selected || window.endFrame - window.startFrame > selected.window.endFrame - selected.window.startFrame)) selected = { asset, window };
          if (window && window.endFrame - window.startFrame === requestedFrames) { foundExact = true; break; }
        }
      }
      if (!selected) continue;
      const length = selected.window.endFrame - selected.window.startFrame;
      candidate.clips.push({ id: uuidv4(), videoJobId: selected.asset.videoJobId, sourceFingerprint: selected.asset.fileFingerprint, sourceInFrame: selected.window.startFrame, sourceOutFrame: selected.window.endFrame, timelineInFrame: gap.startFrame, timelineOutFrame: gap.startFrame + length, boundSegmentId: null, framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false });
      const occupied = occupiedByAsset.get(selected.asset.fileFingerprint) || [];
      occupied.push(selected.window);
      occupiedByAsset.set(selected.asset.fileFingerprint, occupied);
    }
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO final_edit_proposals (id, variantId, baseRevision, kind, proposalJson, issuesJson, status, createdAt) VALUES (?, ?, ?, ?, ?, '[]', 'ready', ?)`).run(id, variantId, row.revision, kind, JSON.stringify({ timeline: candidate }), createdAt);
    return NextResponse.json({ id, variantId, baseRevision: row.revision, kind, addedClipCount: candidate.clips.length - timeline.clips.length, status: 'ready' }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: 'proposal_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
