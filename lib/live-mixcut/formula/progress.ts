import type Database from 'better-sqlite3';
import type { BatchOutputCardView } from '../batch-workspace.ts';
import { getBatchPlanningMode } from '../planning-mode.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { readFormulaInputEditing } from './input-editing.ts';

export interface FormulaGenerationProgress {
  requestId: string; batchVersionId: string; total: number; ready: number; needsAttention: number;
  pending: number; finished: boolean; inputRevisionOpen: boolean;
  items: Array<{ planId: string; scriptNumber: string; copyIndex: number; phase: string;
    status: 'pending' | 'running' | 'needs_attention' | 'ready'; detail: string; retryTaskId: string | null }>;
}
type StageKind = 'select' | 'source_speech' | 'audio_mapping' | 'narration' | 'timeline' | 'execution';
const labels: Record<StageKind, string> = { select: '选片', source_speech: '核对原声', audio_mapping: '安排声音',
  narration: '生成配音', timeline: '安排画面与字幕', execution: '检查画面、声音与包装' };
const order: StageKind[] = ['select', 'source_speech', 'audio_mapping', 'narration', 'timeline', 'execution'];
interface StageResult {
  status?: string; message?: string; issues?: Array<{ message?: string }>; conflicts?: Array<{ message?: string }>;
  narrations?: unknown[];
  slots?: Array<{ logicalCode: string; candidate: unknown; reason: string; replacementCheck?: { message?: string } }>;
}
function resultMessage(result: StageResult | null): string {
  if (!result) return '';
  if (result.message) return result.message;
  const issues = [...(result.issues ?? []), ...(result.conflicts ?? [])].map(issue => issue.message).filter(Boolean);
  if (issues.length) return issues.join('；');
  return (result.slots ?? []).filter(slot => !slot.candidate).map(slot => `${slot.logicalCode}：${slot.replacementCheck?.message
    || (slot.reason === 'undefined' ? '编号未定义，请补充资料或修正公式' : slot.reason === 'missing_file' ? '缺少原片' : '没有可用原片或区间')}`).join('；');
}

