import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-audio-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = '';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = '';
let db = new Database(path.join(root, 'test.db'));
try {
  const { readFormulaManualAudio, saveFormulaManualAudio } = await import('../lib/live-mixcut/formula/manual-audio-mapping.ts');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { readFormulaManualSpeech, saveFormulaManualSpeech } = await import('../lib/live-mixcut/formula/manual-speech.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchOutputArrangementView } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { readFormulaSelectionHistory, reselectFormulaOutput } = await import('../lib/live-mixcut/formula/reselection.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'MANUAL',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','人工声音用途');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '同脚本两份', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_原声.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 2, 'VO1', '容易清洁。拍摄备注。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const sourceView = readFormulaManualSpeech(db, 'p', batchId);
  await saveFormulaManualSpeech(db, 'p', batchId, { assetId, contentFingerprint: sourceView.items[0].contentFingerprint,
    expectedInputRevision: 2, expectedSpeechRevision: 0, mode: 'speech', confirmed: true,
    segments: [{ text: '好擦洗。', startUs: 250_000, endUs: 1_750_000 }] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'mixed', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const generated = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual-audio', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  const run = () => runPendingOnce({ db, workerId: 'manual-audio', log: () => {}, executors: [createFormulaStageExecutor(async () => null), createBatchRenderExecutor()] });
  await run();
  const [first, sibling] = generated.outputs;
  const before = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
  const siblingBefore = readFormulaSelectionHistory(db, 'p', batchId, sibling.planId);
  assert.equal(before.current.audioMapping.result?.status, 'needs_attention');
  const editor = readFormulaManualAudio(db, 'p', batchId, first.planId);
  assert.equal(editor.bodyText, '容易清洁。拍摄备注。');
  const input = { requestKey: 'manual-1', ...editor.expected, confirmed: true,
    blocks: [{ text: '容易清洁。', kind: 'source', slotId: first.slots[0].slotId }, { text: '拍摄备注。', kind: 'reference' }] };
  await assert.rejects(saveFormulaManualAudio(db, 'p', batchId, first.planId, { ...input, confirmed: false }), /确认/);
  await assert.rejects(saveFormulaManualAudio(db, 'p', batchId, first.planId, { ...input, blocks: input.blocks.slice(0, 1) }), /遗漏|原文/);
  await assert.rejects(saveFormulaManualAudio(db, 'foreign', batchId, first.planId, input), /不存在|不属于/);
  db.exec("CREATE TRIGGER reject_manual_audio BEFORE INSERT ON live_mixcut_formula_manual_audio_inputs BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  await assert.rejects(saveFormulaManualAudio(db, 'p', batchId, first.planId, input), /fixture rollback/);
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, first.planId), before, '保存失败必须回滚新修订及旧任务控制状态');
  db.exec('DROP TRIGGER reject_manual_audio');
  const saved = await saveFormulaManualAudio(db, 'p', batchId, first.planId, input);
  assert.deepEqual(await saveFormulaManualAudio(db, 'p', batchId, first.planId, input), saved, '回复丢失后不能重复重做');
  await assert.rejects(saveFormulaManualAudio(db, 'p', batchId, first.planId, { ...input, requestKey: 'stale-page' }), /更新|重新读取/);
  db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
  await run();
  const history = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
  assert.equal(history.current.id, saved.selectionStageId);
  assert.equal(history.current.audioMapping.result?.status, 'mapped');
  if (history.current.audioMapping.result?.status !== 'mapped') throw new Error('人工用途未进入制作');
  assert.equal(history.current.audioMapping.result.basis, 'manual');
  assert.equal(history.current.audioMapping.result.manualVerification?.revisionId, saved.selectionStageId);
  assert.deepEqual(history.history[1].audioMapping, before.current.audioMapping, '旧映射保留');
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, sibling.planId), siblingBefore, '另一份声音安排完全不变');
  const output = getBatchOutputArrangementView(db, 'p', batchId, first.planId);
  assert.deepEqual(output.subtitleCues.map(cue => cue.text), ['好擦洗。']);
  const card = getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === first.planId)!;
  assert.equal(card.approvable, true); assert.equal(card.approved, false);
  assert.ok(card.warnings.some(message => message.includes('仅供参考')));
  reselectFormulaOutput(db, 'p', batchId, first.planId, { requestKey: 'late-auto-mapping', expectedStageId: history.current.id,
    expectedOutputVersionId: output.outputVersionId, expectedEditRevision: output.editRevision });
  let replacedStage: string | undefined;
  const normal = createFormulaStageExecutor(async () => null);
  await runPendingOnce({ db, workerId: 'late-auto-mapping', concurrency: 1, log: () => {}, executors: [{ ...normal, async execute(context) {
    const current = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
    const prepared = await normal.execute(context);
    if (!replacedStage && context.claim.task.targetId === current.current.audioMapping.stageId) {
      replacedStage = current.current.id;
      const latest = readFormulaManualAudio(db, 'p', batchId, first.planId);
      await saveFormulaManualAudio(db, 'p', batchId, first.planId, { ...input, ...latest.expected, requestKey: 'replace-running-mapping' });
    }
    return prepared;
  } }, createBatchRenderExecutor()] });
  assert.ok(replacedStage);
  const afterLate = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
  assert.equal(afterLate.history.find(item => item.id === replacedStage)?.audioMapping.result, null, '旧自动映射晚到不能覆盖新的人工选择');
  assert.equal(afterLate.current.audioMapping.result?.status, 'mapped');
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, sibling.planId), siblingBefore);
  assert.notEqual(getBatchOutputArrangementView(db, 'p', batchId, first.planId).outputVersionId, output.outputVersionId, '重新制作建立新版本，旧版本保留');
  console.log('人工声音用途：无模型恢复、差异/备注保留、原声字幕、失败回滚、幂等、重启与同脚本隔离通过');
} finally {
  db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
