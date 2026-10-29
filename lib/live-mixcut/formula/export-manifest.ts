import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from '../../data-root.ts';
import { getBatchWorkspace } from '../batch-workspace.ts';
import { getBatchOutputArrangementView } from '../output-arrangement.ts';
import { readLiveMixcutProject } from '../projects.ts';
import { listProjectBatchProductions } from '../versions.ts';
import { resolveFullRenderContractHash } from '../cover-contract.ts';
import { BatchDomainError } from '../errors.ts';
import { readFormulaGenerationRequest, type FormulaGenerationRequest } from './generation.ts';
import { readFormulaOutputAudioPlan, type FormulaOutputBasis } from './output-audio.ts';
import { effectiveFormulaOutputBasis } from './manual-audio-basis.ts';
import { schedulePresentationTimeline } from './schedule-output.ts';
import type { FormulaScheduleStageResult } from './schedule.ts';
import { readFormulaMusicSource } from './output-music.ts';
import { readFormulaExportIdentity } from './export-identity.ts';
import type { FormulaSelection } from './selection.ts';
import { describeFormulaDeviations, describeScheduleFormulaDeviations } from './deviations.ts';
import { readFormulaManualMedia } from './manual-media.ts';
import type { FormulaAudioMapping } from './audio-mapping.ts';
import type { FormulaTimelineResult } from './timeline.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../../media-core/render-contract.ts';
import { isLiveMixcutExportedFile, liveMixcutExportRelativeDir,
  parseLiveMixcutExportedVideo } from '../export-paths.ts';

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

