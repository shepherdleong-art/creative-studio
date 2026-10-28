import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { createBatchTask } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import { readFormulaGenerationRequest } from './generation.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaSelection } from './selection.ts';
import { queueFormulaSpeech } from './speech-store.ts';
import { queueFormulaAudioMapping } from './audio-mapping-store.ts';
import { queueFormulaNarration } from './narration-store.ts';
import { queueFormulaTimeline } from './timeline-store.ts';
import { materializeFormulaOutput } from './output-store.ts';
import { repairFormulaExecutionChecks } from './execution-store.ts';
import { isFormulaRulesV2 } from './rules-version.ts';
import { queueFormulaV2Plan } from './pipeline-v2.ts';

export interface FormulaStage { id: string; requestId: string; planId: string; kind: 'select'; revision: number }
const continuationFailures = new WeakMap<Database.Database, Set<string>>();

/** 老版本完成选片/原声后升级时，补齐新阶段；关闭能力或旧输入不续跑。 */
export function repairFormulaContinuations(db: Database.Database, onError: (projectId: string, requestId: string) => void = () => {}): void {
  if (!formulaExecutionAvailable(db)) return;
  repairFormulaExecutionChecks(db, onError);
  const requests = db.prepare(`SELECT DISTINCT r.id,r.projectId,r.batchId FROM live_mixcut_formula_generation_requests r
    JOIN live_mixcut_productions b ON b.id=r.batchId AND b.currentVersionId=r.batchVersionId
    JOIN live_mixcut_formula_stages s ON s.requestId=r.id AND s.kind='select'
    JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    WHERE b.deletedAt IS NULL AND b.controlState='running' AND json_extract(x.resultJson,'$.status')='selected'
      AND s.revision=(SELECT MAX(revision) FROM live_mixcut_formula_stages WHERE planId=s.planId AND kind='select')
      AND r.rulesVersion<>'formula-generation/2'
      AND (NOT EXISTS (SELECT 1 FROM live_mixcut_formula_audio_mapping_stages a WHERE a.selectionStageId=s.id)
        OR ((json_type(r.inputJson,'$.ttsService')='object' OR EXISTS (
          SELECT 1 FROM json_each(r.inputJson,'$.externalNarrations') ext
          JOIN live_mixcut_formula_generation_outputs o ON o.requestId=r.id AND o.planId=s.planId
          WHERE json_extract(ext.value,'$.scriptKey')=o.scriptKey)) AND EXISTS (
          SELECT 1 FROM live_mixcut_formula_audio_mapping_stages a JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=a.id
          WHERE a.selectionStageId=s.id AND json_extract(m.resultJson,'$.status')='mapped'
            AND json_array_length(m.resultJson,'$.narrations')>0
            AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_narration_stages n WHERE n.audioMappingStageId=a.id)))
        OR EXISTS (SELECT 1 FROM live_mixcut_formula_audio_mapping_stages a JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=a.id
          WHERE a.selectionStageId=s.id AND json_extract(m.resultJson,'$.status')='mapped'
            AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_timeline_stages t WHERE t.audioMappingStageId=a.id)
            AND (json_array_length(m.resultJson,'$.narrations')=0 OR EXISTS (
              SELECT 1 FROM live_mixcut_formula_narration_stages n JOIN live_mixcut_formula_narration_results v ON v.stageId=n.id
              WHERE n.audioMappingStageId=a.id AND json_extract(v.resultJson,'$.status')='ready')))
        OR EXISTS (SELECT 1 FROM live_mixcut_formula_execution_stages t JOIN live_mixcut_formula_timeline_results v ON v.stageId=t.id
          WHERE t.kind='timeline' AND t.selectionStageId=s.id AND json_extract(v.resultJson,'$.status')='planned'
            AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_output_versions o WHERE o.timelineStageId=t.id)))`)
    .all() as Array<{ id: string; projectId: string; batchId: string }>;
  // 新规矩的批次：选片一完成就由同一套续接往下接；已有的阶段和任务原样沿用，失败任务不自动重试。
  const v2Requests = db.prepare(`SELECT DISTINCT r.id,r.projectId,r.batchId FROM live_mixcut_formula_generation_requests r
    JOIN live_mixcut_productions b ON b.id=r.batchId AND b.currentVersionId=r.batchVersionId
    JOIN live_mixcut_formula_stages s ON s.requestId=r.id AND s.kind='select'
    JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    WHERE b.deletedAt IS NULL AND b.controlState='running' AND r.rulesVersion='formula-generation/2'
      AND json_extract(x.resultJson,'$.status')='selected'
      AND s.revision=(SELECT MAX(revision) FROM live_mixcut_formula_stages WHERE planId=s.planId AND kind='select')`)
    .all() as Array<{ id: string; projectId: string; batchId: string }>;
  const failures = continuationFailures.get(db) ?? new Set<string>();
  continuationFailures.set(db, failures);
  for (const request of [...requests, ...v2Requests]) {
    try {
      queueFormulaSelection(db, request.projectId, request.batchId, request.id);
      failures.delete(request.id);
    } catch {
      if (!failures.has(request.id)) onError(request.projectId, request.id);
      failures.add(request.id);
    }
  }
}

