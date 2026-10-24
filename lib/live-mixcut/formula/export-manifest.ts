import type Database from 'better-sqlite3';
import path from 'node:path';
import { getBatchOutputArrangementView } from '../output-arrangement.ts';
import { resolveFullRenderContractHash } from '../cover-contract.ts';
import { BatchDomainError } from '../errors.ts';
import { readFormulaGenerationRequest, type FormulaGenerationRequest } from './generation.ts';
import { readFormulaOutputAudioPlan } from './output-audio.ts';
import { effectiveFormulaOutputBasis } from './manual-audio-basis.ts';
import { readFormulaMusicSource } from './output-music.ts';
import { readFormulaExportIdentity } from './export-identity.ts';
import type { FormulaSelection } from './selection.ts';
import { describeFormulaDeviations } from './deviations.ts';
import { readFormulaManualMedia } from './manual-media.ts';
import type { FormulaAudioMapping } from './audio-mapping.ts';
import type { FormulaTimelineResult } from './timeline.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../../media-core/render-contract.ts';

interface FormulaExportManifestFile { artifactId: string; filename: string; checksum: string }
export interface FormulaExportManifest {
  items: Array<ReturnType<typeof captureFormulaManifestItem> & { video: FormulaExportManifestFile; coverFile: FormulaExportManifestFile }>;
}

