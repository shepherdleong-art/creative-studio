import type Database from 'better-sqlite3';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaTimelineResult } from './timeline.ts';

export interface FormulaSelectionSummary {
  stageId: string; revision: number; replacementCount: number;
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'selected' | 'needs_attention' | 'unavailable';
  message: string;
  previewReady?: boolean; bodyDurationUs?: number;
}

/** 工作台一次读取当前批次的选片摘要；完整依据与历史按选中的成片单独读取。 */
export function formulaSelectionSummaries(db: Database.Database, batchVersionId: string): Map<string, FormulaSelectionSummary> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_mixcut_formula_stages'").get()) return new Map();
  const available = formulaExecutionAvailable(db);
  const timelines = new Map<string, FormulaTimelineResult>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_mixcut_formula_timeline_results'").get()) {
    const timed = db.prepare(`SELECT m.selectionStageId,x.resultJson FROM live_mixcut_formula_audio_mapping_stages m
      JOIN live_mixcut_formula_stages s ON s.id=m.selectionStageId JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
      LEFT JOIN live_mixcut_formula_timeline_stages t ON t.audioMappingStageId=m.id LEFT JOIN live_mixcut_formula_timeline_results x ON x.stageId=t.id
      WHERE r.batchVersionId=? AND m.revision=(SELECT MAX(revision) FROM live_mixcut_formula_audio_mapping_stages WHERE selectionStageId=m.selectionStageId)`)
      .all(batchVersionId) as Array<{ selectionStageId: string; resultJson: string | null }>;
    for (const row of timed) if (row.resultJson) timelines.set(row.selectionStageId, JSON.parse(row.resultJson));
  }
  const rows = db.prepare(`SELECT s.planId,s.id,s.revision,x.resultJson,t.status,a.errorMessage FROM live_mixcut_formula_stages s
    JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
    LEFT JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    LEFT JOIN live_mixcut_tasks t ON t.id=(SELECT latest.id FROM live_mixcut_tasks latest WHERE latest.targetId=s.id
      AND latest.workType='formula_stage' ORDER BY latest.createdAt DESC,latest.rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    WHERE r.batchVersionId=? AND s.kind='select' AND s.revision=(
      SELECT MAX(newer.revision) FROM live_mixcut_formula_stages newer WHERE newer.planId=s.planId AND newer.kind=s.kind)`)
    .all(batchVersionId) as Array<{ planId: string; id: string; revision: number; resultJson: string | null; status: string | null; errorMessage: string | null }>;
  return new Map(rows.map(row => {
    const selection: FormulaSelection | null = row.resultJson ? JSON.parse(row.resultJson) : null;
    const timeline = timelines.get(row.id);
    const status: FormulaSelectionSummary['status'] = !available ? 'unavailable' : selection ? selection.status
      : row.status === 'failed' || row.status === 'cancelled' || row.status === 'running' ? row.status : 'queued';
    const message = status === 'unavailable' ? '实拍公式能力暂不可用，已有记录保留'
      : status === 'selected' ? timeline?.status === 'planned' ? '已排好画面与声音，可在预览区播放；包装和审片尚未完成'
        : timeline?.status === 'needs_attention' ? '时长安排需要处理，请查看排片记录' : '已完成选片，等待核验声音和最终裁切'
      : status === 'needs_attention' ? '有缺失或不可用素材，请查看选片记录'
      : status === 'failed' ? row.errorMessage || '选片失败，可查看原因后重新选片'
      : status === 'cancelled' ? '这次选片已停止' : status === 'running' ? '正在按公式检查和选择素材' : '等待按公式选片';
    return [row.planId, { stageId: row.id, revision: row.revision, status, message,
      ...(timeline?.status === 'planned' ? { previewReady: available, bodyDurationUs: timeline.duration.bodyDurationUs } : {}),
      replacementCount: selection?.slots.filter(slot => !!slot.replacement || (slot.sourceLogicalCode && slot.sourceLogicalCode !== slot.logicalCode)).length ?? 0 }];
  }));
}
