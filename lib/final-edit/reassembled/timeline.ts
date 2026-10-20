import type { RenderSpec } from '../../film-render/types.ts';
import { isClassicSpec } from '../../film-render/types.ts';
import { parseRenderSpec } from '../../film-render/spec.ts';
import type { VideoTimeline } from '../types.ts';
import type { RegisteredCandidate } from './types.ts';
import { FinalEditError } from '../errors.ts';
import { applyFilmContent } from './content.ts';
import { roundEven } from '../../film-render/python-format.ts';

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

/** Film edits preserve the soundtrack and every other clip's placement. */
export function changeFilmPlaybackRate(timeline: VideoTimeline, clipId: string, playbackRate: number): void {
  if (!Number.isFinite(playbackRate) || playbackRate < 0.25 || playbackRate > 4) {
    throw new FinalEditError('invalid_video_playback_rate', '视频倍速须在 0.25–4 倍之间');
  }
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) throw new FinalEditError('clip_not_found', '视频片段不存在', 404);
  if ((clip.playbackRate ?? 1) === playbackRate) return;
  clip.sourceOutFrame = clip.sourceInFrame + Math.round((clip.timelineOutFrame - clip.timelineInFrame) * playbackRate);
  clip.playbackRate = playbackRate;
}

/** Explicit ripple edit: other source ranges and all human content remain unchanged. */
export function changeFilmClipDuration(timeline: VideoTimeline, clipId: string, durationFrames: number): void {
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) throw new FinalEditError('clip_not_found', '视频片段不存在', 404);
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 12) {
    throw new FinalEditError('invalid_film_duration', '镜头时长须为至少 12 帧的整数');
  }
  const delta = durationFrames - (clip.timelineOutFrame - clip.timelineInFrame);
  const bodyFrames = timeline.bodyFrames + delta;
  if (!Number.isSafeInteger(bodyFrames) || bodyFrames + 20 < 360) {
    throw new FinalEditError('invalid_film_duration', '调整后成片须至少 15 秒（含 20 帧封面）');
  }
  if (delta === 0) return;
  const sourceOut = clip.sourceInFrame + Math.round(durationFrames * (clip.playbackRate ?? 1));
  if (!Number.isSafeInteger(sourceOut)) throw new FinalEditError('invalid_film_duration', '镜头源区间无效');
  const oldEnd = clip.timelineOutFrame;
  for (const other of timeline.clips) {
    if (other.id !== clip.id && other.timelineInFrame >= oldEnd) {
      other.timelineInFrame += delta;
      other.timelineOutFrame += delta;
    }
  }
  clip.timelineOutFrame += delta;
  clip.sourceOutFrame = sourceOut;
  timeline.bodyFrames = bodyFrames;
}

function requireDurationDependencies(spec: RenderSpec, baseFrames: number): void {
  const frames = spec.canvas.frames;
  const conflicts: string[] = [];
  for (const cue of spec.subtitles) if (cue.endFrame > frames) conflicts.push(`字幕“${cue.text}”超出新片尾`);
  for (const [i, voice] of spec.audio.voices.entries()) {
    if (voice.atFrame * 2000 + roundEven(voice.trimEnd * 48000) - roundEven(voice.trimStart * 48000) > frames * 2000) {
      conflicts.push(`第 ${i + 1} 段配音超出新片尾，不能自动截断`);
    }
  }
  if (spec.audio.music.fadeInSec > frames / 24 || spec.audio.music.fadeOutSec > frames / 24) conflicts.push('音乐淡变时长超过新片长');
  if (isClassicSpec(spec)) {
    for (const callout of spec.classic.callouts) {
      const shot = spec.shots.find(s => s.id === callout.shot);
      if (shot && (callout.startFrame < shot.startFrame || callout.endFrame > shot.endFrame)) conflicts.push(`标注“${callout.title}”超出镜头 ${callout.shot}，请先调整标注时间`);
    }
  } else if (frames < baseFrames && spec.packaging.enabled !== false && (spec.packaging.pointCuesMode ?? 'timed') === 'timed') {
    for (const cue of spec.packaging.pointCues ?? []) if (cue.endSec > frames / 24) conflicts.push(`卖点“${cue.text}”超出新片尾，请先调整卖点时间`);
  }
  if (conflicts.length) throw new FinalEditError('film_duration_dependency', conflicts.join('；'), 409, { conflicts });
}

