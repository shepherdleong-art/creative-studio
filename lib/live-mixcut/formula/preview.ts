import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { PreviewAudioTimeline } from '../../media-core/preview-audio-timeline.ts';
import { BatchDomainError } from '../errors.ts';
import { projectAssetFileIdentity, projectAssetMimeType } from '../project-asset-media.ts';
import { resolveSourceFilePath } from '../media-catalog.ts';
import { assertFormulaNarrationAudio } from './narration.ts';
import type { FormulaNarrationStageResult } from './narration-store.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate } from './candidate-media.ts';
import type { FormulaSelection } from './selection.ts';
import { readFormulaTimeline } from './timeline-store.ts';
import { readFormulaSelectionHistory } from './reselection.ts';
import { getBatchOutputArrangementView } from '../output-arrangement.ts';
import { resolveFormulaPreviewMusic, type FormulaMusicPreviewIdentity } from './preview-music.ts';
import { readFormulaManualMedia } from './manual-media.ts';
import { readFormulaScheduleOutputOwner, resolveFormulaScheduleMedia } from './schedule.ts';

export interface FormulaPreview {
  selectionStageId: string; timelineStageId: string; readOnly: boolean;
  clips: Array<{ clipId: string; assetId: string; sourceStartUs: number; sourceEndUs: number;
    timelineStartUs: number; timelineEndUs: number; playbackRate: number }>;
  assetsById: Record<string, { previewUrl: string; originalUrl: string }>;
  audioTimeline: PreviewAudioTimeline;
  subtitleCues: Array<{ id: string; text: string; startUs: number; endUs: number }>;
}
export interface FormulaPreviewView {
  status: 'ready' | 'pending' | 'needs_attention'; message: string; preview: FormulaPreview | null;
}

/** 只读投影已保存的排片结果；不创建可审核版本，不触发重新排片或声音生成。 */
function context(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId?: string, timelineStageId?: string) {
  const view = readFormulaTimeline(db, projectId, batchId, planId, selectionStageId);
  if (timelineStageId && view.stageId !== timelineStageId) throw new BatchDomainError('not_found', '这份排片预览不存在');
  if (!view.stageId || view.result?.status !== 'planned') return { view, saved: null };
  const row = db.prepare(`SELECT s.resultJson AS selectionJson,n.resultJson AS narrationJson
    FROM live_mixcut_formula_selection_results s LEFT JOIN live_mixcut_formula_narration_results n ON n.stageId=? WHERE s.stageId=?`)
    .get(view.result.narrationStageId, view.selectionStageId) as { selectionJson: string; narrationJson: string | null } | undefined;
  if (!row) throw new BatchDomainError('conflict', '排片缺少选片依据');
  const selection: FormulaSelection = JSON.parse(row.selectionJson);
  const narration: FormulaNarrationStageResult | null = row.narrationJson ? JSON.parse(row.narrationJson) : null;
  if (selection.status !== 'selected') throw new BatchDomainError('conflict', '选片尚未完成');
  const timeline = view.result;
  for (const clip of timeline.duration.clips) {
    const slot = selection.slots.find(slot => slot.slotId === clip.slotId);
    if (!slot?.candidate || slot.assetId !== clip.assetId || slot.candidate.contentFingerprint !== clip.contentFingerprint
      || clip.sourceInUs < 0 || clip.sourceOutUs > slot.candidate.media.durationUs) throw new BatchDomainError('conflict', '排片画面与保存的来源不一致');
  }
  for (const clip of timeline.audio) {
    if (clip.kind === 'source') {
      const source = selection.slots.find(slot => slot.slotId === clip.linkGroupId)?.candidate;
      if (!source || source.assetId !== clip.assetId || source.sourceId !== clip.sourceId || source.contentFingerprint !== clip.contentFingerprint
        || clip.sourceOutUs > source.media.durationUs) throw new BatchDomainError('conflict', '排片原声与保存的来源不一致');
    } else {
      const item = narration?.items.find(item => item.id === clip.narrationId);
      if (!item || clip.narrationStageId !== timeline.narrationStageId || item.audio.fingerprint !== clip.contentFingerprint
        || item.audio.relativePath !== clip.relativePath || clip.sourceOutUs > item.audio.durationUs) throw new BatchDomainError('conflict', '排片配音与保存的来源不一致');
    }
  }
  return { view, saved: { timeline, selection, narration } };
}

