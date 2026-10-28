/**
 * 新规矩续接的最后一步：配音齐了就排时间。
 *
 * 幂等：阶段和任务都在就沿用；结果已存就接着生成成片版本和执行检查。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createBatchTask } from '../tasks.ts';
import type { FormulaGenerationOutput, FormulaGenerationRequest } from './generation.ts';
import { isFormulaRulesV2 } from './rules-version.ts';
import { readFormulaVoiceNarrationResult, readFormulaVoiceResult } from './pipeline-v2.ts';
import { materializeFormulaScheduleOutput } from './schedule-output.ts';
import { readFormulaScheduleStageResult } from './schedule.ts';

function latestVoiceStageId(db: Database.Database, selectStageId: string): string | null {
  const row = db.prepare('SELECT id FROM live_mixcut_formula_voice_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectStageId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function queueFormulaSchedule(db: Database.Database, projectId: string, batchId: string,
  selectStage: { id: string; planId: string }, request: FormulaGenerationRequest, output: FormulaGenerationOutput): void {
  if (!isFormulaRulesV2(request.rulesVersion)) return;
  const voiceStageId = latestVoiceStageId(db, selectStage.id);
  if (!voiceStageId) return;
  const voice = readFormulaVoiceResult(db, selectStage.id);
  if (!voice) return;
  const narrationStageId = (db.prepare('SELECT id FROM live_mixcut_formula_voice_narration_stages WHERE voiceStageId=?')
    .get(voiceStageId) as { id: string } | undefined)?.id ?? null;
  if (voice.narrationLines.length && !narrationStageId) return;
  if (narrationStageId && !readFormulaVoiceNarrationResult(db, selectStage.id)) return;

  let stage = db.prepare('SELECT id FROM live_mixcut_formula_schedule_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectStage.id) as { id: string } | undefined;
  if (!stage) {
    stage = { id: randomUUID() };
    db.prepare(`INSERT INTO live_mixcut_formula_schedule_stages
      (id,selectionStageId,voiceStageId,narrationStageId,revision,inputJson,createdAt) VALUES (?,?,?,?,1,?,?)`)
      .run(stage.id, selectStage.id, voiceStageId, narrationStageId,
        JSON.stringify({ formatVersion: 1, voiceStageId, narrationStageId }), new Date().toISOString());
  }
  createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
    requestKey: `formula:schedule:${stage.id}` });
  if (readFormulaScheduleStageResult(db, stage.id)) {
    materializeFormulaScheduleOutput(db, projectId, batchId, stage.id, request);
  }
}