export function csvCell(value: unknown): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** CSV columns are projected from one frozen manifest. */
export function csvManifest(manifest: FormulaExportManifest): string {
  const rows: unknown[][] = [['原脚本号', '份次', '原始公式', '应用公式', '脚本文案', '实际用片及源区间', '人工偏离',
    '声音', '音乐', '包装', '封面设置', '字幕', '输出版本', '编辑修订', '渲染身份', '视频文件', '视频校验值', '封面文件', '封面校验值']];
  for (const item of manifest.items) rows.push([item.scriptNumber, item.copyIndex, item.originalFormula, item.appliedFormula,
    item.bodyText, item.clips, item.deviations, item.audio, item.music, item.packaging, item.cover, item.subtitles,
    item.outputVersionId, item.editRevision, item.fullRenderContractHash, item.video.filename, item.video.checksum,
    item.coverFile.filename, item.coverFile.checksum]);
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Only explicit public fields enter a manifest: never spread frozen inputs, providers or storage locations. */
export function captureFormulaManifestItem(db: Database.Database, projectId: string, batchId: string, planId: string,
  requests: Map<string, FormulaGenerationRequest>) {
  const view = getBatchOutputArrangementView(db, projectId, batchId, planId);
  if (!view.outputVersionId || !view.reviewContext) throw new BatchDomainError('conflict', '成片缺少当前版本或审核依据');
  const row = db.prepare(`SELECT o.arrangementJson,s.requestId,x.resultJson FROM live_mixcut_output_versions o
    JOIN live_mixcut_formula_stages s ON s.id=json_extract(o.arrangementJson,'$.formula.selectionStageId')
    JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id WHERE o.id=? AND s.planId=?`)
    .get(view.outputVersionId, planId) as { arrangementJson: string; requestId: string; resultJson: string } | undefined;
  if (!row) throw new BatchDomainError('conflict', '成片缺少公式选片记录');
  let request = requests.get(row.requestId);
  if (!request) { request = readFormulaGenerationRequest(db, projectId, batchId, row.requestId); requests.set(row.requestId, request); }
  const output = request.outputs.find(item => item.planId === planId);
  const script = request.input.scripts.find(item => item.key === output?.scriptKey);
  if (!output || !script) throw new BatchDomainError('conflict', '成片缺少原脚本记录');
  const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
  const basis = effectiveFormulaOutputBasis(db, projectId, view.outputVersionId, arrangement);
  const audio = readFormulaOutputAudioPlan(arrangement.audioPlan);
  if (!basis || !audio) throw new BatchDomainError('conflict', '成片缺少声音记录');
  const mappingRow = db.prepare(`SELECT m.stageId,m.resultJson,r.resultJson AS timelineJson FROM live_mixcut_formula_timeline_stages t
    JOIN live_mixcut_formula_timeline_results r ON r.stageId=t.id
    JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=t.audioMappingStageId
    JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=m.stageId
    WHERE t.id=? AND a.selectionStageId=?`).get(basis.timelineStageId, basis.selectionStageId) as
    { stageId: string; resultJson: string; timelineJson: string } | undefined;
  const mapping = mappingRow ? JSON.parse(mappingRow.resultJson) as FormulaAudioMapping : null;
  if (mapping?.status !== 'mapped') throw new BatchDomainError('conflict', '成片缺少对应版本的文案与声音分配记录');
  const timeline: FormulaTimelineResult | null = mappingRow?.timelineJson ? JSON.parse(mappingRow.timelineJson) : null;
  if (timeline?.status !== 'planned') throw new BatchDomainError('conflict', '成片缺少对应版本的原始排片记录');
  const selection = JSON.parse(row.resultJson) as FormulaSelection;
  const identity = readFormulaExportIdentity(db, { projectId, batchId, planId, outputVersionId: view.outputVersionId, packaging: view.packaging ?? {} });
  const clips = [...view.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.timelineEndUs - b.timelineEndUs).map(clip => {
    const slot = selection.slots.find(slot => slot.slotId === clip.segmentId);
    const replacement = slot?.manualReplacement ?? slot?.replacement;
    const manual = clip.formulaSourceId ? readFormulaManualMedia(db, projectId, view.outputVersionId!, clip.formulaSourceId) : null;
    return {
      clipId: clip.clipId, slotId: slot?.slotId ?? null, originalCode: slot?.logicalCode ?? null,
      selectedCode: slot?.sourceLogicalCode ?? replacement?.replacementCode ?? slot?.logicalCode ?? null,
      actualCodes: [...new Set(request.input.materialIndex.bindings.filter(binding => binding.assetId === clip.assetId
        && binding.contentFingerprint === clip.contentFingerprint).map(binding => binding.logicalCode))],
      assetId: clip.assetId, contentFingerprint: clip.contentFingerprint,
      ...(manual ? { manualMedia: { id: manual.id, origin: manual.origin, sound: manual.sound,
        inUs: manual.inUs, outUs: manual.outUs, protected: manual.protected,
        ...(manual.sound === 'source' ? { segments: manual.segments, previousText: manual.previousText,
          speechConfirmed: manual.speechConfirmed, replaces: manual.replaces } : {}) } } : {}),
      sourceStartUs: clip.sourceStartUs, sourceEndUs: clip.sourceEndUs,
      timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs,
      playbackRate: clip.playbackRate ?? 1, framing: clip.framing ?? null,
      selectionReason: slot?.reason ?? 'manual_insert',
      manualDeviation: !slot ? 'manual_insert' : slot.assetId !== clip.assetId || slot.candidate?.contentFingerprint !== clip.contentFingerprint ? 'source_changed' : null,
      replacement: replacement ? { originalCode: replacement.originalCode, replacementCode: replacement.replacementCode,
        reason: replacement.reason, differences: replacement.differences, basisScope: replacement.basisScope,
        importedSuggestion: slot?.replacement?.importedSuggestion ? {
          sourceId: slot.replacement.importedSuggestion.sourceId, filename: slot.replacement.importedSuggestion.filename,
          fingerprint: slot.replacement.importedSuggestion.fingerprint, originalCode: slot.replacement.importedSuggestion.originalCode,
          replacementCode: slot.replacement.importedSuggestion.replacementCode, sourceLine: slot.replacement.importedSuggestion.sourceLine } : null } : null,
    };
  });
  const deviations = describeFormulaDeviations(selection, view.clips, request.input.materialIndex.bindings, timeline.duration.clips);
  const music = readFormulaMusicSource(arrangement.music);
  const packaging = view.packaging;
  return {
    planId, outputVersionId: view.outputVersionId, versionNumber: view.versionNumber, editRevision: view.editRevision,
    fullRenderContractHash: resolveFullRenderContractHash(db, view.outputVersionId),
    requestId: request.id, selectionStageId: basis.selectionStageId, timelineStageId: basis.timelineStageId,
    scriptNumber: identity.scriptNumber, copyIndex: identity.copyIndex,
    originalFormula: script.original?.['画面分镜(逻辑镜号组合)'] ?? script.originalFormula,
    appliedFormula: script.formula ?? script.originalFormula, bodyText: script.bodyText,
    originalBodyText: script.original?.['脚本文案'] ?? script.bodyText,
    source: { sheet: script.source.sheet, row: script.source.row }, platform: script.platform,
    targetDurationSec: script.targetDurationSec, bodyDurationUs: audio.bodyDurationUs,
    render: { fps: FINAL_EDIT_FPS, introFrames: FINAL_EDIT_INTRO_FRAMES, timelineOrigin: 'body' as const },
    clips, deviations,
    audio: { revision: audio.revision, clips: audio.clips, sources: basis.audioSources.filter(source => audio.clips.some(clip => clip.mediaId === source.mediaId)),
      masterGainDb: view.narration.gainDb, edits: view.audio },
    externalNarrations: (request.input.externalNarrations ?? []).filter(item => basis.audioSources.some(source => source.externalNarrationId === item.id
      && audio.clips.some(clip => clip.mediaId === source.mediaId))).map(item => ({ id: item.id, origin: 'external' as const,
      filename: item.filename, text: item.text, confirmedAt: item.createdAt, fingerprint: item.audio?.fingerprint,
      durationUs: item.audio?.durationUs, channels: item.audio?.channels, timing: 'manually_confirmed_srt' as const, cues: item.audio?.words })),
    scriptAudioMapping: { scope: 'generation_basis' as const, stageId: mappingRow!.stageId, algorithmVersion: mapping.algorithmVersion,
      basis: mapping.basis, manualVerification: mapping.manualVerification ? {
        revisionId: mapping.manualVerification.revisionId, confirmedAt: mapping.manualVerification.confirmedAt } : null,
      blocks: mapping.blocks.map(block => ({ id: block.id, start: block.start, end: block.end, text: block.text, kind: block.kind,
        slotId: block.slotId ?? null, slotIds: block.slotIds ?? null,
        ...(block.displayText ? { displayText: block.displayText } : {}),
        ...(block.roleVerification ? { roleVerification: {
          promptVersion: block.roleVerification.promptVersion, providerId: block.roleVerification.providerId,
          model: block.roleVerification.model, reason: block.roleVerification.reason,
        } } : {}),
        sourceCoverage: block.sourceCoverage ? { kind: block.sourceCoverage.kind, sourceText: block.sourceCoverage.sourceText,
          ...(block.sourceCoverage.verification ? { verification: {
            promptVersion: block.sourceCoverage.verification.promptVersion, providerId: block.sourceCoverage.verification.providerId,
            model: block.sourceCoverage.verification.model, reason: block.sourceCoverage.verification.reason,
          } } : {}) } : null })),
      sources: mapping.sources.map(source => ({ slotId: source.slotId, assetId: source.assetId,
        contentFingerprint: source.contentFingerprint, speechStageId: source.speechStageId, text: source.text })),
      issues: mapping.issues.map(issue => ({ code: issue.code, message: issue.message, slotIds: issue.slotIds,
        scriptText: issue.scriptText ?? null, sourceText: issue.sourceText ?? null })) },
    manualSourceSpeech: (request.input.manualSpeech ?? []).filter(source => clips.some(clip => clip.assetId === source.assetId
      && clip.contentFingerprint === source.contentFingerprint)).map(source => ({ revisionId: source.id,
      assetId: source.assetId, contentFingerprint: source.contentFingerprint, origin: 'manual' as const,
      mode: source.mode, verifiedAt: source.createdAt, timing: 'manual_segments' as const,
      segments: source.segments.map(({ text, startUs, endUs }) => ({ text, startUs, endUs })) })),
    subtitles: view.subtitleCues, subtitleStyle: view.subtitleStyle,
    music: music ? { trackId: music.trackId, checksum: music.fileFingerprint, filename: path.basename(music.relativePath),
      durationUs: music.durationUs, gainDb: view.music.gainDb, fadeInSec: view.music.fadeInSec, fadeOutSec: view.music.fadeOutSec,
      ducking: view.music.ducking, edits: view.audio?.bgm } : null,
    packaging: { code: identity.packagingCode, enabled: packaging?.enabled ?? false, template: packaging?.template,
      varsOverrides: packaging?.varsOverrides, pointCues: packaging?.pointCues, pointCuesMode: packaging?.pointCuesMode,
      layouts: packaging?.layouts, fonts: { title: packaging?.titleFont?.family, subtitle: packaging?.subtitleFont?.family, points: packaging?.pointFont?.family } },
    cover: { assetId: view.coverAssetId, timeUs: view.coverTimeUs, framing: view.coverFraming,
      primary: view.coverTitle?.primary, secondary: view.coverTitle?.secondary, styles: view.coverTitle?.styles },
    reviewedIssueSetHash: view.reviewContext.issueSetHash,
  };
}