export function readFormulaPreview(db: Database.Database, projectId: string, batchId: string, planId: string): FormulaPreviewView {
  const { view, saved } = context(db, projectId, batchId, planId);
  if (!saved) {
    const current = readFormulaSelectionHistory(db, projectId, batchId, planId).current;
    const failed = [view.taskStatus, current.task?.status, current.audioMapping.taskStatus].some(status => status === 'failed' || status === 'cancelled')
      || view.result?.status === 'needs_attention' || current.result?.status === 'needs_attention' || current.speech.status === 'needs_attention'
      || current.audioMapping.result?.status === 'needs_attention' || ['unconfigured', 'needs_attention'].includes(current.narration.status);
    return { status: failed ? 'needs_attention' : 'pending', preview: null,
      message: failed ? '画面或声音需要处理，请查看右侧的选片、声音和时长记录。' : '正在准备画面和声音，完成后可在这里播放。' };
  }
  const { timeline, selection, narration } = saved;
  const current = getBatchOutputArrangementView(db, projectId, batchId, planId);
  if (current.outputVersionId && current.formulaPreview) {
    return { status: 'ready', message: current.formulaPreview.message, preview: {
      selectionStageId: view.selectionStageId, timelineStageId: view.stageId!, readOnly: !current.editable,
      clips: current.clips.map(clip => ({ ...clip, playbackRate: clip.playbackRate ?? 1 })),
      assetsById: { ...Object.fromEntries(current.poolAssets.map(asset => [asset.assetId, { previewUrl: asset.previewUrl,
        originalUrl: `/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}` }])),
        ...current.formulaPreview.assetsById },
      audioTimeline: current.formulaPreview.audioTimeline, subtitleCues: current.subtitleCues,
    } };
  }
  const url = (kind: 'video' | 'audio', mediaId: string) => {
    const query = new URLSearchParams({ projectId, selectionStageId: view.selectionStageId, timelineStageId: view.stageId!, kind, mediaId });
    return `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/preview/media?${query}`;
  };
  const assetsById: FormulaPreview['assetsById'] = {};
  const clips = timeline.duration.clips.map(clip => {
    const mediaUrl = url('video', clip.slotId);
    assetsById[clip.assetId] ??= { previewUrl: mediaUrl, originalUrl: mediaUrl };
    return { clipId: clip.slotId, assetId: clip.assetId, sourceStartUs: clip.sourceInUs, sourceEndUs: clip.sourceOutUs,
      timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs, playbackRate: 1 as const };
  });
  return { status: 'ready', message: '画面与声音预览；封面、包装、背景音乐和时间轴编辑尚未接入。', preview: {
    selectionStageId: view.selectionStageId, timelineStageId: view.stageId!, readOnly: true, clips, assetsById,
    audioTimeline: { revisionId: view.stageId!, bodyDurationUs: timeline.duration.bodyDurationUs, clips: timeline.audio.map(clip => ({
      id: clip.id, kind: clip.kind, url: url('audio', clip.id),
      sourceDurationUs: clip.kind === 'source' ? selection.slots.find(slot => slot.slotId === clip.linkGroupId)!.candidate!.media.durationUs
        : narration!.items.find(item => item.id === clip.narrationId)!.audio.durationUs,
      sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs, gainDb: 0,
    })) }, subtitleCues: timeline.words.map(word => ({ id: word.id, text: word.text, startUs: word.startUs, endUs: word.endUs })),
  } };
}

