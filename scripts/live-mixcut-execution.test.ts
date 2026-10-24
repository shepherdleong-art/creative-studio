import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: import → generate → persistent worker → review → publish/media.
// External speech services use fixtures; media, rendering and publication are real.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-execution-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
const audioMode = process.argv.includes('--mixed') ? 'mixed' : process.argv.includes('--narration') ? 'narration' : 'original';
const packaged = process.argv.includes('--packaged');
const unconfigured = process.argv.includes('--unconfigured');
const partialSource = process.argv.includes('--partial-source');
if (partialSource) assert.equal(audioMode, 'mixed');
const manualMapping = process.argv.includes('--manual-mapping');
if (manualMapping) assert.equal(audioMode, 'mixed');
const semanticSource = process.argv.includes('--semantic-source');
if (semanticSource) { assert.equal(audioMode, 'mixed'); assert.equal(manualMapping, false); }
const textRoles = process.argv.includes('--text-roles');
if (textRoles) { assert.equal(audioMode, 'mixed'); assert.equal(packaged, true); assert.equal(manualMapping || semanticSource, false); }
if (packaged) process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const makeFormulaExecutor = () => createFormulaStageExecutor(async () => manualMapping ? null : ({ id: 'fixture', name: '文案映射夹具', model: 'fixture',
    async complete(input) {
      const prompt = JSON.parse(input.userPrompt);
      if (prompt.task === 'verify_text_roles') return { checks: [], duplicateNarration: false, roleChecks: [
        { blockId: 'text-3', kind: 'on_screen', verdict: 'confirmed', reason: '原文明确标为花字。' },
        { blockId: 'text-4', kind: 'reference', verdict: 'confirmed', reason: '原文是拍摄备注。' },
      ] };
      if (prompt.task === 'verify_source_coverage') return { checks: [{ blockId: 'text-1', verdict: 'covered',
        reason: '好擦洗表达容易清洁，没有增加产品事实。' }], duplicateNarration: false };
      return { blocks: [{ text: semanticSource ? '容易清洁。' : '好擦洗。', kind: 'source', slotId: prompt.sources[0].slotId,
        ...(semanticSource ? { sourceText: '好擦洗。' } : {}) },
        { text: '坐得稳。', kind: 'tts', slotIds: prompt.narrationWindows[0] },
        ...(textRoles ? [{ text: '【花字：加宽坐面】', kind: 'on_screen', slotId: prompt.narrationWindows[0][0], displayText: '加宽坐面' },
          { text: '【备注：镜头慢推】', kind: 'reference' }] : [])] };
    } }));
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { getBatchTasksView } = await import('../lib/live-mixcut/tasks.ts');
  const { retryTask, claimNextTask, recoverInterruptedWork, pauseBatch, resumeBatch } = await import('../lib/live-mixcut/scheduler.ts');
  const { resolveVerifiedProjectAssetMedia } = await import('../lib/live-mixcut/project-asset-media.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { setBatchPlanReviews } = await import('../lib/live-mixcut/review.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'FORMULA',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','执行检查');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const source = path.join(root, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '原声成片', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_原声.mp4' });
  const speechFile = path.join(root, 'speech.wav');
  if (audioMode !== 'original') {
    db.exec(`CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
      INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1)`);
    const silent = path.join(root, 'silent.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silent]);
    const silentId = await registerManagedCopy(db, 'p', { sourcePath: silent });
    registerFormulaAssetBinding(db, 'p', batchId, { assetId: silentId, sourcePath: 'G1_静物.mp4' });
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', speechFile]);
  }
  const inputRevision = audioMode === 'original' ? 1 : 2;
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [141, '抖音', audioMode === 'mixed' ? 2 : 1, audioMode === 'mixed' ? 4 : 3,
      audioMode === 'mixed' ? 'VO1 G1' : audioMode === 'narration' ? 'G1' : 'VO1',
      manualMapping ? '容易清洁。坐得稳。拍摄备注。' : textRoles ? '好擦洗。坐得稳。【花字：加宽坐面】【备注：镜头慢推】' : semanticSource ? '容易清洁。坐得稳。'
        : audioMode === 'mixed' ? '好擦洗。坐得稳。' : audioMode === 'narration' ? '坐得稳。' : '好擦洗。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: inputRevision });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: inputRevision, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.packaging = textRoles ? { mode: 'uniform', templateIds: ['overlay-minimal'] } : { mode: 'none', templateIds: [] };
  production.audio = { mode: audioMode, tts: audioMode === 'original' || unconfigured ? null : { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: inputRevision + 1, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production,
      timing: { mode: 'fixed', scope: 'body', overrideDurationSec: audioMode === 'mixed' ? 4 : 3, speechMarginMs: 125 } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'execute', settingsId: settings.saved!.id, expectedInputRevision: inputRevision + 1 });
  const queuedProgress = getBatchWorkspace(db, 'p', batchId).formulaGeneration;
  assert.equal(queuedProgress?.total, 1, '生成进度来自已保存的输出计划');
  assert.equal(queuedProgress.ready, 0, '建立计划不冒充成片就绪');
  assert.equal(queuedProgress.items[0].phase, '选片');
  globalThis.fetch = async (url, init) => String(url).endsWith('/audio/speech')
    ? Response.json({ output: { audio: { data: fs.readFileSync(speechFile).toString('base64') } } })
    : init?.body instanceof FormData && init.body.has('prompt') ? Response.json({ words: [{ word: '坐得稳', start: 0.1, end: 0.9 }] })
      : Response.json(partialSource
        ? { text: '好擦洗。靠背也舒服。', words: [{ word: '好擦洗', start: 0.125, end: 1.25 }, { word: '靠背也舒服', start: 1.5, end: 2.875 }] }
        : { text: '好擦洗。', words: [{ word: '好擦洗', start: 0.125, end: 2.875 }] });
  const renderExecutor = createBatchRenderExecutor();
  let checkedBeforeCover = false;
  await runPendingOnce({ db, workerId: 'execution', log: entry => { if (entry.level === 'error') console.error(entry.message); },
    executors: [makeFormulaExecutor(), { ...renderExecutor, async execute(context) {
      const planId = request.outputs[0].planId;
      const shown = getBatchOutputArrangementView(db, 'p', batchId, planId).reviewContext!;
      const result = setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...shown }] });
      assert.equal(result.results[0].status, 'not_ready', '封面未完成时，直接提交审核也不能绕过等待');
      checkedBeforeCover = true;
      return renderExecutor.execute(context);
    } }] });
  if (manualMapping) {
    const { readFormulaManualAudio, saveFormulaManualAudio } = await import('../lib/live-mixcut/formula/manual-audio-mapping.ts');
    const plan = request.outputs[0];
    const editor = readFormulaManualAudio(db, 'p', batchId, plan.planId);
    assert.equal(getBatchWorkspace(db, 'p', batchId).formulaGeneration?.needsAttention, 1);
    await saveFormulaManualAudio(db, 'p', batchId, plan.planId, { requestKey: 'manual-execute', ...editor.expected,
      confirmed: true, blocks: [{ text: '容易清洁。', kind: 'source', slotId: plan.slots[0].slotId },
        { text: '坐得稳。', kind: 'tts', slotIds: [plan.slots[1].slotId] }, { text: '拍摄备注。', kind: 'reference' }] });
    await runPendingOnce({ db, workerId: 'manual-execute', log: () => {}, executors: [makeFormulaExecutor(), { ...renderExecutor,
      async execute(context) { checkedBeforeCover = true; return renderExecutor.execute(context); } }] });
    assert.deepEqual(getBatchOutputArrangementView(db, 'p', batchId, plan.planId).subtitleCues.map(cue => cue.text), ['好擦洗', '坐得稳'],
      '人工用途使用真实原声与剩余配音，备注不进入音轨或字幕');
  }
  globalThis.fetch = originalFetch;
  if (unconfigured) {
    const missingVoice = getBatchWorkspace(db, 'p', batchId).formulaGeneration!;
    assert.equal(missingVoice.ready, 0);
    assert.equal(missingVoice.needsAttention, 1, '确实需要配音但未选音色，应提示处理而不是无限等待');
    assert.match(missingVoice.items[0].detail, /配音|音色/);
    assert.equal(missingVoice.finished, false);
  } else {
  const card = getBatchWorkspace(db, 'p', batchId).cards.find(item => item.planId === request.outputs[0].planId)!;
  if (!card.productionReady) console.error(getBatchTasksView(db, 'p', batchId).tasks.map(task => ({ status: task.status, attempts: task.attempts.map(attempt => ({ error: attempt.errorMessage, progress: attempt.progressJson })) })));
  assert.equal(card.productionReady, true, '实际素材、声音与排片检查完成后，成片应结束草稿状态');
  assert.equal(checkedBeforeCover, true);
  assert.equal(card.coverTask?.status, 'succeeded', '通过执行检查后应自动生成真实封面，不依赖页面再次点击');
  assert.equal(card.approvable, true, '制作检查与真实封面通过后允许进入人工确认');
  assert.equal(getBatchWorkspace(db, 'p', batchId).formulaGeneration?.ready, 1);
  assert.equal(getBatchWorkspace(db, 'p', batchId).formulaGeneration?.finished, true, '真实制作与封面都完成才显示制作完成');
  assert.match(card.formula!.message, /制作检查通过/, '已就绪的成片不再显示包装和审片尚未完成');
  const planId = request.outputs[0].planId;
  const view = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
  if (textRoles) {
    assert.deepEqual(view().subtitleCues.map(cue => cue.text), ['好擦洗', '坐得稳'], '花字和备注都不进入配音字幕');
    assert.deepEqual(view().packaging?.pointCues?.map(cue => cue.text), ['加宽坐面'], '自动花字进入实际包装轨道');
    const cue = view().packaging!.pointCues![0];
    assert(cue.startSec > 3.83 && cue.startSec < 3.84 && cue.endSec > 4.83 && cue.endSec < 4.84,
      '花字跟实际展示镜头对时，完整成片只加一次封面偏移');
    const { readFormulaManualAudio } = await import('../lib/live-mixcut/formula/manual-audio-mapping.ts');
    const editor = readFormulaManualAudio(db, 'p', batchId, planId);
    assert.equal(editor.blocks[2].displayText, '加宽坐面', '人工用途入口保留自动花字正文');
    assert(editor.pictures.some(picture => picture.slotId === editor.blocks[2].slotId), '人工入口可找到花字对应镜头');
  }
  if (partialSource) {
    const { readFormulaAudioMapping } = await import('../lib/live-mixcut/formula/audio-mapping-store.ts');
    const mapping = readFormulaAudioMapping(db, 'p', batchId, planId).result;
    assert(mapping?.status === 'mapped');
    assert.deepEqual(mapping.narrations.map(item => item.text), ['坐得稳。']);
    assert.deepEqual(view().subtitleCues.map(cue => cue.text), ['好擦洗', '靠背也舒服', '坐得稳'], '字幕保留完整真实原声及仅剩余配音');
    assert.ok(card.warnings.some(message => message.includes('还说了其他内容')), '未删掉的额外原声必须进入本次审片提醒');
    assert.equal(card.approved, false, '有真实结果不代替用户审片');
  }
  const edit = (command: Parameters<typeof applyBatchOutputClipEdit>[4]) => applyBatchOutputClipEdit(db, 'p', batchId, planId,
    { ...command, expectedEditRevision: view().editRevision, expectedOutputVersionId: view().outputVersionId! });
  const context = view().reviewContext!;
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...context }] }).results[0].status, 'saved');
  edit({ type: 'set_presentation_lock', target: 'cover', locked: true });
  assert.equal(getBatchWorkspace(db, 'p', batchId).cards[0].approved, true, '只锁定满意封面保留已经通过的制作检查和审核');
  const priorTaskCount = getBatchTasksView(db, 'p', batchId).tasks.length;
  edit({ type: 'set_narration_gain', gainDb: -6 });
  assert.equal(getBatchWorkspace(db, 'p', batchId).cards[0].productionReady, false, '实际修改声音后旧制作就绪失效');
  assert.equal(getBatchTasksView(db, 'p', batchId).tasks.length, priorTaskCount + 1, '保存修改时同事务排入新检查，不能等待前端再点生成');
  assert.equal(getBatchWorkspace(db, 'p', batchId).cards[0].status, 'processing', '执行检查排队时页面显示正在处理，而不是含糊的草稿阻塞');
  const currentCard = () => getBatchWorkspace(db, 'p', batchId).cards[0];
  const runChecks = () => runPendingOnce({ db, workerId: 'execution-recovery', log: () => {}, executors: [makeFormulaExecutor(), createBatchRenderExecutor()] });
  await runChecks();
  assert.equal(currentCard().productionReady, true, '保存后的声音通过新检查');
  assert.equal(currentCard().approved, false, '通过重新检查仍需用户重新审片');
  assert.equal(currentCard().approvable, true);

  const managed = await resolveVerifiedProjectAssetMedia(db, 'p', view().clips[0].assetId);
  edit({ type: 'set_narration_gain', gainDb: -9 });
  fs.renameSync(managed.filePath, `${managed.filePath}.missing`);
  try {
    await runChecks();
    const failed = currentCard();
    assert.equal(failed.productionReady, false);
    assert.equal(failed.approvable, false);
    assert.equal(failed.status, 'retryable_failed', '缺失原片的检查失败可见且可重试');
    assert.equal(failed.executionTask?.status, 'failed');
    assert.ok(failed.executionTask?.errorMessage, '页面有具体失败原因');
    assert.ok(failed.blockers.some(message => message.startsWith('制作检查失败：')));
    const progress = getBatchWorkspace(db, 'p', batchId).formulaGeneration!;
    assert.equal(progress.ready, 0);
    assert.equal(progress.needsAttention, 1);
    assert.equal(progress.finished, false, '没有活跃任务不代表制作成功');
    assert.equal(progress.items[0].retryTaskId, failed.executionTask?.id, '失败只重试当前检查，不重抽整个计划');
  } finally {
    fs.renameSync(`${managed.filePath}.missing`, managed.filePath);
  }
  const failedTask = currentCard().executionTask!;
  retryTask(db, 'p', failedTask.id);
  await runChecks();
  assert.equal(currentCard().executionTask?.id, failedTask.id, '恢复同一原片后重试原任务，不重新选片');
  assert.equal(currentCard().executionTask?.attemptCount, 2);
  assert.equal(currentCard().approvable, true);

  edit({ type: 'set_narration_gain', gainDb: -3 });
  const interruptedTask = currentCard().executionTask!.id;
  assert.equal(claimNextTask(db, { workerId: 'previous-process' })?.task.id, interruptedTask);
  assert.equal(currentCard().executionTask?.status, 'running');
  assert.equal(recoverInterruptedWork(db), 1, '重新启动时恢复未完成的检查');
  await runChecks();
  assert.equal(currentCard().executionTask?.id, interruptedTask);
  assert.equal(currentCard().executionTask?.attemptCount, 2);
  assert.equal(currentCard().approvable, true);

  edit({ type: 'set_narration_gain', gainDb: -12 });
  pauseBatch(db, 'p', batchId);
  assert.equal(await runChecks(), 0, '暂停后不继续检查');
  resumeBatch(db, 'p', batchId);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  assert.equal(await runChecks(), 0, '能力关闭时保留待检查任务');
  assert.equal(currentCard().productionReady, false);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  await runChecks();
  assert.equal(currentCard().approvable, true);

  edit({ type: 'set_narration_gain', gainDb: -2 });
  const staleTask = currentCard().executionTask!.id;
  const actualExecutor = makeFormulaExecutor();
  let editedDuringCheck = false;
  await runPendingOnce({ db, workerId: 'late-check', concurrency: 1, log: () => {},
    executors: [{ ...actualExecutor, async execute(context) {
      const result = await actualExecutor.execute(context);
      if (context.claim.task.id === staleTask) {
        edit({ type: 'set_narration_gain', gainDb: -4 });
        editedDuringCheck = true;
        assert.equal(currentCard().productionReady, false);
      }
      return result;
    } }, createBatchRenderExecutor()] });
  assert.equal(editedDuringCheck, true);
  assert.equal(getBatchTasksView(db, 'p', batchId).tasks.find(task => task.id === staleTask)?.status, 'cancelled', '旧检查迟到不能批准刚修改的成片');
  assert.notEqual(currentCard().executionTask?.id, staleTask);
  assert.equal(currentCard().approvable, true, '新声音由新的检查完成后才能继续审片');
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  assert.equal(currentCard().approvable, false, '公式能力关闭后页面不能继续提供确认入口');
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  if (process.argv.includes('--publish')) {
    const { orchestrateBatchExport } = await import('../lib/live-mixcut/export-orchestrator.ts');
    const { resolveBatchOutputMedia } = await import('../lib/live-mixcut/output-media.ts');
    if (packaged) {
      const beforePackaging = view();
      edit({ type: 'set_packaging', expectedEditRevision: beforePackaging.editRevision, expectedOutputVersionId: beforePackaging.outputVersionId!,
        config: { ...beforePackaging.packaging!, enabled: true, template: 'overlay-minimal',
        varsOverrides: { title: '实拍发布验收', subtitle: '原声与配音', point1: '坐得稳', point2: '', point3: '' },
        ...(textRoles ? {} : { pointCuesMode: 'timed', pointCues: [{ id: 'publish-point', text: '坐得稳', startSec: 3.85, endSec: 4.7 }] }) } });
      await runChecks();
      assert.equal(currentCard().approvable, true, '启用包装后重新检查并生成对应封面');
    }
    const approved = setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] });
    assert.equal(approved.results[0].status, 'saved');
    const exporting = () => orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} });
    assert.equal((await exporting()).items[0].status, 'render_queued');
    await runChecks();
    const candidate = resolveBatchOutputMedia(db, 'p', batchId, planId, 'video', 'candidate');
    assert.equal(candidate.productionReady, true, '原声公式渲染候选可按稳定身份播放');
    const published = await exporting();
    assert.equal(published.items[0].status, 'published', JSON.stringify(published));
    assert.equal(currentCard().exportStatus, 'exported');
    assert.equal((await exporting()).items[0].status, 'already_published');
    const originalVideo = resolveBatchOutputMedia(db, 'p', batchId, planId, 'video', 'artifact');
    const originalCover = resolveBatchOutputMedia(db, 'p', batchId, planId, 'cover', 'artifact');
    assert.ok(path.basename(originalVideo.absolutePath).endsWith(`-脚本141-第01份-${packaged ? 'f3' : '无包装'}.mp4`),
      `正式文件名必须保留原脚本号、脚本内份次和实际包装：${path.basename(originalVideo.absolutePath)}`);
    assert.equal(path.basename(originalCover.absolutePath), path.basename(originalVideo.absolutePath, '.mp4') + '-封面.jpg');
    assert.ok(fs.statSync(originalVideo.absolutePath).size > 0, '正式视频可通过下载入口解析');
    assert.ok(fs.statSync(originalCover.absolutePath).size > 0, '配对封面可通过下载入口解析');
    if (packaged) {
      const sharp = (await import('sharp')).default;
      const evidence = path.resolve(textRoles ? 'outputs/formula-text-roles' : 'outputs/formula-publish-packaged');
      fs.mkdirSync(evidence, { recursive: true });
      const videoCover = path.join(root, 'published-video-cover.png');
      await runFfmpeg(['-y', '-i', originalVideo.absolutePath, '-vf', 'select=eq(n\\,10)', '-frames:v', '1', videoCover]);
      const coverPixels = await sharp(originalCover.absolutePath).removeAlpha().raw().toBuffer();
      const videoPixels = await sharp(videoCover).removeAlpha().raw().toBuffer();
      assert.equal(coverPixels.length, videoPixels.length, '封面与正式视频画幅一致');
      const meanDifference = coverPixels.reduce((sum, value, index) => sum + Math.abs(value - videoPixels[index]), 0) / coverPixels.length;
      assert(meanDifference < 12, `封面与正式视频封面中点应呈现同一包装，平均像素差 ${meanDifference}`);
      const statistics = await sharp(originalCover.absolutePath).stats();
      assert(statistics.channels.some(channel => channel.stdev > 10), '正式封面不能仍是无包装的纯色底图');
      fs.copyFileSync(originalVideo.absolutePath, path.join(evidence, 'mixed-packaged.mp4'));
      fs.copyFileSync(originalCover.absolutePath, path.join(evidence, 'mixed-packaged.jpg'));
      fs.copyFileSync(videoCover, path.join(evidence, 'video-cover-frame.png'));
      fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ audioMode, template: 'overlay-minimal', meanDifference }, null, 2));
    }
    edit({ type: 'set_narration_gain', gainDb: -5 });
    assert.equal(currentCard().formalOutdated, true);
    assert.equal((await exporting()).items[0].status, 'skipped', '修改后不能复用原正式产物绕过重检和审核');
    await runChecks();
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'saved');
    assert.equal((await exporting()).items[0].status, 'render_queued');
    await runChecks();
    const interruptedPublish = await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {},
      beforeRegister: () => { edit({ type: 'set_narration_gain', gainDb: -7 }); } });
    assert.equal(interruptedPublish.items[0].status, 'skipped', '复制文件期间修改成片，旧结果不能成为正式版本');
    assert.equal(resolveBatchOutputMedia(db, 'p', batchId, planId, 'video', 'artifact').absolutePath, originalVideo.absolutePath, '旧的正式视频继续可访问');
    await runChecks();
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'saved');
    assert.equal((await exporting()).items[0].status, 'render_queued');
    await runChecks();
    assert.equal((await exporting()).items[0].status, 'published', '重新检查、确认和渲染后可发布当前修改');
    assert.equal(currentCard().formalOutdated, false);
    assert.notEqual(resolveBatchOutputMedia(db, 'p', batchId, planId, 'video', 'artifact').absolutePath, originalVideo.absolutePath);
    assert.ok(path.basename(resolveBatchOutputMedia(db, 'p', batchId, planId, 'video', 'artifact').absolutePath)
      .endsWith(`-脚本141-第01份-${packaged ? 'f3' : '无包装'}-02.mp4`), '返工防重名后缀不改变原号或份次');
    assert.ok(fs.existsSync(originalVideo.absolutePath), '新正式成片追加保存，不覆盖或删除旧文件');
  }
  }
  console.log('formula execution tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