/** 当前请求、当前选片链和当前编辑检查的只读摘要；不读取整份素材/表格快照。 */
export function readFormulaGenerationProgress(db: Database.Database, projectId: string, batchId: string,
  cards: readonly BatchOutputCardView[]): FormulaGenerationProgress | null {
  if (getBatchPlanningMode(db, projectId, batchId) !== 'formula' || !formulaExecutionAvailable(db)) return null;
  const request = db.prepare(`SELECT r.id,r.batchVersionId,json_type(r.inputJson,'$.ttsService')='object' AS hasTtsService FROM live_mixcut_formula_generation_requests r
    JOIN live_mixcut_productions b ON b.id=r.batchId AND b.currentVersionId=r.batchVersionId
    WHERE r.projectId=? AND r.batchId=?`).get(projectId, batchId) as { id: string; batchVersionId: string; hasTtsService: number | null } | undefined;
  if (!request) return null;
  const outputs = db.prepare(`SELECT o.planId,o.scriptNumber,o.copyIndex FROM live_mixcut_formula_generation_outputs o
    JOIN live_mixcut_output_plans p ON p.id=o.planId WHERE o.requestId=? ORDER BY p.seq`).all(request.id) as
    Array<{ planId: string; scriptNumber: string; copyIndex: number }>;
  const stages = db.prepare(`SELECT s.id,s.planId,s.kind,t.id AS taskId,t.status,a.errorMessage,
      COALESCE(x.resultJson,v.resultJson,m.resultJson,n.resultJson,l.resultJson,e.resultJson) AS resultJson
    FROM live_mixcut_formula_execution_stages s
    JOIN live_mixcut_formula_stages latest ON latest.id=s.selectionStageId
      AND latest.revision=(SELECT MAX(revision) FROM live_mixcut_formula_stages WHERE planId=s.planId AND kind='select')
    LEFT JOIN live_mixcut_tasks t ON t.id=(SELECT id FROM live_mixcut_tasks WHERE targetId=s.id AND workType='formula_stage' ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    LEFT JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    LEFT JOIN live_mixcut_formula_speech_results v ON v.stageId=s.id
    LEFT JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=s.id
    LEFT JOIN live_mixcut_formula_narration_results n ON n.stageId=s.id
    LEFT JOIN live_mixcut_formula_timeline_results l ON l.stageId=s.id
    LEFT JOIN live_mixcut_formula_execution_results e ON e.stageId=s.id
    WHERE s.requestId=?`).all(request.id) as Array<{ id: string; planId: string; kind: StageKind; taskId: string | null;
      status: string | null; errorMessage: string | null; resultJson: string | null }>;
  const byPlan = new Map<string, typeof stages>();
  for (const stage of stages) byPlan.set(stage.planId, [...(byPlan.get(stage.planId) ?? []), stage]);
  const cardMap = new Map(cards.map(card => [card.planId, card]));
  const items: FormulaGenerationProgress['items'] = outputs.map(output => {
    const card = cardMap.get(output.planId);
    const base = { ...output, retryTaskId: null };
    if (card?.approvable) return { ...base, phase: '待审片', status: 'ready', detail: '制作检查和封面已完成，可预览并确认；正式视频在导出时渲染。' };
    const chain = (byPlan.get(output.planId) ?? []).filter(stage => stage.kind !== 'execution' || stage.taskId === card?.executionTask?.id)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const stage of chain) {
      const result = stage.resultJson ? JSON.parse(stage.resultJson) as StageResult : null;
      if (stage.status === 'failed' || result?.status === 'needs_attention' || result?.status === 'blocked') {
        return { ...base, phase: labels[stage.kind], status: 'needs_attention',
          detail: stage.errorMessage || resultMessage(result) || `${labels[stage.kind]}需要处理，请查看这条成片的资料和提示。`,
          retryTaskId: stage.status === 'failed' ? stage.taskId : null };
      }
      if (stage.status !== 'succeeded') return { ...base, phase: labels[stage.kind],
        status: stage.status === 'running' ? 'running' : 'pending', detail: stage.status === 'cancelled' ? '任务已中止，请检查批次控制状态。' : '后台会继续处理，刷新或关闭页面不会重新选片。' };
      if (stage.kind === 'audio_mapping' && result?.status === 'mapped' && result.narrations?.length && !request.hasTtsService
        && !chain.some(item => item.kind === 'narration')) {
        return { ...base, phase: labels.narration, status: 'needs_attention',
          detail: '这条文案需要配音，但本次制作未设置配音音色。请回到第二步点「修改输入」，选择音色后重新生成。' };
      }
    }
    if (card?.executionTask?.status === 'failed') return { ...base, phase: labels.execution, status: 'needs_attention',
      detail: card.executionTask.errorMessage || '制作检查失败，请重试。', retryTaskId: card.executionTask.id };
    if (card?.coverTask?.status === 'failed') return { ...base, phase: '生成审片封面', status: 'needs_attention',
      detail: card.coverTask.errorMessage || '封面生成失败，请重试。', retryTaskId: card.coverTask.id };
    return { ...base, phase: card?.productionReady ? '生成审片封面' : chain.length ? '等待下一阶段' : '选片',
      status: card?.coverTask?.status === 'running' ? 'running' : 'pending', detail: '尚未完成制作，请等待后台处理。' };
  });
  const ready = items.filter(item => item.status === 'ready').length;
  const needsAttention = items.filter(item => item.status === 'needs_attention').length;
  return { requestId: request.id, batchVersionId: request.batchVersionId, total: items.length, ready, needsAttention,
    pending: items.length - ready - needsAttention, finished: items.length > 0 && ready === items.length,
    inputRevisionOpen: !!readFormulaInputEditing(db, projectId, batchId).revisionId, items };
}
