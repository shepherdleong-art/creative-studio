import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { checkBatchProductionReadiness } from '../lib/live-mixcut/readiness.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction, getBatchProduction, getBatchVersion } from '../lib/live-mixcut/versions.ts';
import { listOutputPlans } from '../lib/live-mixcut/plans.ts';
import { getBatchTasksView } from '../lib/live-mixcut/tasks.ts';
import { stopBatch } from '../lib/live-mixcut/scheduler.ts';
import { createFormulaImportSession, confirmFormulaImportSession, readFormulaInputs } from '../lib/live-mixcut/formula/import-store.ts';
import { saveFormulaSettings, readFormulaSettings } from '../lib/live-mixcut/formula/settings-store.ts';
import { createFormulaGenerationRequest, readFormulaGenerationRequest } from '../lib/live-mixcut/formula/generation.ts';
import { createFormulaStageExecutor } from '../lib/live-mixcut/formula/stage-executor.ts';
import { readFormulaSelectionHistory } from '../lib/live-mixcut/formula/reselection.ts';
import { runPendingOnce } from '../lib/live-mixcut/runner.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-input-revision-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('p','修改输入'),('other','其他项目');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p','other']);
  const batchId = createBatchProduction(db, 'p', '保留旧制作', undefined, { planningMode: 'formula' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 15, 'P100', '待修正的文案']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '原表.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 0, excludedKeys: [] });
  const settingInput = { expectedInputRevision: 1, expectedSettingsRevision: 0, scriptsSessionId: imported.id,
    settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } };
  const settings = await saveFormulaSettings(db, 'p', batchId, settingInput);
  const firstInput = { requestKey: 'first', expectedInputRevision: 1, settingsId: settings.saved!.id };
  const first = await createFormulaGenerationRequest(db, 'p', batchId, firstInput);
  const oldPlans = listOutputPlans(db, first.batchVersionId);
  assert.equal(readFormulaSettings(db, 'p', batchId).editable, false);
  const { beginFormulaInputRevision } = await import('../lib/live-mixcut/formula/input-revision.ts');
  const openInput = { expectedBatchVersionId: first.batchVersionId, expectedInputRevision: 1 };
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  assert.throws(() => beginFormulaInputRevision(db, 'p', batchId, openInput), /不可用/);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  const ordinary = createBatchProduction(db, 'p', '普通批次');
  assert.throws(() => beginFormulaInputRevision(db, 'p', ordinary, openInput), /实拍公式/);
  // Simulate storage failure after the revision increment: neither half may survive.
  db.exec("CREATE TRIGGER fail_input_open BEFORE INSERT ON live_mixcut_formula_input_revisions BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  assert.throws(() => beginFormulaInputRevision(db, 'p', batchId, openInput), /fixture storage failure/);
  assert.equal(readFormulaInputs(db, 'p', batchId).revision, 1);
  assert.equal(readFormulaInputs(db, 'p', batchId).editing.editable, false);
  db.exec('DROP TRIGGER fail_input_open');
  const draft = beginFormulaInputRevision(db, 'p', batchId, openInput);
  assert.equal(draft.editable, true);
  assert.equal(getBatchProduction(db, 'p', batchId)?.currentVersionId, first.batchVersionId, '修改输入期间旧成片仍是当前可查看的制作');
  assert.equal(getBatchVersion(db, batchId, first.batchVersionId)?.inputState, 'frozen', '旧输入快照不能解冻改写');
  assert.equal(readFormulaInputs(db, 'p', batchId).revision, 2);
  assert.equal(readFormulaSettings(db, 'p', batchId).editable, true);
  assert.deepEqual(beginFormulaInputRevision(db, 'p', batchId, openInput), draft, '重复点击只打开同一份输入修订');
  const reopened = new Database(path.join(root, 'test.db'));
  try {
    assert.deepEqual(readFormulaInputs(reopened, 'p', batchId).editing, draft, '新连接恢复同一份可编辑输入');
  } finally { reopened.close(); }
  await assert.rejects(saveFormulaSettings(db, 'p', batchId, { ...settingInput, expectedSettingsRevision: 1 }), /更新/);
  const changed = await saveFormulaSettings(db, 'p', batchId, { ...settingInput, expectedInputRevision: 2, expectedSettingsRevision: 1,
    settings: { ...settingInput.settings, selections: [{ key: '1:2', copies: 2 }] } });
  assert.deepEqual(readFormulaGenerationRequest(db, 'p', batchId, first.id), first, '改草稿不修改旧生成快照');
  stopBatch(db, 'p', batchId);
  assert.deepEqual(await createFormulaGenerationRequest(db, 'p', batchId, firstInput), first);
  assert.equal(getBatchTasksView(db, 'p', batchId).batch.controlState, 'stopped', '重试旧请求不能偷偷恢复已停止批次');
  const second = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'second', expectedInputRevision: 2, settingsId: changed.saved!.id });
  assert.equal(getBatchTasksView(db, 'p', batchId).batch.controlState, 'running', '明确点击新一轮生成后必须实际开始');
  assert.notEqual(second.batchVersionId, first.batchVersionId);
  assert.equal(second.outputs.length, 2);
  assert.deepEqual(listOutputPlans(db, first.batchVersionId), oldPlans, '新生成保留全部旧计划');
  assert.equal(readFormulaSettings(db, 'p', batchId).editable, false);
  assert.deepEqual(readFormulaGenerationRequest(db, 'p', batchId, first.id), first);
  assert.throws(() => beginFormulaInputRevision(db, 'other', batchId, openInput), /不存在/);
  assert.throws(() => beginFormulaInputRevision(db, 'p', batchId, openInput), /变化|更新/);
  // Exercise the real worker seam: a completed old computation returns after a new generation starts.
  const executor = createFormulaStageExecutor();
  let superseded = false;
  await runPendingOnce({ db, workerId: 'input-race', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'],
    async execute(context) {
      const prepared = await executor.execute(context);
      if (!superseded) {
        superseded = true;
        beginFormulaInputRevision(db, 'p', batchId, { expectedBatchVersionId: second.batchVersionId, expectedInputRevision: 2 });
        const thirdSettings = await saveFormulaSettings(db, 'p', batchId, { ...settingInput,
          expectedInputRevision: 3, expectedSettingsRevision: 2 });
        await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'third', expectedInputRevision: 3, settingsId: thirdSettings.saved!.id });
      }
      return prepared;
    },
  }] });
  assert.equal(superseded, true);
  const oldSelection = readFormulaSelectionHistory(db, 'p', batchId, second.outputs[0].planId);
  assert.equal(oldSelection.current.result, null, '旧执行结果不能在新一轮生成后提交');
  assert.equal(oldSelection.current.task?.status, 'cancelled');
  assert.equal((await checkBatchProductionReadiness(options)).available, true, '旧输入修订作为历史保留，不能误判成失效结构');
  seedLiveMixcutProjects(options, ['p','other']);
  console.log('formula input revision: 冻结快照、显式修改、故障回滚、重开恢复、旧页拒绝、重新生成与迟到结果隔离通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
