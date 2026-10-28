import type Database from 'better-sqlite3';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaTimelineResult } from './timeline.ts';

/** 审片标记：AI 在排片时动过手的地方，审片人先看这些。 */
export interface FormulaReviewMark {
  kind: 'skipped-line' | 'substitute' | 'filler';
  message: string;
  /** 省掉的文案行序号；只有这一类能回到那一行。 */
  lineIndex?: number;
  /** 能否「恢复这一行」：AI 判断相近才省掉的行可以，文案逐字写着的不能。 */
  restorable?: boolean;
}

const substitutionSource: Record<string, string> = {
  'replacement-table': '替换表', 'same-kind': '同类素材', wide: '全景展示', 'wide-experience': '全景体验', other: '其他素材' };

export interface FormulaSelectionSummary {
  stageId: string; revision: number; replacementCount: number;
  /** 新规矩的审片标记；旧批次和没有标记时为空数组。 */
  reviewMarks: FormulaReviewMark[];
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'selected' | 'needs_attention' | 'unavailable';
  message: string;
  previewReady?: boolean; bodyDurationUs?: number;
  /** 后续制作阶段受阻时的恢复入口，不改变已保存的选片事实。 */
  retryTaskId?: string | null;
}

/** 工作台一次读取当前批次的选片摘要；完整依据与历史按选中的成片单独读取。 */
export function formulaSelectionSummaries(db: Database.Database, batchVersionId: string): Map<string, FormulaSelectionSummary> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_mixcut_formula_stages'").get()) return new Map();
  const available = formulaExecutionAvailable(db);
  const timelines = new Map<string, FormulaTimelineResult>();
  const schedules = new Map<string, import('./schedule.ts').FormulaScheduleStageResult>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_mixcut_formula_schedule_results'").get()) {
    const scheduled = db.prepare(`SELECT s.selectionStageId,x.resultJson FROM live_mixcut_formula_schedule_stages s
      JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
      JOIN live_mixcut_formula_generation_requests r ON r.id=sel.requestId
      JOIN live_mixcut_formula_schedule_results x ON x.stageId=s.id
      WHERE r.batchVersionId=? AND s.revision=(SELECT MAX(revision) FROM live_mixcut_formula_schedule_stages WHERE selectionStageId=s.selectionStageId)`)
      .all(batchVersionId) as Array<{ selectionStageId: string; resultJson: string }>;
    for (const row of scheduled) schedules.set(row.selectionStageId, JSON.parse(row.resultJson));
  }
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
    const schedule = schedules.get(row.id);
    const reviewMarks = reviewMarksOf(schedule);
    const status: FormulaSelectionSummary['status'] = !available ? 'unavailable' : selection ? selection.status
      : row.status === 'failed' || row.status === 'cancelled' || row.status === 'running' ? row.status : 'queued';
    const message = status === 'unavailable' ? '实拍公式能力暂不可用，已有记录保留'
      : status === 'selected' ? timeline?.status === 'planned' ? '已排好画面与声音，可在预览区播放；包装和审片尚未完成'
        : schedule ? '已排出画面、声音、字幕和审片标记；包装和审片尚未完成'
        : timeline?.status === 'needs_attention' ? '时长安排需要处理，请查看排片记录' : '已完成选片，等待核验声音和最终裁切'
      : status === 'needs_attention' ? '有缺失或不可用素材，请回到第二步修改输入后重新生成'
      : status === 'failed' ? row.errorMessage || '选片失败，可查看原因后重新选片'
      : status === 'cancelled' ? '这次选片已停止' : status === 'running' ? '正在按公式检查和选择素材' : '等待按公式选片';
    return [row.planId, { stageId: row.id, revision: row.revision, status, message, reviewMarks,
      ...(timeline?.status === 'planned' ? { previewReady: available, bodyDurationUs: timeline.duration.bodyDurationUs }
        : schedule ? { previewReady: available, bodyDurationUs: schedule.timeline.totalDurationUs } : {}),
      replacementCount: selection?.slots.filter(slot => !!slot.replacement || (slot.sourceLogicalCode && slot.sourceLogicalCode !== slot.logicalCode)).length ?? 0 }];
  }));
}

/** 三类标记各自一句话；同一句配音后面的多段补镜合成一条。 */
export function reviewMarksOf(schedule: import('./schedule.ts').FormulaScheduleStageResult | undefined): FormulaReviewMark[] {
  if (!schedule) return [];
  const marks: FormulaReviewMark[] = [];
  const lines = new Map(schedule.plan.lines.map(line => [line.index, line.text]));
  for (const mark of schedule.timeline.marks) {
    if (mark.type === 'skipped-line') {
      marks.push({ kind: 'skipped-line', message: `第 ${mark.lineIndex + 1} 行「${lines.get(mark.lineIndex) ?? ''}」不用配音，`
        + `由 ${mark.logicalCode} 的原声说了（${mark.basis === 'planned' ? '文案逐字写着这句' : 'AI 判断意思相近'}）`,
      lineIndex: mark.lineIndex, restorable: mark.basis === 'similar' });
    } else if (mark.type === 'substitute') {
      const clip = schedule.timeline.clips.find(item => item.substitution?.replacedCode === mark.replacedCode && item.assetId === mark.assetId);
      marks.push({ kind: 'substitute', message: `缺号 ${mark.replacedCode} 由${substitutionSource[mark.from] ?? '其他素材'}`
        + `${clip ? ` ${clip.logicalCode}` : ''}顶上` });
    }
  }
  const fillers = new Map<string, { cause: 'overflow' | 'gap' | 'ending'; lineIndexes: number[] }>();
  for (const mark of schedule.timeline.marks) {
    if (mark.type !== 'filler') continue;
    const key = `${mark.cause}:${mark.lineIndexes.join(',')}`;
    if (!fillers.has(key)) fillers.set(key, { cause: mark.cause, lineIndexes: mark.lineIndexes });
  }
  for (const { cause, lineIndexes } of fillers.values()) {
    const which = lineIndexes.map(index => lines.get(index) ?? '').join('、');
    marks.push({ kind: 'filler', message: cause === 'ending' ? `片尾不配音，补了结尾镜头`
      : cause === 'gap' ? `第 ${lineIndexes.map(index => index + 1).join('、')} 行「${which}」没有合适画面，插了补镜`
        : `第 ${lineIndexes.map(index => index + 1).join('、')} 行「${which}」配音比镜头长，多补了画面` });
  }
  return marks;
}
