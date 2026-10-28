/**
 * 审片时恢复一行：把 AI 判断「意思相近」而省掉的文案行改回普通文案。
 *
 * 只新建一次定声音修订（带上 restoredLines），后续配音、排时间、执行检查和封面
 * 都按新规矩自己往下走。新排出的成片成为这一条的新版本、回到待审；其他成片不受影响。
 * 配音按文字和音色复用，只有恢复的这行需要新合成。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { createBatchTask } from '../tasks.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaVoiceStageInput } from './pipeline-v2.ts';
import { readFormulaScheduleStageResult } from './schedule.ts';

export interface FormulaRestoreLineInput { lineIndex: number; expectedOutputVersionId: string }
export interface FormulaRestoreLineResult {
  status: 'queued' | 'already_restored';
  lineIndex: number;
  taskId: string | null;
}

interface RestoreRow {
  outputVersionId: string; planId: string; batchVersionId: string; batchCurrentVersionId: string;
  selectionStageId: string; scheduleStageId: string;
}

/**
 * 恢复一条由「AI 判断相近」省掉的文案行；同一行重复提交不会再建修订。
 * 已确认、已导出过的成片也能恢复——新版本自然回到待审。
 */
export function restoreFormulaScheduleLine(db: Database.Database, projectId: string, batchId: string, planId: string,
  input: FormulaRestoreLineInput): FormulaRestoreLineResult {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
  if (!Number.isSafeInteger(input.lineIndex) || input.lineIndex < 0) throw new BatchDomainError('invalid_input', '恢复的文案行无效');
  if (typeof input.expectedOutputVersionId !== 'string' || !input.expectedOutputVersionId) {
    throw new BatchDomainError('invalid_input', '恢复请求缺少成片版本');
  }
  return db.transaction((): FormulaRestoreLineResult => {
    const row = db.prepare(`SELECT p.currentVersionId AS outputVersionId,sel.planId,p.batchVersionId,
      b.currentVersionId AS batchCurrentVersionId,sc.selectionStageId,sc.id AS scheduleStageId
      FROM live_mixcut_output_plans p
      JOIN live_mixcut_formula_schedule_output_versions f ON f.outputVersionId=p.currentVersionId
      JOIN live_mixcut_formula_schedule_stages sc ON sc.id=f.scheduleStageId
      JOIN live_mixcut_formula_stages sel ON sel.id=sc.selectionStageId
      JOIN live_mixcut_formula_generation_requests g ON g.id=sel.requestId
      JOIN live_mixcut_productions b ON b.id=g.batchId
      WHERE p.id=? AND g.projectId=? AND g.batchId=? AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND sel.id=(SELECT id FROM live_mixcut_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(planId, projectId, batchId) as RestoreRow | undefined;
    if (!row) throw new BatchDomainError('conflict', '这条成片还不能恢复，请刷新后查看');
    if (row.batchVersionId !== row.batchCurrentVersionId) throw new BatchDomainError('conflict', '这次制作输入已经被替换，旧成片不能恢复');
    if (row.outputVersionId !== input.expectedOutputVersionId) throw new BatchDomainError('conflict', '这条成片已更新，请刷新后重试');

    const schedule = readFormulaScheduleStageResult(db, row.scheduleStageId);
    if (!schedule) throw new BatchDomainError('conflict', '这条成片还没有排好，暂时不能恢复');

    const voice = db.prepare(`SELECT id,judgmentStageId,revision,inputJson FROM live_mixcut_formula_voice_stages
      WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1`).get(row.selectionStageId) as
        { id: string; judgmentStageId: string; revision: number; inputJson: string } | undefined;
    if (!voice) throw new BatchDomainError('conflict', '这条成片还没有定过声音，暂时不能恢复');
    const latestInput = JSON.parse(voice.inputJson) as FormulaVoiceStageInput;
    const restored = new Set((latestInput.restoredLines ?? []).filter(index => Number.isSafeInteger(index) && index >= 0));
    if (restored.has(input.lineIndex)) return { status: 'already_restored', lineIndex: input.lineIndex, taskId: null };

    const mark = schedule.timeline.marks.find(item => item.type === 'skipped-line' && item.lineIndex === input.lineIndex);
    if (!mark || mark.type !== 'skipped-line') {
      throw new BatchDomainError('conflict', input.lineIndex < schedule.plan.lines.length
        ? '这一行不是 AI 判断相近省掉的，不能恢复' : '恢复的文案行不在这次排片里');
    }
    if (mark.basis !== 'similar') {
      throw new BatchDomainError('conflict', '「文案逐字写着这句」的行不用恢复，那段口播本来就在说它');
    }

    const result = db.prepare('SELECT 1 FROM live_mixcut_formula_voice_results WHERE stageId=?').get(voice.id);
    if (!result) throw new BatchDomainError('conflict', '上一次恢复还没有定完声音，请稍候再试');

    const nextInput: FormulaVoiceStageInput = { ...latestInput,
      restoredLines: [...restored, input.lineIndex].sort((left, right) => left - right) };
    const stageId = randomUUID();
    db.prepare(`INSERT INTO live_mixcut_formula_voice_stages
      (id,selectionStageId,judgmentStageId,revision,inputJson,createdAt) VALUES (?,?,?,?,?,?)`)
      .run(stageId, row.selectionStageId, voice.judgmentStageId, voice.revision + 1, JSON.stringify(nextInput), new Date().toISOString());
    const taskId = createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage',
      targetId: stageId, requestKey: `formula:voice:${stageId}` });
    return { status: 'queued', lineIndex: input.lineIndex, taskId };
  }).immediate();
}
