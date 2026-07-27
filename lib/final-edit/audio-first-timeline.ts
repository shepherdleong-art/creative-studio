import crypto from 'node:crypto';
import type { TimelinePlan } from './audio-first-matcher.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES, type FinalEditIssue, type TimelineClip, type VideoTimeline } from './types.ts';

export interface TimelineSourceAsset {
  videoJobId: string;
  fingerprint: string;
  durationUs: number;
}

function frameAt(timeUs: number): number {
  return Math.max(0, Math.round(timeUs * FINAL_EDIT_FPS / 1_000_000));
}

function clipId(segmentId: string, assetKey: string, sourceStartUs: number, sourceEndUs: number): string {
  return `audio-first-${crypto.createHash('sha256').update(JSON.stringify({ segmentId, assetKey, sourceStartUs, sourceEndUs })).digest('hex').slice(0, 24)}`;
}

export function audioFirstPlanToVideoTimeline(input: {
  plan: TimelinePlan;
  assetsByKey: ReadonlyMap<string, TimelineSourceAsset>;
  narrationDurationUs: number;
  boundSegmentIdBySentenceId?: ReadonlyMap<string, string>;
}): { timeline: VideoTimeline; issues: FinalEditIssue[] } {
  const bodyFrames = Math.ceil(Math.max(0, input.narrationDurationUs) * FINAL_EDIT_FPS / 1_000_000);
  const clips: TimelineClip[] = [];
  const issues: FinalEditIssue[] = [];
  const ordered = [...input.plan.segments].sort((left, right) => left.startUs - right.startUs || left.sentenceId.localeCompare(right.sentenceId));
  for (const segment of ordered) {
    const boundSegmentId = input.boundSegmentIdBySentenceId?.get(segment.sentenceId) ?? segment.sentenceId;
    const asset = input.assetsByKey.get(segment.assetKey);
    if (!asset) {
      issues.push({ code: 'material_gap', severity: 'blocking', message: `句段 ${boundSegmentId} 的素材不存在`, targetId: boundSegmentId });
      continue;
    }
    const timelineInFrame = frameAt(segment.startUs);
    const timelineOutFrame = segment.endUs >= input.narrationDurationUs ? bodyFrames : frameAt(segment.endUs);
    const lengthFrames = timelineOutFrame - timelineInFrame;
    const sourceInFrame = frameAt(segment.sourceStartUs);
    const sourceOutFrame = sourceInFrame + lengthFrames;
    const sourceFrameLimit = Math.ceil(asset.durationUs * FINAL_EDIT_FPS / 1_000_000);
    if (lengthFrames <= 0 || sourceOutFrame > sourceFrameLimit) {
      issues.push({ code: 'material_gap', severity: 'blocking', message: `句段 ${boundSegmentId} 无法安全换算为视频帧`, targetId: boundSegmentId });
      continue;
    }
    clips.push({
      id: clipId(segment.sentenceId, segment.assetKey, segment.sourceStartUs, segment.sourceEndUs),
      videoJobId: asset.videoJobId,
      sourceFingerprint: asset.fingerprint,
      sourceInFrame,
      sourceOutFrame,
      timelineInFrame,
      timelineOutFrame,
      boundSegmentId,
      framing: { scale: 1, offsetX: 0, offsetY: 0 },
      manualUseOverride: false,
    });
  }
  return { timeline: { fps: FINAL_EDIT_FPS, introFrames: FINAL_EDIT_INTRO_FRAMES, bodyFrames, clips }, issues };
}