/** 每一行文案由哪段声音说、声音从哪来、逐字时间；再加上审片标记和提醒。 */
function scheduleScriptAudioMapping(schedule: FormulaScheduleStageResult, stageId: string, basis: FormulaOutputBasis) {
  const soundsByLine = new Map<number, (typeof schedule.timeline.sounds)[number]>();
  for (const sound of schedule.timeline.sounds) for (const index of sound.lineIndexes) soundsByLine.set(index, sound);
  return {
    scope: 'schedule' as const, stageId,
    algorithmVersion: schedule.timeline.algorithmVersion, mode: schedule.plan.mode,
    lines: schedule.plan.lines.map(line => {
      const sound = soundsByLine.get(line.index);
      return {
        lineIndex: line.index, text: line.text,
        spokenBy: line.fate?.type === 'source'
          ? { kind: 'source' as const, logicalCode: line.fate.logicalCode, basis: line.fate.basis }
          : { kind: 'narration' as const },
        ...(sound ? { soundId: sound.id, timelineStartUs: sound.timelineStartUs, timelineEndUs: sound.timelineEndUs,
          sourceInUs: sound.sourceInUs, sourceOutUs: sound.sourceOutUs,
          ...(sound.relativePath ? { relativePath: sound.relativePath } : {}) } : {}),
        words: sound ? schedule.timeline.words.filter(word => word.soundId === sound.id)
          .map(word => ({ text: word.text, startUs: word.startUs, endUs: word.endUs })) : [],
      };
    }),
    sources: basis.audioSources.filter(source => source.kind === 'source').map(source => ({ slotId: source.slotId ?? null,
      assetId: source.assetId ?? null, mediaId: source.mediaId, contentFingerprint: source.contentFingerprint,
      speechInUs: source.verifiedInUs, speechOutUs: source.verifiedOutUs, sourceDurationUs: source.sourceDurationUs,
      words: source.words })),
    narrations: basis.audioSources.filter(source => source.kind === 'narration').map(source => ({ mediaId: source.mediaId,
      contentFingerprint: source.contentFingerprint, sourceDurationUs: source.sourceDurationUs, words: source.words })),
    marks: schedule.timeline.marks, warnings: schedule.timeline.warnings,
  };
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
  const selection = JSON.parse(row.resultJson) as FormulaSelection;
  // 新规矩的成片从「排时间」出来：basis.timelineStageId 指向排时间阶段，没有旧链的音频映射记录。
  const scheduleRow = db.prepare(`SELECT sc.id AS stageId,r.resultJson FROM live_mixcut_formula_schedule_stages sc
    JOIN live_mixcut_formula_schedule_results r ON r.stageId=sc.id
    WHERE sc.id=? AND sc.selectionStageId=?`).get(basis.timelineStageId, basis.selectionStageId) as
    { stageId: string; resultJson: string } | undefined;
  const schedule = scheduleRow ? JSON.parse(scheduleRow.resultJson) as FormulaScheduleStageResult : null;
  const mappingRow = schedule ? undefined : db.prepare(`SELECT m.stageId,m.resultJson,r.resultJson AS timelineJson FROM live_mixcut_formula_timeline_stages t
    JOIN live_mixcut_formula_timeline_results r ON r.stageId=t.id
    JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=t.audioMappingStageId
    JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=m.stageId
    WHERE t.id=? AND a.selectionStageId=?`).get(basis.timelineStageId, basis.selectionStageId) as
    { stageId: string; resultJson: string; timelineJson: string } | undefined;
  const mapping = mappingRow ? JSON.parse(mappingRow.resultJson) as FormulaAudioMapping : null;
  // 旧规矩（时间轴）才走音频映射；新规矩没有这条记录，按排时间结果记。
  let legacyMapping: Extract<FormulaAudioMapping, { status: 'mapped' }> | null = null;
  if (!schedule) {
    if (mapping?.status !== 'mapped') throw new BatchDomainError('conflict', '成片缺少对应版本的文案与声音分配记录');
    legacyMapping = mapping;
  }
  const timeline: FormulaTimelineResult | null = schedule
    ? schedulePresentationTimeline(scheduleRow!.stageId, schedule, selection)
    : mappingRow?.timelineJson ? JSON.parse(mappingRow.timelineJson) : null;
  if (timeline?.status !== 'planned') throw new BatchDomainError('conflict', '成片缺少对应版本的原始排片记录');
  const identity = readFormulaExportIdentity(db, { projectId, batchId, planId, outputVersionId: view.outputVersionId, packaging: view.packaging ?? {} });
  const scheduleClips = new Map((schedule?.timeline.clips ?? []).map(clip => [clip.id, clip]));
  const clips = [...view.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.timelineEndUs - b.timelineEndUs).map(clip => {
    const slot = selection.slots.find(slot => slot.slotId === clip.segmentId);
    // 非口播镜头在排时间结果里没有槽位号，只能按片段 id 认回排时间自己的决定：
    // 镜头、替换镜头和补镜都是算法排的，不是人工插入。
    const scheduled = slot ? undefined : scheduleClips.get(clip.clipId);
    const generated = scheduled && scheduled.kind !== 'filler' ? scheduled : null;
    const replacement = slot?.manualReplacement ?? slot?.replacement;
    const manual = clip.formulaSourceId ? readFormulaManualMedia(db, projectId, view.outputVersionId!, clip.formulaSourceId) : null;
    return {
      clipId: clip.clipId, slotId: slot?.slotId ?? null,
      originalCode: slot?.logicalCode ?? generated?.substitution?.replacedCode ?? generated?.logicalCode ?? null,
      selectedCode: slot?.sourceLogicalCode ?? replacement?.replacementCode ?? slot?.logicalCode
        ?? generated?.logicalCode ?? null,
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
      selectionReason: slot?.reason ?? (scheduled ? `schedule_${scheduled.kind}` : 'manual_insert'),
      manualDeviation: slot ? (slot.assetId !== clip.assetId || slot.candidate?.contentFingerprint !== clip.contentFingerprint ? 'source_changed' : null)
        : scheduled ? null : 'manual_insert',
      ...(scheduled?.kind === 'filler' ? { fillerCause: scheduled.fillerCause ?? null, fillerLines: scheduled.lineIndexes } : {}),
      ...(scheduled?.substitution ? { scheduleSubstitution: { replacedCode: scheduled.substitution.replacedCode,
        from: scheduled.substitution.from, assetId: scheduled.substitution.file.assetId,
        fileName: scheduled.substitution.file.fileName } } : {}),
      replacement: replacement ? { originalCode: replacement.originalCode, replacementCode: replacement.replacementCode,
        reason: replacement.reason, differences: replacement.differences, basisScope: replacement.basisScope,
        importedSuggestion: slot?.replacement?.importedSuggestion ? {
          sourceId: slot.replacement.importedSuggestion.sourceId, filename: slot.replacement.importedSuggestion.filename,
          fingerprint: slot.replacement.importedSuggestion.fingerprint, originalCode: slot.replacement.importedSuggestion.originalCode,
          replacementCode: slot.replacement.importedSuggestion.replacementCode, sourceLine: slot.replacement.importedSuggestion.sourceLine } : null } : null,
    };
  });
  // 排时间出来的成片以排时间结果当基线：补镜、替镜不算人工改动，和审片口径一致。
  const deviations = schedule
    ? describeScheduleFormulaDeviations(selection, schedule, view.clips, request.input.materialIndex.bindings)
    : describeFormulaDeviations(selection, view.clips, request.input.materialIndex.bindings, timeline.duration.clips);
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
    scriptAudioMapping: schedule && scheduleRow
      ? scheduleScriptAudioMapping(schedule, scheduleRow.stageId, basis)
      : { scope: 'generation_basis' as const, stageId: mappingRow!.stageId, algorithmVersion: legacyMapping!.algorithmVersion,
      basis: legacyMapping!.basis, manualVerification: legacyMapping!.manualVerification ? {
        revisionId: legacyMapping!.manualVerification.revisionId, confirmedAt: legacyMapping!.manualVerification.confirmedAt } : null,
      blocks: legacyMapping!.blocks.map(block => ({ id: block.id, start: block.start, end: block.end, text: block.text, kind: block.kind,
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
      sources: legacyMapping!.sources.map(source => ({ slotId: source.slotId, assetId: source.assetId,
        contentFingerprint: source.contentFingerprint, speechStageId: source.speechStageId, text: source.text })),
      issues: legacyMapping!.issues.map(issue => ({ code: issue.code, message: issue.message, slotIds: issue.slotIds,
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

/**
 * 一个任务只有一个「成片」文件夹，所以清单按整个任务写，而不是按触发导出的批次。
 * 只列文件夹里的当前这一套（每条成片的当前正式版本），旧版不列。
 */
export function writeFormulaExportFolderManifest(db: Database.Database, projectId: string): void {
  const task = readLiveMixcutProject(db, projectId);
  const requests = new Map<string, FormulaGenerationRequest>();
  const collected: Array<{ key: string; version: number; item: FormulaExportManifest['items'][number] }> = [];
  const indexByKey = new Map<string, number>();
  // 归档批次的文件仍在「成片」里，所以也要列；软删除的批次由查询排除。
  for (const batch of listProjectBatchProductions(db, projectId, { includeArchived: true })) {
    if (batch.planningMode !== 'formula' || !batch.currentVersionId) continue;
    const workspace = getBatchWorkspace(db, projectId, batch.id);
    for (const card of workspace.cards) {
      if (card.exportStatus !== 'exported' || !card.currentFormalArtifact) continue;
      const formal = card.currentFormalArtifact;
      if (!formal.cover) continue;
      // 上一版已被挪走，正式产物路径同步改到「旧版」；它不属于当前这一套。
      const current = parseLiveMixcutExportedVideo(formal.video.relativePath, task.exportDirName);
      if (!current || !isLiveMixcutExportedFile(formal.cover.relativePath, task.exportDirName)) continue;
      const content = captureFormulaManifestItem(db, projectId, batch.id, card.planId, requests);
      const item = {
        ...content,
        video: { artifactId: formal.video.id,
          filename: formal.video.relativePath.replaceAll('\\', '/').split('/').at(-1)!, checksum: formal.video.checksum },
        coverFile: { artifactId: formal.cover.id,
          filename: formal.cover.relativePath.replaceAll('\\', '/').split('/').at(-1)!, checksum: formal.cover.checksum },
      };
      const existing = indexByKey.get(current.key);
      if (existing === undefined) {
        indexByKey.set(current.key, collected.length);
        collected.push({ key: current.key, version: current.version, item });
      } else if (collected[existing].version < current.version) {
        collected[existing] = { key: current.key, version: current.version, item };
      }
    }
  }
  const items = collected.map(entry => entry.item);
  const directory = path.join(dataRoot(), 'storage', ...liveMixcutExportRelativeDir(task.exportDirName).split('/'));
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, '清单.csv');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, csvManifest({ items }), 'utf8');
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
