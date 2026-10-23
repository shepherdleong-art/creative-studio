import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: import/generate → real workers/review/publish → formal download paths.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-export-package-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const originalFetch = globalThis.fetch;
const db = new Database(path.join(root, 'test.db'));
const hintsMode = process.argv.includes('--replacement-hints');
const manualDeviations = process.argv.includes('--manual-deviations');
assert(!(hintsMode && manualDeviations));
try {
  const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
  const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/batch-production/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
  const { getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
  const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
  const { orchestrateBatchExport } = await import('../lib/batch-production/export-orchestrator.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'PS866',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','原脚本号验收');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const formulaReady = await checkFormulaReadiness(options);
  assert.equal(formulaReady.available, true, JSON.stringify(formulaReady));
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '乱序导出', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_口播.mp4' });
  const addedAssets: string[] = [];
  if (manualDeviations) for (const [index, color] of ['red', 'blue'].entries()) {
    const file = path.join(root, `G${index + 1}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    const id = await registerManagedCopy(db, 'p', { sourcePath: file }); addedAssets.push(id);
    registerFormulaAssetBinding(db, 'p', batchId, { assetId: id, sourcePath: `G${index + 1}_展示.mp4` });
  }
  let hintsId: string | undefined;
  const originalCode = hintsMode ? 'VO49' : 'VO1';
  if (hintsMode) {
    const materials = new ExcelJS.Workbook();
    materials.addWorksheet('素材').addRows([['逻辑编号', '画面描述', '台词', '场景'], ['VO49', '口播清洁体验', '好擦洗。', '绿幕'], ['VO1', '口播清洁体验', '好擦洗。', '沙发旁']]);
    const materialsImport = await createFormulaImportSession(db, 'p', batchId, { kind: 'materials', filename: '素材.xlsx',
      bytes: Buffer.from(await materials.xlsx.writeBuffer()), expectedRevision: 1 });
    confirmFormulaImportSession(db, 'p', batchId, materialsImport.id, { expectedRevision: 1, excludedKeys: [] });
    const { saveFormulaReplacementHints } = await import('../lib/batch-production/formula/replacement-hints-store.ts');
    hintsId = saveFormulaReplacementHints(db, 'p', batchId, { expectedInputRevision: 2, filename: 'substitutions.json',
      bytes: Buffer.from('{"VO49":{"sub":"VO1","line":"好擦洗。","group":"绿幕"}}') }).acceptedId;
  }
  const baseRevision = hintsMode || manualDeviations ? 3 : 1;
  const originalFormula = manualDeviations ? 'VO1 G1 G2' : originalCode;
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', manualDeviations ? 3 : 1, manualDeviations ? 5 : 1, originalFormula, '好擦洗。'],
    [141, '抖音', manualDeviations ? 3 : 1, manualDeviations ? 5 : 1, originalFormula, '好擦洗。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '两条.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: baseRevision });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: baseRevision, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'original', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: baseRevision + 1, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }],
      bgm: { mode: 'none', trackIds: [] }, production } });
  const generation = { requestKey: 'identity', settingsId: settings.saved!.id, expectedInputRevision: baseRevision + 1 };
  const request = await createFormulaGenerationRequest(db, 'p', batchId, generation);
  globalThis.fetch = async () => Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.125, end: 0.875 }] });
  const { createFormulaExportPackage, getFormulaExportPackage, FormulaPackageError } = await import('../lib/batch-production/formula/export-package.ts');
  const renderer = createBatchRenderExecutor();
  const work = () => runPendingOnce({ db, workerId: 'package', executors: [createFormulaStageExecutor(hintsMode ? async () => ({
    id: 'fixture', name: '外部模型固定响应', model: 'fixture', async complete() { return { matches: [{ logicalCode: 'VO1', basis: 'speech', preservesIntent: true,
      reason: '当前素材表中的完整台词相同', evidence: [{ originalField: '台词', originalQuote: '好擦洗。', replacementField: '台词', replacementQuote: '好擦洗。' }],
      differences: ['绿幕变为沙发旁'] }] }; },
  }) : undefined), renderer] });
  await work();
  if (manualDeviations) {
    const { applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
    const planId = request.outputs[0].planId;
    const view = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
    const edit = (change: Parameters<typeof applyBatchOutputClipEdit>[4]) => applyBatchOutputClipEdit(db, 'p', batchId, planId,
      { ...change, expectedEditRevision: view().editRevision, expectedOutputVersionId: view().outputVersionId! });
    const original = view();
    const restore = () => edit({ type: 'restore_arrangement', snapshot: { ...original,
      musicTrackId: original.music.trackId, musicGainDb: original.music.gainDb, musicFadeInSec: original.music.fadeInSec,
      musicFadeOutSec: original.music.fadeOutSec, narrationGainDb: original.narration.gainDb } });
    edit({ type: 'split', clipId: original.clips[1].clipId, offsetUs: 500_000 });
    assert(!view().reviewContext?.issues.some(issue => /人工换序|人工删除|人工插入|人工换片|人工裁切/.test(issue.message)), '连续分割不冒充偏离公式');
    edit({ type: 'delete', clipId: view().clips.find(clip => clip.segmentId === original.clips[1].segmentId && clip.clipId !== original.clips[1].clipId)!.clipId });
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工裁切') && issue.message.includes('G1')), '分割后仅删一部分也要显示取用区间的变化');
    restore();
    edit({ type: 'replace', clipId: original.clips[1].clipId, assetId: addedAssets[1] });
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工换片') && issue.details?.some(detail => detail.includes('G2'))), '审片必须看到人工换片及实际编号');
    restore();
    edit({ type: 'move_clip', clipId: original.clips[2].clipId, startUs: original.clips[1].timelineStartUs - 50_000 });
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工换序')), '人工换序不能继续显示为原公式顺序');
    restore();
    edit({ type: 'delete', clipId: original.clips[1].clipId });
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工删除') && issue.message.includes('G1')));
    edit({ type: 'insert', afterClipId: original.clips[0].clipId, assetId: addedAssets[1],
      durationUs: original.clips[1].timelineEndUs - original.clips[1].timelineStartUs });
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工插入')), '人工插入的画面必须标记人工来源');
    await work();
    const checked = getBatchWorkspace(db, 'p', batchId).cards[0];
    assert.equal(checked.approvable, false, '插入缺少重新核验时不能靠人工确认跳过');
    assert(checked.blockers.some(message => message.includes('人工插入或换片尚未完成')));
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'not_ready');
    restore();
    edit({ type: 'delete', clipId: original.clips[1].clipId });
    edit({ type: 'move_clip', clipId: original.clips[0].clipId, startUs: original.clips[2].timelineEndUs });
    edit({ type: 'move_clip', clipId: original.clips[0].clipId, startUs: view().clips[0].timelineEndUs });
    await work();
    const ready = getBatchWorkspace(db, 'p', batchId).cards[0];
    assert.equal(ready.approvable, true, JSON.stringify({ blockers: ready.blockers, executionTask: ready.executionTask }));
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工换序')));
    assert(view().reviewContext?.issues.some(issue => issue.message.includes('人工删除')));
    assert(!getBatchOutputArrangementView(db, 'p', batchId, request.outputs[1].planId).reviewContext?.issues.some(issue => issue.message.includes('人工')), '不串改兄弟成片的提醒');
  }
  for (const output of request.outputs) {
    const view = getBatchOutputArrangementView(db, 'p', batchId, output.planId);
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId: output.planId, ...view.reviewContext! }] }).results[0].status, 'saved');
  }
  const planIds = request.outputs.map(output => output.planId);
  await orchestrateBatchExport(db, 'p', batchId, planIds, { wakeScheduler: () => {} });
  await work();
  assert.ok((await orchestrateBatchExport(db, 'p', batchId, planIds, { wakeScheduler: () => {} })).items.every(item => item.status === 'published'));
  const selected = getBatchWorkspace(db, 'p', batchId).cards.map(card => ({ planId: card.planId,
    videoArtifactId: card.currentFormalArtifact!.video.id, coverArtifactId: card.currentFormalArtifact!.cover!.id }));
  const input = { requestKey: 'first-package', items: selected };
  const saved = await createFormulaExportPackage(db, 'p', batchId, input);
  assert.equal(saved.manifest.items.length, 3);
  assert.deepEqual(saved.manifest.items.map(item => [item.scriptNumber, item.copyIndex]), [['12', 1], ['12', 2], ['141', 1]]);
  assert.equal(saved.manifest.items[0].originalFormula, originalFormula);
  assert.equal(saved.manifest.items[0].clips[0].originalCode, manualDeviations ? 'G2' : originalCode);
  if (manualDeviations) {
    const item = saved.manifest.items[0];
    assert.deepEqual(item.deviations.deletedSlots, [{ slotId: request.outputs[0].slots[1].slotId, originalCode: 'G1' }]);
    assert.equal(item.deviations.reordered, true);
    assert.deepEqual(item.deviations.actualOrder, [request.outputs[0].slots[2].slotId, request.outputs[0].slots[0].slotId]);
    assert.deepEqual(item.deviations.insertedClips, [], '已撤销的人工插入不能留在正式清单');
    assert.deepEqual(item.deviations.replacedClips, [], '已撤销的人工换片不能留在正式清单');
    assert.deepEqual(item.clips[0].actualCodes, ['G2']);
    fs.mkdirSync(path.resolve('outputs/formula-manual-deviations'), { recursive: true });
    fs.writeFileSync(path.resolve('outputs/formula-manual-deviations/manifest.json'), JSON.stringify(saved.manifest, null, 2));
  }
  if (hintsMode) {
    assert.equal(saved.manifest.items[0].clips[0].replacement?.importedSuggestion?.sourceId, hintsId);
    assert.equal(saved.manifest.items[0].clips[0].replacement?.importedSuggestion?.filename, 'substitutions.json');
    fs.mkdirSync(path.resolve('outputs/formula-replacement-hints'), { recursive: true });
    fs.writeFileSync(path.resolve('outputs/formula-replacement-hints/manifest.json'), JSON.stringify(saved.manifest, null, 2));
  }
  assert.equal(saved.manifest.items[0].clips.find(clip => clip.originalCode === originalCode)?.assetId, assetId);
  assert.equal(saved.manifest.items[0].audio.clips[0].kind, 'source');
  assert.equal(saved.manifest.items[0].packaging.code, 'none');
  assert.deepEqual(getFormulaExportPackage(db, 'p', batchId, saved.id), saved);
  assert.equal((await createFormulaExportPackage(db, 'p', batchId, input)).id, saved.id, '同一次创建重试拿回同一个包');
  assert.ok(!JSON.stringify(saved.manifest).includes(root), '清单不包含本机绝对路径');
  assert.ok(!JSON.stringify(saved.manifest).includes('alignment.example'), '不序列化供应商配置');
  const { listFormulaExportPackages } = await import('../lib/batch-production/formula/export-package.ts');
  const concurrent = await Promise.all([1, 2].map(() => createFormulaExportPackage(db, 'p', batchId, { ...input, requestKey: 'concurrent' })));
  assert.equal(concurrent[0].id, concurrent[1].id, '并发重试只能创建一个包');
  assert.equal(listFormulaExportPackages(db, 'p', batchId).length, 2);
  await assert.rejects(createFormulaExportPackage(db, 'p', batchId, { ...input, items: selected.slice(1) }), /另一份选择/);
  const { downloadFormulaExportPackage } = await import('../lib/batch-production/formula/export-package-download.ts');
  const { default: JSZip } = await import('jszip');
  const { createHash } = await import('node:crypto');
  const download = async () => {
    const response = await downloadFormulaExportPackage(db, 'p', batchId, saved.id);
    return JSZip.loadAsync(await new Response(response.stream).arrayBuffer());
  };
  const zip = await download();
  assert.deepEqual(JSON.parse(await zip.file('清单.json')!.async('string')), saved.manifest);
  const csv = await zip.file('清单.csv')!.async('string');
  assert.match(csv, /原脚本号/);
  for (const item of saved.manifest.items) for (const file of [item.video, item.coverFile]) {
    const bytes = await zip.file(file.filename)!.async('nodebuffer');
    assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), file.checksum);
    assert.ok(csv.includes(file.filename));
  }
  const { applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
  const current = getBatchOutputArrangementView(db, 'p', batchId, planIds[0]);
  applyBatchOutputClipEdit(db, 'p', batchId, planIds[0], { type: 'set_subtitle_cue_text', cueId: current.subtitleCues[0].id, text: '返工的新字幕',
    expectedEditRevision: current.editRevision, expectedOutputVersionId: current.outputVersionId! });
  await assert.rejects(createFormulaExportPackage(db, 'p', batchId, { ...input, requestKey: 'outdated' }),
    error => error instanceof FormulaPackageError && error.items.some(item => item.planId === planIds[0]), '当前返工未发布不能静默跳过');
  assert.equal(listFormulaExportPackages(db, 'p', batchId).length, 2, '失败不能留下半个包');
  assert.deepEqual(getFormulaExportPackage(db, 'p', batchId, saved.id), saved, '返工不能改旧包清单');
  await work();
  const revised = getBatchOutputArrangementView(db, 'p', batchId, planIds[0]);
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId: planIds[0], ...revised.reviewContext! }] }).results[0].status, 'saved');
  await orchestrateBatchExport(db, 'p', batchId, [planIds[0]], { wakeScheduler: () => {} });
  await work();
  assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planIds[0]], { wakeScheduler: () => {} })).items[0].status, 'published');
  const newFormal = getBatchWorkspace(db, 'p', batchId).cards[0].currentFormalArtifact!;
  const newPackage = await createFormulaExportPackage(db, 'p', batchId, { requestKey: 'after-rework', items: [{ planId: planIds[0],
    videoArtifactId: newFormal.video.id, coverArtifactId: newFormal.cover!.id }] });
  assert.equal(newPackage.manifest.items[0].subtitles[0].text, '返工的新字幕');
  assert.notEqual(newPackage.manifest.items[0].video.checksum, saved.manifest.items[0].video.checksum);
  assert.deepEqual(getFormulaExportPackage(db, 'p', batchId, saved.id), saved, '新正式发布也不能改旧包');
  // Storage fault injection: historical package references must prevent removing its now non-current artifact.
  assert.throws(() => db.prepare('DELETE FROM batch_artifacts WHERE id=?').run(saved.manifest.items[0].video.artifactId), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE batch_formula_export_packages SET manifestJson='{}' WHERE id=?").run(saved.id), /immutable/);
  process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '0';
  const oldZip = await download();
  assert.equal(await oldZip.file('清单.json')!.async('string'), await zip.file('清单.json')!.async('string'), '功能关闭仍能下载旧快照');
  for (const file of [saved.manifest.items[0].video, saved.manifest.items[0].coverFile]) {
    assert.deepEqual(await oldZip.file(file.filename)!.async('nodebuffer'), await zip.file(file.filename)!.async('nodebuffer'));
  }
  assert.throws(() => getFormulaExportPackage(db, 'another-project', batchId, saved.id), /不存在/);
  const formal = getBatchWorkspace(db, 'p', batchId).cards[1].currentFormalArtifact!.video;
  const formalPath = path.join(root, 'storage', formal.relativePath), originalBytes = fs.readFileSync(formalPath);
  fs.writeFileSync(formalPath, '文件被改过');
  await assert.rejects(download(), error => error instanceof FormulaPackageError && error.items.some(item => item.message.includes('视频')));
  fs.writeFileSync(formalPath, originalBytes);
  assert.ok((await download()).file('清单.json'), '恢复原文件后可重新下载同一个包');
  process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
  const { beginFormulaInputRevision } = await import('../lib/batch-production/formula/input-revision.ts');
  beginFormulaInputRevision(db, 'p', batchId, { expectedBatchVersionId: request.batchVersionId, expectedInputRevision: baseRevision + 1 });
  let nextRevision = baseRevision + 2;
  if (hintsMode) {
    const { saveFormulaReplacementHints } = await import('../lib/batch-production/formula/replacement-hints-store.ts');
    saveFormulaReplacementHints(db, 'p', batchId, { expectedInputRevision: nextRevision, clear: true }); nextRevision++;
  }
  const nextSettings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: nextRevision, expectedSettingsRevision: 1,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:3', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const nextGeneration = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'new-input',
    settingsId: nextSettings.saved!.id, expectedInputRevision: nextRevision });
  assert.notEqual(nextGeneration.batchVersionId, request.batchVersionId);
  await work();
  const nextWorkspace = getBatchWorkspace(db, 'p', batchId);
  assert.equal(nextWorkspace.cards.length, 1);
  assert.equal(nextWorkspace.formulaGeneration?.ready, 1);
  assert.equal(listFormulaExportPackages(db, 'p', batchId).length, 3, '换一轮输入仍保留全部历史包');
  const afterRegeneration = await download();
  assert.deepEqual(JSON.parse(await afterRegeneration.file('清单.json')!.async('string')), saved.manifest);
  for (const item of saved.manifest.items) for (const file of [item.video, item.coverFile]) {
    assert.deepEqual(await afterRegeneration.file(file.filename)!.async('nodebuffer'), await zip.file(file.filename)!.async('nodebuffer'),
      '新一轮成功后旧包仍下载原版本的完整内容');
  }
  console.log('formula export package: 真实发布、并发同包、清单与 ZIP 字节一致、返工和新一轮生成保留旧包、损坏拒绝及历史引用保护通过');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  (await import('../lib/db.ts')).closeDb();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