/** Audio/content snapshots are kept; every accepted timeline edit is projected. */
export function projectFilmTimeline(base: RenderSpec, timeline: VideoTimeline, candidates: RegisteredCandidate[]): RenderSpec {
  requireFilm(timeline.fps === 24 && timeline.introFrames === 20 && Number.isSafeInteger(timeline.bodyFrames) && timeline.bodyFrames >= 340,
    '成片须保持 24fps、20 帧封面，总长至少 15 秒');
  requireFilm(!timeline.audio && timeline.clips.length === base.shots.length, '本阶段不支持增删镜头或修改音轨');
  const initial = filmTimeline(base, candidates);
  const result = applyFilmContent(base, timeline.filmContent);
  result.canvas.frames = timeline.bodyFrames + 20;
  if (isClassicSpec(result) && result.canvas.frames !== base.canvas.frames && result.classic.durationText !== undefined) {
    result.classic.durationText = String(result.canvas.frames / 24);
  }
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
    const rate = clip.playbackRate ?? 1;
    requireFilm(Number.isFinite(rate) && (rate === shot.rate || (rate >= 0.25 && rate <= 4)), '视频倍速须在 0.25–4 倍之间');
    const duration = clip.timelineOutFrame - clip.timelineInFrame;
    requireFilm(Math.abs((clip.sourceOutFrame - clip.sourceInFrame) - duration * rate) <= 1, '源片截取长度与时间线不匹配');
    const original = initial.clips.find(c => c.id === clip.id)!;
    const unchangedSource = original.videoJobId === clip.videoJobId && original.sourceInFrame === clip.sourceInFrame;
    const inSec = unchangedSource ? shot.inSec : clip.sourceInFrame / 24;
    const tail = isClassicSpec(result) && clip.timelineOutFrame !== timeline.bodyFrames ? 4 : 0;
    const outSec = inSec + (duration + tail) / 24 * rate;
    requireFilm(inSec >= candidate.approvedRangeSec[0] - 1e-7 && outSec <= Math.min(candidate.durationSec, candidate.approvedRangeSec[1]) + 1e-7,
      '截取区间超出已审核素材范围（含转场余量）');
    cursor = clip.timelineOutFrame;
    return { ...shot, file: candidate.file, startFrame: clip.timelineInFrame + 20, endFrame: clip.timelineOutFrame + 20,
      inSec, rate, approvedSourceRangeSec: candidate.approvedRangeSec };
  });
  requireFilm(cursor === timeline.bodyFrames, '镜头必须完整覆盖正文');
  if (isClassicSpec(result) && isClassicSpec(base)) {
    result.classic.callouts = result.classic.callouts.map(callout => {
      const before = base.shots.find(s => s.id === callout.shot)!;
      const after = result.shots.find(s => s.id === callout.shot)!;
      requireFilm(before && after, '标注只能关联本条成片中的镜头');
      const delta = after.startFrame - before.startFrame;
      return { ...callout, startFrame: callout.startFrame + delta, endFrame: callout.endFrame + delta,
        ...(callout.dotKeyframes ? { dotKeyframes: callout.dotKeyframes.map(k => ({ ...k, frame: k.frame + delta })) } : {}) };
    });
  }
  if (result.canvas.frames !== base.canvas.frames) requireDurationDependencies(result, base.canvas.frames);
  try { return parseRenderSpec(result); }
  catch (error) { throw new FinalEditError('film_content_invalid', error instanceof Error ? error.message : String(error), 400); }
}
