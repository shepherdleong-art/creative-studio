import type { RenderSpec } from '../../film-render/types.ts';
import { isClassicSpec } from '../../film-render/types.ts';
import { parseRenderSpec } from '../../film-render/spec.ts';
import type { VideoTimeline } from '../types.ts';
import type { RegisteredCandidate } from './types.ts';
import { FinalEditError } from '../errors.ts';

function requireFilm(ok: unknown, message: string): asserts ok {
  if (!ok) throw new FinalEditError('film_edit_unsupported', message, 409);
}

export function filmTimeline(spec: RenderSpec, candidates: RegisteredCandidate[]): VideoTimeline {
  return { fps: 24, introFrames: 20, bodyFrames: spec.canvas.frames - 20, clips: spec.shots.map(shot => {
    const candidate = candidates.find(c => c.clipId === shot.id && c.file === shot.file);
    requireFilm(candidate, `镜头 ${shot.id} 没有登记的素材`);
    return { id: shot.id, videoJobId: candidate.videoJobId, sourceFingerprint: candidate.fingerprint,
      sourceInFrame: Math.round(shot.inSec * 24),
      sourceOutFrame: Math.round(shot.inSec * 24 + (shot.endFrame - shot.startFrame) * shot.rate),
      playbackRate: shot.rate, timelineInFrame: shot.startFrame - 20, timelineOutFrame: shot.endFrame - 20,
      boundSegmentId: null, framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: false };
  }) };
}

/** Frozen audio/cover/packaging are kept; every accepted timeline edit is projected. */
export function projectFilmTimeline(base: RenderSpec, timeline: VideoTimeline, candidates: RegisteredCandidate[]): RenderSpec {
  requireFilm(timeline.fps === 24 && timeline.introFrames === 20 && timeline.bodyFrames === base.canvas.frames - 20,
    '本阶段保留总片长和配音，只调整镜头截取区间与顺序');
  requireFilm(!timeline.audio && timeline.clips.length === base.shots.length, '本阶段不支持增删镜头或修改音轨');
  const initial = filmTimeline(base, candidates);
  const result = structuredClone(base);
  const seen = new Set<string>();
  let cursor = 0;
  result.shots = [...timeline.clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame).map(clip => {
    const shot = base.shots.find(s => s.id === clip.id);
    const candidate = candidates.find(c => c.videoJobId === clip.videoJobId && c.clipId === clip.id);
    requireFilm(shot && candidate && candidate.fingerprint === clip.sourceFingerprint, '只能使用当前镜头已登记并审核的候选素材');
    requireFilm(!seen.has(clip.id), '镜头不能重复'); seen.add(clip.id);
    requireFilm(clip.framing.scale === 1 && clip.framing.offsetX === 0 && clip.framing.offsetY === 0, '本阶段保留原包装构图，不支持裁切');
    requireFilm([clip.timelineInFrame, clip.timelineOutFrame, clip.sourceInFrame, clip.sourceOutFrame].every(Number.isSafeInteger), '镜头必须按整数帧编辑');
    requireFilm(clip.timelineInFrame === cursor && clip.timelineOutFrame > cursor, '镜头必须连续，不能留下空白或重叠');
    requireFilm((clip.playbackRate ?? 1) === shot.rate, '本阶段保留原镜头速度');
    const duration = clip.timelineOutFrame - clip.timelineInFrame;
    requireFilm(Math.abs((clip.sourceOutFrame - clip.sourceInFrame) - duration * shot.rate) <= 1, '源片截取长度与时间线不匹配');
    const original = initial.clips.find(c => c.id === clip.id)!;
    const unchangedSource = original.videoJobId === clip.videoJobId && original.sourceInFrame === clip.sourceInFrame && original.sourceOutFrame === clip.sourceOutFrame;
    const inSec = unchangedSource ? shot.inSec : clip.sourceInFrame / 24;
    const tail = isClassicSpec(base) && clip.timelineOutFrame !== timeline.bodyFrames ? 4 : 0;
    const outSec = inSec + (duration + tail) / 24 * shot.rate;
    requireFilm(inSec >= candidate.approvedRangeSec[0] - 1e-7 && outSec <= Math.min(candidate.durationSec, candidate.approvedRangeSec[1]) + 1e-7,
      '截取区间超出已审核素材范围（含转场余量）');
    cursor = clip.timelineOutFrame;
    return { ...shot, file: candidate.file, startFrame: clip.timelineInFrame + 20, endFrame: clip.timelineOutFrame + 20,
      inSec, approvedSourceRangeSec: candidate.approvedRangeSec };
  });
  requireFilm(cursor === timeline.bodyFrames, '镜头必须完整覆盖正文');
  if (isClassicSpec(result) && isClassicSpec(base)) {
    result.classic.callouts = base.classic.callouts.map(callout => {
      const before = base.shots.find(s => s.id === callout.shot)!;
      const after = result.shots.find(s => s.id === callout.shot)!;
      const delta = after.startFrame - before.startFrame;
      return { ...callout, startFrame: callout.startFrame + delta, endFrame: callout.endFrame + delta,
        ...(callout.dotKeyframes ? { dotKeyframes: callout.dotKeyframes.map(k => ({ ...k, frame: k.frame + delta })) } : {}) };
    });
  }
  return parseRenderSpec(result);
}