/** URL 只包含已保存的身份；每次读取重验实际文件，不接受客户端路径或任意素材 ID。 */
export async function resolveFormulaPreviewMedia(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId: string, timelineStageId: string, kind: string, mediaId: string, signal: AbortSignal, musicIdentity?: FormulaMusicPreviewIdentity) {
  if (!selectionStageId || !timelineStageId || !mediaId || !['video', 'audio', 'music'].includes(kind)) throw new BatchDomainError('invalid_input', '缺少有效的预览来源');
  if (kind === 'music') return resolveFormulaPreviewMusic(db, projectId, batchId, planId, selectionStageId, timelineStageId, mediaId, musicIdentity, signal);
  // 新规矩的成片没有旧时间轴：画面和声音从排时间结果里认，旧批次照旧读旧表。
  const outputVersionId = musicIdentity?.outputVersionId ?? '';
  const scheduled = outputVersionId
    ? readFormulaScheduleOutputOwner(db, outputVersionId, timelineStageId, selectionStageId) : null;
  const { saved } = scheduled ? { saved: null } : context(db, projectId, batchId, planId, selectionStageId, timelineStageId);
  if (!scheduled && !saved) throw new BatchDomainError('not_found', '排片预览尚未就绪');
  signal.throwIfAborted();
  if (mediaId.startsWith('manual-media:')) {
    const current = () => {
      if (scheduled) {
        if (!readFormulaScheduleOutputOwner(db, outputVersionId, timelineStageId, selectionStageId)) {
          throw new BatchDomainError('conflict', '排片预览已变化，请刷新');
        }
      } else context(db, projectId, batchId, planId, selectionStageId, timelineStageId);
      const view = getBatchOutputArrangementView(db, projectId, batchId, planId);
      if (!musicIdentity?.outputVersionId || view.outputVersionId !== musicIdentity.outputVersionId
        || !view.clips.some(clip => clip.formulaSourceId === mediaId)
        || (kind === 'audio' && !view.audioPlan?.clips.some(clip => clip.mediaId === mediaId && clip.kind === 'source'))) {
        throw new BatchDomainError('conflict', '人工素材不属于当前成片');
      }
      return view;
    };
    const view = current();
    const proof = readFormulaManualMedia(db, projectId, view.outputVersionId!, mediaId);
    if (kind === 'audio' && proof.sound !== 'source') throw new BatchDomainError('conflict', '这份人工素材未确认保留原声');
    const candidate = proof.candidate;
    const verified = await verifyFormulaCandidate(db, projectId, candidate.assetId, candidate.contentFingerprint,
      [{ id: candidate.sourceId, location: candidate.location }], signal);
    if (!verified || (kind === 'audio' && !verified.media.hasAudio)) throw new BatchDomainError('conflict', '人工素材已变化，请重新核验');
    recheckFormulaCandidate(db, projectId, verified);
    current();
    const absolutePath = resolveSourceFilePath(verified.location);
    return { absolutePath, identity: verified.fileIdentity, mimeType: projectAssetMimeType(absolutePath) };
  }
  if (scheduled) {
    const media = await resolveFormulaScheduleMedia(db, projectId, batchId, planId, selectionStageId, timelineStageId,
      outputVersionId, kind, mediaId, signal);
    // 读取期间身份没变，才把文件交出去。
    if (!readFormulaScheduleOutputOwner(db, outputVersionId, timelineStageId, selectionStageId)) {
      throw new BatchDomainError('conflict', '排片预览已变化，请刷新');
    }
    return media;
  }
  const sound = kind === 'audio' ? saved!.timeline.audio.find(clip => clip.id === mediaId) : null;
  if (kind === 'audio' && !sound) throw new BatchDomainError('not_found', '这段声音不属于当前排片');
  if (sound?.kind === 'narration') {
    const item = saved!.narration!.items.find(item => item.id === sound.narrationId)!;
    const absolutePath = assertFormulaNarrationAudio(projectId, item.text, item.audio);
    return { absolutePath, identity: projectAssetFileIdentity(fs.statSync(absolutePath)), mimeType: 'audio/wav' };
  }
  const slotId = sound?.linkGroupId ?? mediaId;
  if (!saved!.timeline.duration.clips.some(clip => clip.slotId === slotId)) throw new BatchDomainError('not_found', '这段画面不属于当前排片');
  const candidate = saved!.selection.slots.find(slot => slot.slotId === slotId)!.candidate!;
  const verified = await verifyFormulaCandidate(db, projectId, candidate.assetId, candidate.contentFingerprint,
    [{ id: candidate.sourceId, location: candidate.location }], signal);
  if (!verified || (sound && !verified.media.hasAudio)) throw new BatchDomainError('conflict', '原片或声音已变化，请重新核验');
  recheckFormulaCandidate(db, projectId, verified);
  const absolutePath = resolveSourceFilePath(verified.location);
  return { absolutePath, identity: verified.fileIdentity, mimeType: projectAssetMimeType(absolutePath) };
}