export function queueFormulaSelection(db: Database.Database, projectId: string, batchId: string, requestId: string): string[] {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '公式制作尚未启用或任务结构未就绪');
  return db.transaction(() => {
    const request = readFormulaGenerationRequest(db, projectId, batchId, requestId);
    const current = db.prepare('SELECT currentVersionId FROM live_mixcut_productions WHERE id=?').get(batchId) as { currentVersionId: string };
    if (current.currentVersionId !== request.batchVersionId) throw new BatchDomainError('conflict', '旧输入不能排入当前制作任务');
    db.prepare(`UPDATE live_mixcut_tasks SET expectedState='stopped',
      status=CASE WHEN status='running' THEN 'running' ELSE 'cancelled' END, updatedAt=?
      WHERE batchId=? AND workType='formula_stage' AND status IN ('queued','running','failed') AND targetId IN (
        SELECT s.id FROM live_mixcut_formula_execution_stages s JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
        WHERE r.batchId=? AND r.batchVersionId<>?)`).run(new Date().toISOString(), batchId, batchId, request.batchVersionId);
    return request.outputs.map(output => {
      let stage = db.prepare("SELECT * FROM live_mixcut_formula_stages WHERE planId=? AND kind='select' ORDER BY revision DESC LIMIT 1").get(output.planId) as FormulaStage | undefined;
      if (!stage) {
        stage = { id: randomUUID(), requestId, planId: output.planId, kind: 'select', revision: 1 };
        db.prepare('INSERT INTO live_mixcut_formula_stages (id,requestId,planId,kind,revision,createdAt) VALUES (?,?,?,?,?,?)')
          .run(stage.id, requestId, output.planId, stage.kind, stage.revision, new Date().toISOString());
      }
      const taskId = createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
        requestKey: `formula:select:${stage.id}` });
      const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
      if (existing) {
        if (isFormulaRulesV2(request.rulesVersion)) {
          queueFormulaV2Plan(db, projectId, batchId, stage, request, output);
          return taskId;
        }
        queueFormulaSpeech(db, projectId, batchId, stage, request, JSON.parse(existing.resultJson));
        queueFormulaAudioMapping(db, projectId, batchId, stage.id, request);
        queueFormulaNarration(db, projectId, batchId, stage.id, request);
        queueFormulaTimeline(db, projectId, batchId, stage.id, request);
        const timeline = db.prepare(`SELECT t.id FROM live_mixcut_formula_execution_stages t
          JOIN live_mixcut_formula_timeline_results v ON v.stageId=t.id
          WHERE t.kind='timeline' AND t.selectionStageId=? AND json_extract(v.resultJson,'$.status')='planned'`)
          .get(stage.id) as { id: string } | undefined;
        if (timeline) materializeFormulaOutput(db, projectId, batchId, timeline.id, request);
      }
      return taskId;
    });
  }).immediate();
}

export function readFormulaSelection(db: Database.Database, projectId: string, batchId: string, planId: string): FormulaSelection | null {
  assertFormulaBatch(db, projectId, batchId);
  const output = db.prepare(`SELECT o.planId FROM live_mixcut_formula_generation_outputs o
    JOIN live_mixcut_formula_generation_requests r ON r.id=o.requestId WHERE o.planId=? AND r.projectId=? AND r.batchId=?`)
    .get(planId, projectId, batchId);
  if (!output) throw new BatchDomainError('not_found', '公式输出不存在');
  const row = db.prepare(`SELECT x.resultJson FROM live_mixcut_formula_stages s LEFT JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    WHERE s.planId=? AND s.kind='select' ORDER BY s.revision DESC LIMIT 1`).get(planId) as { resultJson: string | null } | undefined;
  return row?.resultJson ? JSON.parse(row.resultJson) as FormulaSelection : null;
}
