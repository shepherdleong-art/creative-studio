import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from './cover-contract.ts';
import { batchSourceReview } from './source-conflicts.ts';
import type { FormulaSelection } from './formula/selection.ts';
import type { FormulaGenerationRequest } from './formula/generation.ts';
import type { FormulaTimelineResult } from './formula/timeline.ts';
import { describeFormulaDeviations } from './formula/deviations.ts';
import { manualMediaForClip } from './formula/manual-media.ts';

export interface BatchReviewIssue {
  kind: 'warning' | 'blocker' | 'replacement' | 'range' | 'audio' | 'deviation';
  message: string;
  details?: string[];
  evidenceHash?: string;
}
export interface BatchReviewContext {
  outputVersionId: string;
  editRevision: number;
  issueSetHash: string;
  issues: BatchReviewIssue[];
}
export type BatchReviewTarget = Pick<BatchReviewContext, 'outputVersionId' | 'editRevision' | 'issueSetHash'> & { planId: string };

const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read-only identity of the current output and the concerns a reviewer must see. No live media calls. */
export function batchOutputReviewContext(db: Database.Database, outputVersionId: string, value: unknown): BatchReviewContext {
  const arrangement = record(value);
  const issues: BatchReviewIssue[] = [];
  // The workspace also displays diagnostics from the active allocation report.
  const allocation = db.prepare(`SELECT p.id AS planId,r.resultJson FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id=o.planId JOIN batch_production_versions v ON v.id=p.batchVersionId
    LEFT JOIN batch_allocation_runs r ON r.id=v.currentAllocationRunId WHERE o.id=?`).get(outputVersionId) as
    { planId: string; resultJson: string | null } | undefined;
  const report = allocation?.resultJson ? record(JSON.parse(allocation.resultJson)) : {};
  const output = record((Array.isArray(report.outputs) ? report.outputs : []).find(item => record(item).planId === allocation?.planId));
  for (const diagnostics of [arrangement, output, record(output.arrangement)]) {
    for (const [field, kind] of [['warnings', 'warning'], ['blockers', 'blocker']] as const) {
      for (const item of Array.isArray(diagnostics[field]) ? diagnostics[field] : []) {
        const message = typeof item === 'string' ? item : record(item).message ?? record(item).code;
        if (typeof message === 'string' && message.trim()) issues.push({ kind, message: message === 'formula_execution_pending'
          ? '公式制作与正式发布检查尚未完成' : message, evidenceHash: hash(item) });
      }
    }
  }
  const source = batchSourceReview(db, arrangement);
  for (const message of source.sourceWarnings) issues.push({ kind: 'warning', message, evidenceHash: hash(source.sourceConflictGroups) });
  const audio = record(arrangement.audioPlan);
  for (const issue of Array.isArray(audio.issues) ? audio.issues : []) {
    issues.push({ kind: 'audio', message: String(record(issue).message ?? '声音需要处理'), evidenceHash: hash(issue) });
  }
  const basis = record(arrangement.formula);
  if (arrangement.formula) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_formula_selection_results'").get();
    const row = exists && typeof basis.selectionStageId === 'string'
      ? db.prepare(`SELECT s.resultJson,g.projectId,g.inputJson,t.resultJson AS timelineJson FROM batch_formula_selection_results s
          LEFT JOIN batch_formula_stages stage ON stage.id=s.stageId
          LEFT JOIN batch_formula_generation_requests g ON g.id=stage.requestId
          LEFT JOIN batch_formula_execution_stages e ON e.id=? AND e.selectionStageId=stage.id AND e.planId=stage.planId
          LEFT JOIN batch_formula_timeline_results t ON t.stageId=e.id WHERE s.stageId=?`).get(String(basis.timelineStageId ?? ''), basis.selectionStageId) as
        { resultJson: string; projectId: string; inputJson: string | null; timelineJson: string | null } | undefined : undefined;
    const selection: FormulaSelection | null = row ? JSON.parse(row.resultJson) : null;
    if (!selection || selection.status !== 'selected') issues.push({ kind: 'blocker', message: '选片记录缺失或尚未完成，请重新核对' });
    if (selection?.status === 'selected') {
      const input: FormulaGenerationRequest['input'] | null = row?.inputJson ? JSON.parse(row.inputJson) : null;
      const activeAudio = record(arrangement.audioPlan).clips;
      const activeIds = new Set((Array.isArray(activeAudio) ? activeAudio : []).map(clip => record(clip).mediaId));
      for (const source of Array.isArray(basis.audioSources) ? basis.audioSources : []) {
        const sound = record(source);
        const imported = input?.externalNarrations?.find(item => item.id === sound.externalNarrationId);
        if (imported && activeIds.has(sound.mediaId)) issues.push({ kind: 'warning', message: `外部配音：${imported.filename}`,
          details: ['音频内容及 SRT 时间已由用户试听确认，未冒充自动识别或自动对齐。', `实际台词：${imported.text}`],
          evidenceHash: hash({ id: imported.id, fingerprint: imported.audio?.fingerprint, words: imported.audio?.words }) });
      }
      const timeline: FormulaTimelineResult | null = row?.timelineJson ? JSON.parse(row.timelineJson) : null;
      const currentClips = (Array.isArray(arrangement.clips) ? arrangement.clips : []) as Parameters<typeof describeFormulaDeviations>[1];
      const changes = describeFormulaDeviations(selection, currentClips, input?.materialIndex.bindings, timeline?.status === 'planned' ? timeline.duration.clips : []);
      for (const clip of changes.replacedClips) issues.push({ kind: 'deviation',
        message: `人工换片：原公式 ${clip.originalCode} 的画面已更换，请核对内容与声音`,
        details: [`生成时选用：${clip.selectedCode}；现用编号：${clip.actualCodes.join('、') || '未登记编号'}`], evidenceHash: hash(clip) });
      for (const clip of changes.insertedClips) issues.push({ kind: 'deviation',
        message: `人工插入：${clip.actualCodes.join('、') || '未登记编号的素材'}，不属于原公式镜头`, evidenceHash: hash(clip) });
      for (const slot of changes.deletedSlots) issues.push({ kind: 'deviation',
        message: `人工删除：原公式镜头 ${selection.slots.find(item => item.slotId === slot.slotId)!.clipId + 1}（${slot.originalCode}）已移除`, evidenceHash: hash(slot) });
      for (const slot of changes.sourceRangeChanges) {
        const range = (value: { sourceInUs: number; sourceOutUs: number }) => `${(value.sourceInUs / 1e6).toFixed(3)}–${(value.sourceOutUs / 1e6).toFixed(3)} 秒`;
        issues.push({ kind: 'deviation', message: `人工裁切：${slot.originalCode} 的取用区间已变化，请核对动作与话语是否完整`,
          details: [`生成时：${range(slot.originalRange)}`, `现在取用：${slot.actualRanges.map(range).join('、')}`], evidenceHash: hash(slot) });
      }
      if (changes.reordered) {
        const codes = (ids: string[]) => ids.map(id => selection.slots.find(slot => slot.slotId === id)!.logicalCode).join(' → ');
        issues.push({ kind: 'deviation', message: '人工换序：当前画面顺序偏离原公式，请核对表达是否完整',
          details: [`原公式：${codes(changes.originalOrder)}`, `当前保留镜头：${codes(changes.actualOrder)}`], evidenceHash: hash(changes) });
      }
    }
    for (const slot of selection?.slots ?? []) {
      const replacement = slot.replacement ?? slot.manualReplacement;
      if (replacement || (slot.sourceLogicalCode && slot.sourceLogicalCode !== slot.logicalCode)) {
        const details = replacement ? [replacement.reason, ...replacement.differences,
          ...replacement.evidence.map(item => `原资料：${item.original.quote}；替代资料：${item.replacement.quote}`)] : [];
        issues.push({ kind: 'replacement', message: `镜头 ${slot.clipId + 1}：${slot.logicalCode} → ${slot.sourceLogicalCode ?? replacement?.replacementCode}`,
          details, evidenceHash: hash({ slotId: slot.slotId, assetId: slot.assetId, replacement: replacement ?? null }) });
      }
      if (slot.rangeStatus !== 'confirmed' && (Array.isArray(arrangement.clips) ? arrangement.clips : []).some(clip => record(clip).segmentId === slot.slotId && !record(clip).formulaSourceId)) issues.push({ kind: 'range', message: `镜头 ${slot.clipId + 1}（${slot.logicalCode}）使用系统安排的区间，请检查动作与话语是否完整`,
        evidenceHash: hash({ slotId: slot.slotId, selectionStageId: basis.selectionStageId,
          clips: (Array.isArray(arrangement.clips) ? arrangement.clips : []).map(record).filter(clip => clip.segmentId === slot.slotId)
            .map(({ clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs }) =>
              ({ clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs })) }) });
    }
    for (const raw of Array.isArray(arrangement.clips) ? arrangement.clips : []) {
      const clip = record(raw);
      if (!clip.formulaSourceId) continue;
      try {
        const proof = manualMediaForClip(db, row?.projectId ?? '', outputVersionId, clip)!;
        const seconds = (us: number) => (us / 1e6).toFixed(3);
        issues.push({ kind: 'range', message: `人工选定区间：${seconds(Number(clip.sourceStartUs))}–${seconds(Number(clip.sourceEndUs))} 秒；${proof.sound === 'source'
          ? '保留人工核对原声，请检查实际台词与字幕' : '新素材原声静音，请检查画面内容'}`,
          details: [
            ...(proof.protected ? [`保护动作：${seconds(proof.protected.inUs)}–${seconds(proof.protected.outUs)} 秒`] : []),
            ...(proof.sound === 'source' ? [...(proof.previousText ? [`替换前台词：${proof.previousText}`] : []),
              ...[...new Set(proof.replaces.flatMap(range => range.narration ? [`替代配音：${range.narration.text}`] : []))],
              ...proof.segments.map(segment => `实际台词：${segment.text}（源视频 ${seconds(segment.startUs)}–${seconds(segment.endUs)} 秒）`),
              '台词、区间及替换覆盖关系由人工试听确认；请在成片中再次核对。'] : []),
          ],
          evidenceHash: hash({ id: proof.id, assetId: clip.assetId, contentFingerprint: clip.contentFingerprint,
            sourceStartUs: clip.sourceStartUs, sourceEndUs: clip.sourceEndUs, protected: proof.protected, sound: proof.sound,
            ...(proof.sound === 'source' ? { segments: proof.segments, previousText: proof.previousText, replaces: proof.replaces } : {}) }) });
      } catch { issues.push({ kind: 'blocker', message: '人工素材核验记录缺失或区间不一致，请重新核验' }); }
    }
  }
  const unique = [...new Map(issues.map(issue => [canonicalJson(issue), issue])).values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const editRevision = arrangement.editRevision ?? 0;
  return { outputVersionId, editRevision: Number.isSafeInteger(editRevision) && Number(editRevision) >= 0 ? Number(editRevision) : -1,
    issueSetHash: hash(unique), issues: unique };
}

/** Legacy ordinary reviews remain readable; formula approval always needs an explicit accepted snapshot. */
export function batchReviewMatches(value: unknown, context: BatchReviewContext, formula: boolean): boolean {
  const review = record(value);
  if (review.version === undefined) return !formula;
  return review.version === 1 && review.outputVersionId === context.outputVersionId
    && review.editRevision === context.editRevision && review.issueSetHash === context.issueSetHash;
}
