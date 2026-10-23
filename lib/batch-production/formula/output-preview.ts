import type { PreviewAudioTimeline } from '../../media-core/preview-audio-timeline.ts';
import { BatchDomainError } from '../errors.ts';
import { readFormulaOutputAudioPlan, readFormulaOutputBasis, type FormulaOutputBasis } from './output-audio.ts';
import { readFormulaMusicSource } from './output-music.ts';
import { buildMusicTimeline } from '../../media-core/music-timeline.ts';
import { parseAudioEdits } from '../../media-core/audio-edit.ts';

export interface FormulaOutputPreviewMedia {
  audioTimeline: PreviewAudioTimeline;
  assetsById: Record<string, { previewUrl: string; originalUrl: string }>;
  message: string;
  music?: { fileUrl: string; sourceFingerprint: string; filename: string; durationUs: number } | null;
  musicError?: string;
}

/** 读取当前编辑版本的坐标；URL 固定原排片的真实媒体身份，切片不生成假音源。 */
export function formulaOutputPreviewMedia(projectId: string, batchId: string, planId: string, outputVersionId: string,
  arrangement: Record<string, unknown>, gainDb: number, effectiveBasis?: FormulaOutputBasis): FormulaOutputPreviewMedia | undefined {
  const basis = effectiveBasis ?? readFormulaOutputBasis(arrangement.formula);
  if (!basis) return undefined;
  const plan = readFormulaOutputAudioPlan(arrangement.audioPlan);
  if (!plan) throw new BatchDomainError('conflict', '公式成片缺少声音计划');
  const url = (kind: 'audio' | 'video', mediaId: string) => {
    const query = new URLSearchParams({ projectId, outputVersionId, selectionStageId: basis.selectionStageId, timelineStageId: basis.timelineStageId, kind, mediaId });
    return `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/preview/media?${query}`;
  };
  const assetsById: FormulaOutputPreviewMedia['assetsById'] = {};
  for (const video of basis.videoSources ?? []) {
    const mediaUrl = url('video', video.mediaId);
    assetsById[video.assetId] ??= { previewUrl: mediaUrl, originalUrl: mediaUrl };
  }
  for (const clip of (arrangement.clips ?? []) as Array<Record<string, unknown>>) {
    if (typeof clip.formulaSourceId !== 'string' || typeof clip.assetId !== 'string') continue;
    const mediaUrl = url('video', clip.formulaSourceId);
    assetsById[clip.assetId] = { previewUrl: mediaUrl, originalUrl: mediaUrl };
  }
  let music: FormulaOutputPreviewMedia['music'] = null;
  let musicError: string | undefined;
  try {
    const source = readFormulaMusicSource(arrangement.music);
    if (source) {
      buildMusicTimeline(parseAudioEdits(arrangement.audio)?.bgm, plan.bodyDurationUs, source.durationUs);
      const query = new URLSearchParams({ projectId, selectionStageId: basis.selectionStageId, timelineStageId: basis.timelineStageId,
        kind: 'music', mediaId: source.trackId, outputVersionId, sourceFingerprint: source.fileFingerprint });
      music = { fileUrl: `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/preview/media?${query}`,
        sourceFingerprint: source.fileFingerprint, filename: source.relativePath.split(/[\\/]/).at(-1)!, durationUs: source.durationUs };
    }
  } catch (error) { musicError = error instanceof Error ? error.message : '音乐来源无法读取'; }
  return { assetsById, music, musicError, message: '可编辑画面、声音、字幕和包装；修改后会重新检查，请检查通过后再确认。',
    audioTimeline: { revisionId: `${outputVersionId}:${arrangement.editRevision ?? 0}:${plan.revision}`, bodyDurationUs: plan.bodyDurationUs,
      clips: plan.clips.map(clip => {
        const source = basis.audioSources.find(source => source.mediaId === clip.mediaId);
        if (!source || source.kind !== clip.kind || clip.sourceOutUs > source.sourceDurationUs) throw new BatchDomainError('conflict', '预览声音来源与当前计划不一致');
        return { id: clip.id, kind: clip.kind, url: url('audio', clip.mediaId), sourceDurationUs: source.sourceDurationUs,
          sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs,
          gainDb: Math.max(-60, Math.min(24, clip.gainDb + gainDb)) };
      }) } };
}
