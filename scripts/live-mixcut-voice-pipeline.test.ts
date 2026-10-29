import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// 任务 08：新规矩的生产链（选片 → 识别原声 → AI 判断 → 定声音 → 配音）。
// 识别、AI、配音都是假服务；选片和媒体核验走真实文件。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-voice-pipeline-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { readLiveMixcutAppliedVersions } = await import('../lib/live-mixcut/schema.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { readFormulaSelection } = await import('../lib/live-mixcut/formula/selection-store.ts');
  const { readFormulaJudgmentResult, readFormulaVoiceResult, readFormulaVoiceNarrationResult } =
    await import('../lib/live-mixcut/formula/pipeline-v2.ts');
  const { readFormulaScheduleResult, readFormulaScheduleStageId } = await import('../lib/live-mixcut/formula/schedule.ts');
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { batchOutputReviewContext } = await import('../lib/live-mixcut/review-context.ts');
  const { restoreFormulaScheduleLine } = await import('../lib/live-mixcut/formula/restore-line.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL);
    INSERT INTO projects (id,name) VALUES ('p','新规矩声音链');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert(readLiveMixcutAppliedVersions(db).includes(6), '排时间的表走追加迁移，旧库打开时补上');
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);

  const vo = path.join(root, 'vo.mp4'), still = path.join(root, 'still.mp4'), spare = path.join(root, 'spare.mp4');
  const voice = path.join(root, 'voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', vo]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', still]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', spare]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', voice]);
  const voId = await registerManagedCopy(db, 'p', { sourcePath: vo });
  const stillId = await registerManagedCopy(db, 'p', { sourcePath: still });
  const spareId = await registerManagedCopy(db, 'p', { sourcePath: spare });

  const batchId = createBatchProduction(db, 'p', '缺号不停', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: voId, sourcePath: 'VO1_口播_真人_“好擦洗。”.mp4' });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: stillId, sourcePath: 'G1_静物_正面.mp4' });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: spareId, sourcePath: 'G3_静物_侧面.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', batchId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 3, 16, 'VO1 G1 G2', '好擦洗。\n坐得稳。\n很结实。'],
    [34, '抖音', 2, 10, 'VO1 G1', '第一句话。\n第二句话。'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 3 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 3, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 4, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }],
      bgm: { mode: 'none', trackIds: [] }, production } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'voice-chain',
    settingsId: settings.saved!.id, expectedInputRevision: 4, rulesVersion: 'formula-generation/2' });
  assert.equal(request.rulesVersion, 'formula-generation/2');
  assert.deepEqual(request.outputs.map(output => output.scriptNumber), ['12', '12', '34']);

  let transcriptions = 0, syntheses = 0, modelCalls = 0;
  let failScript34 = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/audio/speech')) {
      syntheses += 1;
      const body = JSON.parse(String(init!.body)) as { input: string };
      // 配音只要求文字对得上；音频是真实的一秒 WAV。
      assert.ok(body.input.trim());
      return Response.json({ output: { audio: { data: fs.readFileSync(voice).toString('base64') } } });
    }
    if (init?.body instanceof FormData && init.body.has('prompt')) {
      const text = String(init.body.get('prompt'));
      return Response.json({ words: [{ word: text.replace(/[。！？，]/g, ''), start: 0.1, end: 0.9 }] });
    }
    transcriptions += 1;
    return Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.25, end: 1.5 }] });
  };
  const model = { id: 'fixture', name: '测试模型', model: 'fixture', async complete(input: { userPrompt: string }) {
    modelCalls += 1;
    const body = JSON.parse(input.userPrompt) as { script: { lines: Array<{ text: string }> } };
    if (failScript34 && body.script.lines.some(line => line.text.includes('第一句话'))) throw new Error('fixture network down');
    const similarLine = body.script.lines.findIndex(line => line.text.includes('恢复测试行'));
    return similarLine < 0 ? { similar: [], bestVo: null, related: [] }
      : { similar: [{ lineIndex: similarLine, logicalCode: 'VO2' }], bestVo: null, related: [] };
  } };
  const executor = createFormulaStageExecutor(async () => model);
  const renderExecutor = createBatchRenderExecutor();
  await runPendingOnce({ db, workerId: 'voice-chain', concurrency: 1, executors: [executor, renderExecutor], log: () => {} });

  const planId = (index: number) => request.outputs[index].planId;
  const selectStageId = (index: number) => (db.prepare("SELECT id FROM live_mixcut_formula_stages WHERE planId=? AND kind='select'")
    .get(planId(index)) as { id: string }).id;

  // 1. 缺号不停：G2 没有文件，选片照样通过并记下缺号。
  const selection = readFormulaSelection(db, 'p', batchId, planId(0))!;
  assert.equal(selection.status, 'selected');
  assert.equal(selection.algorithmVersion, 'formula-selection/6');
  assert.deepEqual(selection.missingCodes, ['G2']);
  assert.equal(selection.slots.find(slot => slot.logicalCode === 'G2')?.candidate, null);
  assert.ok(selection.slots.find(slot => slot.logicalCode === 'VO1')?.candidate);

  // 2. 文案逐字写着口播台词：那一行由原声说，只给剩下的一行配音，每行一段。
  const voice12 = readFormulaVoiceResult(db, selectStageId(0))!;
  assert.equal(voice12.status, 'ready');
  assert.equal(voice12.algorithmVersion, 'formula-voice/1');
  assert.deepEqual(voice12.narrationLines, [1, 2], '第 0 行被口播原声覆盖');
  assert.equal(voice12.plan.lines[0].fate?.type, 'source');
  assert.equal(voice12.plan.lines[0].fate?.basis, 'planned');
  assert.equal(voice12.plan.lines[1].fate, null);
  assert.equal(voice12.plan.lines[2].fate, null);
  assert.equal(voice12.missingCodes.includes('G2'), true);
  assert.equal(voice12.plan.items.some(item => item.kind === 'shot' && item.substitution?.replacedCode === 'G2'), true,
    '缺号由同类的替代镜头顶上');
  const narration12 = readFormulaVoiceNarrationResult(db, selectStageId(0))!;
  assert.equal(narration12.algorithmVersion, 'formula-narration-stage/2');
  assert.deepEqual(narration12.items.map(item => item.lineIndex), [1, 2]);
  assert.ok(narration12.items[0].audio.durationUs > 0);

  // 3. 文案没写口播台词也不停：AI 没挑出相近的行，口播照样放，全部文案配音。
  const voice34 = readFormulaVoiceResult(db, selectStageId(2));
  assert.equal(voice34, null, '脚本 34 的 AI 判断先失败，定声音不往前跑');
  const failedProgress = getBatchWorkspace(db, 'p', batchId).formulaGeneration!;
  const failedItem = failedProgress.items.find(item => item.planId === planId(2))!;
  assert.equal(failedItem.status, 'needs_attention');
  assert.match(failedItem.detail, /AI 判断调用失败/);
  assert.ok(failedItem.retryTaskId, '失败的成片带可重试的任务');
  const otherItems = failedProgress.items.filter(item => item.planId !== planId(2));
  assert(otherItems.every(item => item.status !== 'needs_attention'), '同批其他成片照常往前走');
  assert.equal(failedProgress.needsAttention, 1);

  // 4. AI 问题修好后重试这一条，其余成片不受影响。
  retryTask(db, 'p', failedItem.retryTaskId!);
  failScript34 = false;
  await runPendingOnce({ db, workerId: 'voice-chain-retry', concurrency: 1, executors: [executor, renderExecutor], log: () => {} });
  const voice34Retried = readFormulaVoiceResult(db, selectStageId(2))!;
  assert.equal(voice34Retried.status, 'ready');
  assert.deepEqual(voice34Retried.narrationLines, [0, 1], '文案没写口播台词：两行都配音，不停下等人');
  assert.equal(voice34Retried.plan.items.some(item => item.kind === 'vo'), true, '口播照样放原片');
  const narration34 = readFormulaVoiceNarrationResult(db, selectStageId(2))!;
  assert.deepEqual(narration34.items.map(item => item.lineIndex), [0, 1]);
  const afterRetry = getBatchWorkspace(db, 'p', batchId).formulaGeneration!;
  assert.equal(afterRetry.needsAttention, 0);
  // 排时间接上了：三份都排出成片、通过执行检查、生成审片封面，进到审片工作台。
  assert(afterRetry.items.every(item => item.phase === '待审片' && item.status === 'ready'),
    '定声音、配音、排时间、执行检查和封面全部走完，三条都能审');

  // 5. 配音复用：同样文字、同样声音只合成一次；识别原声也只调用一次。
  assert.equal(syntheses, 4, '脚本 12 的两份共用两段配音，脚本 34 两行各一段');
  assert.equal(transcriptions, 1, '同一段口播的识别结果跨份复用');
  const judgments = [readFormulaJudgmentResult(db, selectStageId(0))!, readFormulaJudgmentResult(db, selectStageId(1))!];
  assert(judgments.every(result => result.algorithmVersion === 'formula-judgment-stage/1'));
  assert.equal(judgments.filter(result => result.cached).length, 1, '同文案同素材的第二份直接读判断缓存');
  assert.equal(modelCalls, 3, '脚本 12 只问一次模型，脚本 34 首次失败、重试成功各一次');

  // 6. 排时间按实际配音时长排出画面、声音、字幕和审片标记；新批次不建旧时间轴。
  const schedule12 = readFormulaScheduleResult(db, selectStageId(0))!;
  assert.equal(schedule12.status, 'planned');
  assert.equal(schedule12.algorithmVersion, 'formula-schedule/1', '新批次的排片结果标新的算法版本');
  assert.equal(schedule12.timeline.algorithmVersion, 'formula-scheduling/2');
  assert.equal(schedule12.timeline.mode, 'mixed');
  assert.ok(schedule12.timeline.totalDurationUs > 0);
  assert.ok(schedule12.timeline.clips.some(clip => clip.kind === 'vo'), '原声镜头的画面在');
  assert.ok(schedule12.timeline.sounds.some(sound => sound.kind === 'narration'), '配音在');
  assert.ok(schedule12.timeline.words.length > 0, '字幕有逐字时间');
  assert.ok(schedule12.timeline.marks.length > 0, '审片能看出 AI 改过的地方');
  const scheduleStage12 = readFormulaScheduleStageId(db, selectStageId(0))!;
  const output12 = db.prepare(`SELECT o.id,o.arrangementJson FROM live_mixcut_formula_schedule_output_versions f
    JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId WHERE f.scheduleStageId=?`).get(scheduleStage12) as
      { id: string; arrangementJson: string };
  const arrangement12 = JSON.parse(output12.arrangementJson) as { formula: { timelineStageId: string; selectionStageId: string };
    productionReady: boolean; targetDurationUs: number; formulaExecution?: { stageId: string }; audioPlan: { clips: unknown[] } };
  assert.equal(arrangement12.formula.timelineStageId, scheduleStage12, '成片登记的是这次排时间');
  assert.equal(arrangement12.formula.selectionStageId, selectStageId(0));
  assert.equal(arrangement12.targetDurationUs, schedule12.timeline.totalDurationUs, '成片长度以读完为准');
  assert.equal(arrangement12.productionReady, true);
  assert.ok(arrangement12.formulaExecution?.stageId, '执行检查已经通过并记在成片上');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM live_mixcut_formula_schedule_output_versions').get() as { count: number }).count, 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM live_mixcut_formula_schedule_execution_results').get() as { count: number }).count, 3);
  const card12 = getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === planId(0))!;
  const marks12 = card12.formula!.reviewMarks;
  assert.ok(marks12.length > 0, '工作台的成片摘要带 AI 改过的地方');
  assert.ok(marks12.some(mark => mark.kind === 'skipped-line' && mark.message.includes('文案逐字写着这句')),
    '省掉的文案行说清是哪一行、被哪段口播说了');
  assert.equal(marks12.find(mark => mark.kind === 'skipped-line')?.restorable, false,
    '「文案逐字写着」的行没有恢复入口');
  assert.ok(marks12.some(mark => mark.kind === 'substitute' && mark.message.includes('G2')),
    '替代镜头说清顶替了哪个缺号');
  assert.ok(marks12.every(mark => mark.message.trim().length > 0));
  assert.equal(card12.formula!.bodyDurationUs, schedule12.timeline.totalDurationUs, '工作台显示的时长就是排出来的长度');
  const review12 = batchOutputReviewContext(db, output12.id, arrangement12);
  assert.equal(review12.issues.filter(issue => issue.kind === 'deviation').length, 0,
    'AI 自己排出的补镜、替镜和没用上的镜头不算人工改动');
  assert.equal(review12.issues.filter(issue => issue.kind === 'blocker').length, 0, '审片没有拦人的问题');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM live_mixcut_formula_timeline_stages').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM live_mixcut_formula_timeline_results').get() as { count: number }).count, 0);

  // 7. 旧批次照旧版本读：不传规矩版本时仍是旧链，不建新规矩阶段。
  const legacyBatch = createBatchProduction(db, 'p', '旧批次照旧', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', legacyBatch, { assetId: voId, sourcePath: 'VO1_口播_真人_“好擦洗。”.mp4' });
  registerFormulaAssetBinding(db, 'p', legacyBatch, { assetId: stillId, sourcePath: 'G1_静物_正面.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', legacyBatch);
  const legacyImported = await createFormulaImportSession(db, 'p', legacyBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', legacyBatch, legacyImported.id, { expectedRevision: 2, excludedKeys: [] });
  const legacyProduction = defaultFormulaProductionSettings();
  legacyProduction.audio = { mode: 'original', tts: null };
  legacyProduction.packaging = { mode: 'none', templateIds: [] };
  const legacySettings = await saveFormulaSettings(db, 'p', legacyBatch, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: legacyImported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] },
      production: legacyProduction } });
  // 8. 声音方式只认两种：新规矩遇到「只用原声」直接报错并说明原因。
  await assert.rejects(createFormulaGenerationRequest(db, 'p', legacyBatch, { requestKey: 'original-mode',
    settingsId: legacySettings.saved!.id, expectedInputRevision: 3, rulesVersion: 'formula-generation/2' }), /只用原声/);
  const legacy = await createFormulaGenerationRequest(db, 'p', legacyBatch, { requestKey: 'legacy',
    settingsId: legacySettings.saved!.id, expectedInputRevision: 3 });
  assert.equal(legacy.rulesVersion, 'formula-generation/1', '旧批次照旧版本读');
  const legacyWorkspace = getBatchWorkspace(db, 'p', legacyBatch).formulaGeneration;
  assert.equal(legacyWorkspace?.items[0].phase, '选片', '旧批次照旧能打开看');
  const legacyCard = getBatchWorkspace(db, 'p', legacyBatch).cards[0];
  assert.deepEqual(legacyCard.formula?.reviewMarks ?? [], [], '旧批次没有标记就不显示');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM live_mixcut_formula_judgment_stages').get() as { count: number }).count, 3,
    '旧批次不建新规矩的判断阶段，判断阶段仍只有新批次那三份');

  // 9. 另一种声音方式（统一配音）也从定声音走通到排时间，成片同样能审。
  const narrationBatch = createBatchProduction(db, 'p', '统一配音走通', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', narrationBatch, { assetId: voId, sourcePath: 'VO1_口播_真人_“好擦洗。”.mp4' });
  registerFormulaAssetBinding(db, 'p', narrationBatch, { assetId: stillId, sourcePath: 'G1_静物_正面.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', narrationBatch);
  const narrationImported = await createFormulaImportSession(db, 'p', narrationBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', narrationBatch, narrationImported.id, { expectedRevision: 2, excludedKeys: [] });
  const narrationProduction = defaultFormulaProductionSettings();
  narrationProduction.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  narrationProduction.packaging = { mode: 'none', templateIds: [] };
  const narrationSettings = await saveFormulaSettings(db, 'p', narrationBatch, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: narrationImported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] },
      production: narrationProduction } });
  const narrationRequest = await createFormulaGenerationRequest(db, 'p', narrationBatch, { requestKey: 'narration-mode',
    settingsId: narrationSettings.saved!.id, expectedInputRevision: 3, rulesVersion: 'formula-generation/2' });
  await runPendingOnce({ db, workerId: 'narration-mode', concurrency: 1, executors: [executor, renderExecutor], log: () => {} });
  const narrationPlanId = narrationRequest.outputs[0].planId;
  const narrationSelect = (db.prepare("SELECT id FROM live_mixcut_formula_stages WHERE planId=? AND kind='select'")
    .get(narrationPlanId) as { id: string }).id;
  const narrationVoice = readFormulaVoiceResult(db, narrationSelect)!;
  assert.equal(narrationVoice.mode, 'narration');
  assert.deepEqual(narrationVoice.narrationLines, [0, 1, 2], '统一配音：三行都配音');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM live_mixcut_formula_speech_stages WHERE selectionStageId=?')
    .get(narrationSelect) as { n: number }).n, 0, '统一配音不识别原声');
  const narrationSchedule = readFormulaScheduleResult(db, narrationSelect)!;
  assert.equal(narrationSchedule.algorithmVersion, 'formula-schedule/1');
  assert.equal(narrationSchedule.timeline.mode, 'narration');
  assert.ok(narrationSchedule.timeline.sounds.length > 0);
  assert(narrationSchedule.timeline.sounds.every(sound => sound.kind === 'narration'), '统一配音下没有原声');
  const narrationOutput = db.prepare(`SELECT o.arrangementJson FROM live_mixcut_formula_schedule_output_versions f
    JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
    WHERE s.selectionStageId=?`).get(narrationSelect) as { arrangementJson: string } | undefined;
  assert.ok(narrationOutput, '统一配音也排出成片');
  assert.equal((JSON.parse(narrationOutput!.arrangementJson) as { productionReady: boolean }).productionReady, true);
  const narrationProgress = getBatchWorkspace(db, 'p', narrationBatch).formulaGeneration!;
  assert(narrationProgress.items.every(item => item.phase === '待审片' && item.status === 'ready'), '统一配音的成片能进审片');

  // 10. 恢复这一行：AI 判断相近省掉的行改回普通文案，只影响这一条、只补这一行的配音。
  const book55 = new ExcelJS.Workbook();
  book55.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [55, '抖音', 3, 16, 'VO1 VO2 G1', '好擦洗。\n恢复测试行。\n恢复批第三行。'],
  ]);
  const restoreBatch = createBatchProduction(db, 'p', '恢复一行', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', restoreBatch, { assetId: voId, sourcePath: 'VO1_口播_真人_“好擦洗。”.mp4' });
  registerFormulaAssetBinding(db, 'p', restoreBatch, { assetId: voId, sourcePath: 'VO2_口播_真人_“完全不同的台词。”.mp4' });
  registerFormulaAssetBinding(db, 'p', restoreBatch, { assetId: stillId, sourcePath: 'G1_静物_正面.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', restoreBatch);
  const restoreImported = await createFormulaImportSession(db, 'p', restoreBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book55.xlsx.writeBuffer()), expectedRevision: 3 });
  confirmFormulaImportSession(db, 'p', restoreBatch, restoreImported.id, { expectedRevision: 3, excludedKeys: [] });
  const restoreProduction = defaultFormulaProductionSettings();
  restoreProduction.audio = { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  restoreProduction.packaging = { mode: 'none', templateIds: [] };
  const restoreSettings = await saveFormulaSettings(db, 'p', restoreBatch, { expectedInputRevision: 4, expectedSettingsRevision: 0,
    scriptsSessionId: restoreImported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] },
      production: restoreProduction } });
  const restoreRequest = await createFormulaGenerationRequest(db, 'p', restoreBatch, { requestKey: 'restore-line',
    settingsId: restoreSettings.saved!.id, expectedInputRevision: 4, rulesVersion: 'formula-generation/2' });
  assert.equal(restoreRequest.outputs.length, 2);
  const synthesesBeforeInitial = syntheses;
  await runPendingOnce({ db, workerId: 'restore-line-initial', concurrency: 1, executors: [executor, renderExecutor], log: () => {} });
  assert.equal(syntheses, synthesesBeforeInitial + 1, '两份成片共用同一段配音');

  const restorePlanIds = restoreRequest.outputs.map(output => output.planId);
  const restoreSelect = (index: number) => (db.prepare("SELECT id FROM live_mixcut_formula_stages WHERE planId=? AND kind='select'")
    .get(restorePlanIds[index]) as { id: string }).id;
  const currentVersionId = (planId: string) => (db.prepare('SELECT currentVersionId FROM live_mixcut_output_plans WHERE id=?')
    .get(planId) as { currentVersionId: string }).currentVersionId;

  const voiceBefore = readFormulaVoiceResult(db, restoreSelect(0))!;
  assert.deepEqual(voiceBefore.narrationLines, [2], '第 1 行由 AI 判断相近的原声顶掉，只给第 2 行配音');
  assert.equal((voiceBefore.plan.lines[1].fate as { basis?: string } | null)?.basis, 'similar');
  assert.ok(voiceBefore.plan.voUsage.some(item => item.logicalCode === 'VO2' && item.role === 'similar'));

  const restoreMarks = getBatchWorkspace(db, 'p', restoreBatch).cards.find(card => card.planId === restorePlanIds[0])!.formula!.reviewMarks;
  const similarMark = restoreMarks.find(mark => mark.kind === 'skipped-line' && mark.restorable);
  assert.ok(similarMark, 'AI 判断相近的行带恢复入口');
  assert.equal(similarMark!.lineIndex, 1);
  assert.equal(restoreMarks.find(mark => mark.kind === 'skipped-line' && !mark.restorable)?.lineIndex, 0,
    '文案逐字写着的行没有恢复入口');

  const oldVersion0 = currentVersionId(restorePlanIds[0]);
  const oldVersion1 = currentVersionId(restorePlanIds[1]);
  assert.throws(() => restoreFormulaScheduleLine(db, 'p', restoreBatch, restorePlanIds[0],
    { lineIndex: 0, expectedOutputVersionId: oldVersion0 }), /逐字写着/);
  assert.throws(() => restoreFormulaScheduleLine(db, 'p', restoreBatch, restorePlanIds[0],
    { lineIndex: 9, expectedOutputVersionId: oldVersion0 }), /不在这次排片里/);
  assert.throws(() => restoreFormulaScheduleLine(db, 'p', restoreBatch, restorePlanIds[0],
    { lineIndex: 1, expectedOutputVersionId: 'stale-version' }), /已更新/);

  const synthesesBeforeRestore = syntheses;
  const restored = restoreFormulaScheduleLine(db, 'p', restoreBatch, restorePlanIds[0],
    { lineIndex: 1, expectedOutputVersionId: oldVersion0 });
  assert.equal(restored.status, 'queued');
  assert.ok(restored.taskId);
  assert.equal(restoreFormulaScheduleLine(db, 'p', restoreBatch, restorePlanIds[0],
    { lineIndex: 1, expectedOutputVersionId: oldVersion0 }).status, 'already_restored', '重复点击不重复建修订');
  await runPendingOnce({ db, workerId: 'restore-line-run', concurrency: 1, executors: [executor, renderExecutor], log: () => {} });
  assert.equal(syntheses, synthesesBeforeRestore + 1, '只新合成这一行的配音，其余配音复用');

  const voiceAfter = readFormulaVoiceResult(db, restoreSelect(0))!;
  assert.equal(voiceAfter.plan.lines[1].fate, null, '恢复的行改回普通文案');
  assert.deepEqual(voiceAfter.narrationLines, [1, 2]);
  assert.ok(voiceAfter.plan.unusedSlots.some(slot => slot.logicalCode === 'VO2'), '不再顶行的口播按「一段都没用上」处理');
  const narrationAfter = readFormulaVoiceNarrationResult(db, restoreSelect(0))!;
  assert.deepEqual(narrationAfter.items.map(item => item.lineIndex), [1, 2]);
  const scheduleAfter = readFormulaScheduleResult(db, restoreSelect(0))!;
  assert.ok(scheduleAfter.timeline.sounds.some(sound => sound.id === 'narration:1'), '恢复的行有了配音');
  assert.ok(!scheduleAfter.timeline.marks.some(mark => mark.type === 'skipped-line' && mark.lineIndex === 1));

  const newVersion0 = currentVersionId(restorePlanIds[0]);
  assert.notEqual(newVersion0, oldVersion0, '这条成片出了新版本');
  assert.equal(currentVersionId(restorePlanIds[1]), oldVersion1, '同批其他成片不变');
  const newArrangement = JSON.parse((db.prepare('SELECT arrangementJson FROM live_mixcut_output_versions WHERE id=?')
    .get(newVersion0) as { arrangementJson: string }).arrangementJson) as
      { productionReady: boolean; formula: { timelineStageId: string } };
  assert.equal(newArrangement.formula.timelineStageId, readFormulaScheduleStageId(db, restoreSelect(0)));
  assert.equal(newArrangement.productionReady, true);
  const restoredItem = getBatchWorkspace(db, 'p', restoreBatch).formulaGeneration!.items.find(item => item.planId === restorePlanIds[0])!;
  assert.equal(restoredItem.phase, '待审片', '新版本回到待审');
  assert.equal(restoredItem.status, 'ready');
  const afterMarks = getBatchWorkspace(db, 'p', restoreBatch).cards.find(card => card.planId === restorePlanIds[0])!.formula!.reviewMarks;
  assert.ok(!afterMarks.some(mark => mark.kind === 'skipped-line' && mark.lineIndex === 1), '恢复的行不再标成省掉');

  // 11. 新规矩的成片也能写清单：取用区间、来源码、声音来源、逐字时间和审片标记都记全。
  const { captureFormulaManifestItem, csvManifest } = await import('../lib/live-mixcut/formula/export-manifest.ts');
  const manifestItem = captureFormulaManifestItem(db, 'p', batchId, planId(0), new Map());
  assert.equal(manifestItem.clips.length, schedule12.timeline.clips.length, '清单的镜头与排时间结果一一对应');
  assert.equal(manifestItem.timelineStageId, scheduleStage12, '清单记的是这次排时间');
  const manifestMapping = manifestItem.scriptAudioMapping;
  assert.equal(manifestMapping.scope, 'schedule', '新规矩按排时间结果记文案与声音');
  if (manifestMapping.scope !== 'schedule') throw new Error('清单应记排时间来源');
  assert.deepEqual(manifestMapping.lines.map(line => line.spokenBy.kind), ['source', 'narration', 'narration'],
    '第 0 行是口播原声，其余是配音');
  assert.ok(manifestMapping.lines[0].spokenBy.kind === 'source'
    && manifestMapping.lines[0].spokenBy.logicalCode === 'VO1');
  assert.ok(manifestMapping.lines[0].words.length > 0, '原声也带逐字时间');
  assert.ok(manifestMapping.sources.some(source => source.assetId === voId && source.speechOutUs > source.speechInUs),
    '清单记下原声来自哪个素材、用了哪一段');
  assert.ok(manifestMapping.narrations.length > 0, '配音的来源也记下来');
  assert.ok(manifestMapping.marks.length > 0, '审片标记进清单');
  assert.ok(manifestItem.clips.every(clip => clip.playbackRate === 1), '清单里没有变速镜头');
  const fillerClips = schedule12.timeline.clips.filter(clip => clip.kind === 'filler');
  const manifestFillers = manifestItem.clips.filter(clip => clip.selectionReason === 'schedule_filler');
  assert.equal(manifestFillers.length, fillerClips.length, '补镜如实记成排时间补的画面');
  assert.ok(manifestFillers.every(clip => clip.manualDeviation === null), '补镜不是人工改动');
  const scheduleClipIds = new Set(schedule12.timeline.clips.map(clip => clip.id));
  assert.ok(manifestItem.clips.filter(clip => scheduleClipIds.has(clip.clipId))
    .every(clip => clip.manualDeviation === null), '排时间自己排的镜头不算人工改动');
  const scheduledShot = manifestItem.clips.find(clip =>
    schedule12.timeline.clips.find(item => item.id === clip.clipId)?.kind === 'shot');
  if (scheduledShot) assert.ok(scheduledShot.originalCode, '非口播镜头也写明用的是哪个编号');
  assert.equal(manifestItem.deviations.insertedClips.length, 0, '补镜和替代镜头不算人工插入');
  const csv = csvManifest({ items: [{ ...manifestItem,
    video: { artifactId: 'video', filename: '成片.mp4', checksum: 'a' },
    coverFile: { artifactId: 'cover', filename: '成片-封面.jpg', checksum: 'b' } }] });
  assert.ok(csv.includes('"成片.mp4"') && csv.includes('"成片-封面.jpg"'), '清单.csv 能写出行和文件');

  // 12. 制作检查的通过标记被冲掉后，修复循环把标记补回来；已经通过的成片不会被打回未通过。
  const { repairFormulaContinuations } = await import('../lib/live-mixcut/formula/selection-store.ts');
  const { repairFormulaScheduleExecutionChecks } = await import('../lib/live-mixcut/formula/schedule-output.ts');
  const { formulaOutputExecutionReady } = await import('../lib/live-mixcut/formula/execution-store.ts');
  const narrationVersion = db.prepare(`SELECT o.id,o.arrangementJson FROM live_mixcut_formula_schedule_output_versions f
    JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
    WHERE s.selectionStageId=?`).get(narrationSelect) as { id: string; arrangementJson: string };
  const checkCount = () => (db.prepare('SELECT COUNT(*) AS n FROM live_mixcut_formula_schedule_execution_checks WHERE outputVersionId=?')
    .get(narrationVersion.id) as { n: number }).n;
  const readArrangement = () => JSON.parse((db.prepare('SELECT arrangementJson FROM live_mixcut_output_versions WHERE id=?')
    .get(narrationVersion.id) as { arrangementJson: string }).arrangementJson) as
      { productionReady: boolean; blockers: string[]; formulaExecution?: { stageId: string } };
  const checksBefore = checkCount();
  // 模拟交错：检查提交之后，修复逻辑拿着旧快照把通过标记覆盖成未通过。
  const stripped = JSON.parse(narrationVersion.arrangementJson) as Record<string, unknown>;
  stripped.productionReady = false;
  delete stripped.formulaExecution;
  stripped.blockers = ['formula_execution_pending'];
  db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(stripped), narrationVersion.id);
  // 旧链的修复只认旧表，看不到新规矩的成片：只跑新链这条修复，才能证明它自己补得回来。
  repairFormulaScheduleExecutionChecks(db, () => {});
  assert.equal(readArrangement().productionReady, true, '新规矩的修复单独跑也能把通过标记补回来');
  repairFormulaContinuations(db);
  const healed = readArrangement();
  assert.equal(healed.productionReady, true, '检查结果还在、内容没变，修复把通过标记补回来');
  assert.ok(healed.formulaExecution?.stageId, '补回来的标记指向原来那张检查单');
  assert.ok(!healed.blockers.includes('formula_execution_pending'));
  assert.equal(formulaOutputExecutionReady(db, narrationVersion.id, healed), true);
  assert.equal(checkCount(), checksBefore, '补标记不新开检查单');
  repairFormulaContinuations(db);
  repairFormulaContinuations(db);
  const afterRepairs = readArrangement();
  assert.equal(afterRepairs.productionReady, true, '修复跑再多轮也不把已通过的成片打回');
  assert.equal(afterRepairs.formulaExecution?.stageId, healed.formulaExecution?.stageId);
  assert.equal(checkCount(), checksBefore, '反复修复不会堆检查单');

  // 13. 新规矩的成片能人工换片：核验记录写新表，不撞旧时间轴的外键和归属触发器。
  const { applyFormulaManualClipEdit } = await import('../lib/live-mixcut/formula/manual-clip-edit.ts');
  const { getBatchOutputArrangementView } = await import('../lib/live-mixcut/output-arrangement.ts');
  const editable12 = getBatchOutputArrangementView(db, 'p', batchId, planId(0));
  assert.ok(editable12.editable && editable12.outputVersionId, '成片当前可以编辑');
  const targetClip = editable12.clips.find(clip => clip.assetId === stillId);
  assert.ok(targetClip, '排时间里有静物镜头可以换');
  const spareFingerprint = (db.prepare('SELECT contentFingerprint FROM live_mixcut_assets WHERE id=?')
    .get(spareId) as { contentFingerprint: string }).contentFingerprint;
  const targetLengthUs = targetClip!.sourceEndUs - targetClip!.sourceStartUs;
  await applyFormulaManualClipEdit(db, 'p', batchId, planId(0), {
    type: 'replace', clipId: targetClip!.clipId, assetId: spareId,
    expectedOutputVersionId: editable12.outputVersionId!, expectedEditRevision: editable12.editRevision,
    requestKey: 'schedule-manual-replace',
    media: { contentFingerprint: spareFingerprint, inUs: 0, outUs: targetLengthUs, protected: null,
      sound: 'mute', segments: [], confirmed: true },
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM live_mixcut_formula_schedule_manual_media WHERE outputVersionId=?')
    .get(editable12.outputVersionId) as { n: number }).n, 1, '新规矩成片的人工素材记录写进新表');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM live_mixcut_formula_manual_media WHERE outputVersionId=?')
    .get(editable12.outputVersionId) as { n: number }).n, 0, '旧时间轴的人工素材表一行不写');
  const replacedView = getBatchOutputArrangementView(db, 'p', batchId, planId(0));
  assert.equal(replacedView.clips.find(clip => clip.clipId === targetClip!.clipId)?.assetId, spareId);
  assert.ok(replacedView.reviewContext?.issues.some(issue => issue.message.includes('人工换片')), '审片能看到人工换片');
  const manifestAfterReplace = captureFormulaManifestItem(db, 'p', batchId, planId(0), new Map());
  assert.equal(manifestAfterReplace.deviations.replacedClips.length, 1, '清单也记下这次人工换片');
  assert.equal(manifestAfterReplace.clips.find(clip => clip.clipId === targetClip!.clipId)?.manualDeviation,
    'source_changed', '非口播换片在清单里不再认成没改动');

  console.log('formula voice pipeline tests passed (fake ASR/AI/TTS, real files)');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('formula-voice-pipeline-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
