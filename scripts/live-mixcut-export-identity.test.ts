import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: import/generate → real workers/review/publish → formal download paths.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-export-identity-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const originalFetch = globalThis.fetch;
const db = new Database(path.join(root, 'test.db'));
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
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchTasksView } = await import('../lib/live-mixcut/tasks.ts');
  const { retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { setBatchPlanReviews } = await import('../lib/live-mixcut/review.ts');
  const { orchestrateBatchExport } = await import('../lib/live-mixcut/export-orchestrator.ts');
  const { resolveBatchOutputMedia } = await import('../lib/live-mixcut/output-media.ts');
  const { reserveBatchExportTarget, releaseBatchExportReservation } = await import('../lib/live-mixcut/batch-export.ts');
  const { writeFormulaExportFolderManifest } = await import('../lib/live-mixcut/formula/export-manifest.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'PS866',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','原脚本号验收');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '乱序导出', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_口播.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 1, 'VO1', '好擦洗。'], [141, '抖音', 1, 1, 'VO1', '好擦洗。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '两条.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'original', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }],
      bgm: { mode: 'none', trackIds: [] }, production } });
  const generation = { requestKey: 'identity', settingsId: settings.saved!.id, expectedInputRevision: 2 };
  const request = await createFormulaGenerationRequest(db, 'p', batchId, generation);
  globalThis.fetch = async () => Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.125, end: 0.875 }] });
  const renderer = createBatchRenderExecutor();
  let metadataMode: 'normal' | 'wrong' | 'legacy' = 'normal';
  const work = () => runPendingOnce({ db, workerId: 'identity', log: entry => { if (entry.level === 'error') console.error(entry.message); },
    executors: [createFormulaStageExecutor(), { ...renderer, async execute(context) {
      const result = await renderer.execute(context);
      if (context.claim.task.targetKind !== 'output_version' || metadataMode === 'normal') return result;
      // 真实渲染后，仅模拟交给发布边界的损坏身份或旧版本缺字段；媒体和审核都不伪造。
      const resultJson = { ...(result.resultJson as Record<string, unknown>) };
      if (metadataMode === 'legacy') delete resultJson.formulaIdentity;
      else resultJson.formulaIdentity = { ...(resultJson.formulaIdentity as object), copyIndex: 99 };
      return { ...result, resultJson };
    } }] });
  await work();
  assert.equal(getBatchWorkspace(db, 'p', batchId).formulaGeneration?.ready, 3);
  // 先导出 141，再导出脚本 12 的第二份，最后才导出第一份。
  const outputs = [request.outputs[2], request.outputs[1], request.outputs[0]];
  const expected = ['-脚本141-第01份-无包装.mp4', '-脚本12-第02份-无包装.mp4', '-脚本12-第01份-无包装.mp4'];
  const identities = [{ version: 1, scriptNumber: '141', copyIndex: 1, packagingCode: 'none' },
    { version: 1, scriptNumber: '12', copyIndex: 2, packagingCode: 'none' }, { version: 1, scriptNumber: '12', copyIndex: 1, packagingCode: 'none' }];
  for (const [index, output] of outputs.entries()) {
    const view = getBatchOutputArrangementView(db, 'p', batchId, output.planId);
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId: output.planId, ...view.reviewContext! }] }).results[0].status, 'saved');
    const exportOne = () => orchestrateBatchExport(db, 'p', batchId, [output.planId], { wakeScheduler: () => {} });
    assert.equal((await exportOne()).items[0].status, 'render_queued');
    metadataMode = index === 0 ? 'wrong' : index === 2 ? 'legacy' : 'normal';
    await work();
    const renderTask = () => getBatchTasksView(db, 'p', batchId).tasks.find(task => task.targetKind === 'output_version'
      && task.targetId === view.outputVersionId && task.status === 'succeeded')!;
    if (index === 0) {
      const rejected = (await exportOne()).items[0];
      assert.equal(rejected.status, 'skipped');
      assert.match(rejected.reason!, /原脚本号、份次或包装/);
      retryTask(db, 'p', renderTask().id);
      metadataMode = 'normal';
      await work();
    }
    const rendered = renderTask().attempts.at(-1)?.resultJson as
        { formulaIdentity?: unknown } | undefined;
    assert.deepEqual(rendered?.formulaIdentity, index === 2 ? undefined : identities[index],
      index === 2 ? '旧候选缺字段，但已有真实渲染和制作证明' : '原号、份次和包装随实际渲染结果保存');
    assert.equal((await exportOne()).items[0].status, 'published');
    const video = resolveBatchOutputMedia(db, 'p', batchId, output.planId, 'video', 'artifact');
    const cover = resolveBatchOutputMedia(db, 'p', batchId, output.planId, 'cover', 'artifact');
    assert.ok(path.basename(video.absolutePath).endsWith(expected[index]), path.basename(video.absolutePath));
    assert.equal(path.basename(cover.absolutePath), path.basename(video.absolutePath, '.mp4') + '-封面.jpg');
    assert.equal((await exportOne()).items[0].status, 'already_published');
  }
  assert.deepEqual((await createFormulaGenerationRequest(db, 'p', batchId, generation)).outputs, request.outputs,
    '重新打开或重试生成请求，原脚本号和份次保持不变');
  // 同一条再导出：新版本 -v2，上一版视频和封面挪进「成片」旁边的「旧版」。
  const exportRoot = path.join(root, 'storage', 'live-mixcut', 'exports', '测试任务-p');
  assert.equal(fs.existsSync(path.join(exportRoot, '旧版')), false, '首次导出还不需要旧版文件夹');
  const reexportOutput = outputs[1];
  const beforeArchive = resolveBatchOutputMedia(db, 'p', batchId, reexportOutput.planId, 'video', 'artifact');
  const arrange = () => getBatchOutputArrangementView(db, 'p', batchId, reexportOutput.planId);
  applyBatchOutputClipEdit(db, 'p', batchId, reexportOutput.planId, {
    type: 'set_narration_gain', gainDb: -4,
    expectedEditRevision: arrange().editRevision, expectedOutputVersionId: arrange().outputVersionId!,
  });
  await work();
  const reexportReview = arrange().reviewContext!;
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved',
    items: [{ planId: reexportOutput.planId, ...reexportReview }] }).results[0].status, 'saved');
  const exportReexport = () => orchestrateBatchExport(db, 'p', batchId, [reexportOutput.planId], { wakeScheduler: () => {} });
  assert.equal((await exportReexport()).items[0].status, 'render_queued', '修改后要重新渲染');
  await work();
  assert.equal((await exportReexport()).items[0].status, 'published');
  const exportedVideo = resolveBatchOutputMedia(db, 'p', batchId, reexportOutput.planId, 'video', 'artifact');
  const exportedCover = resolveBatchOutputMedia(db, 'p', batchId, reexportOutput.planId, 'cover', 'artifact');
  assert.equal(path.basename(exportedVideo.absolutePath), '测试产品-脚本12-第02份-无包装-v2.mp4', '同一条再导出排 -v2');
  assert.equal(path.basename(exportedCover.absolutePath), '测试产品-脚本12-第02份-无包装-v2-封面.jpg');
  const archivedVideo = path.join(exportRoot, '旧版', '测试产品-脚本12-第02份-无包装.mp4');
  const archivedCover = path.join(exportRoot, '旧版', '测试产品-脚本12-第02份-无包装-封面.jpg');
  assert.ok(fs.existsSync(archivedVideo), '上一版视频挪进「成片」旁边的「旧版」');
  assert.ok(fs.existsSync(archivedCover), '上一版封面一起挪走');
  assert.equal(fs.existsSync(beforeArchive.absolutePath), false, '「成片」只留当前这一套');
  assert.equal(path.dirname(archivedVideo), path.join(exportRoot, '旧版'), '「旧版」在「成片」旁边，不在里面');
  // 清单只列当前这一套：v2 在列，挪走的 v1 不在列。
  writeFormulaExportFolderManifest(db, 'p');
  const manifestCsv = fs.readFileSync(path.join(exportRoot, '成片', '清单.csv'), 'utf8');
  assert.ok(manifestCsv.includes('测试产品-脚本12-第02份-无包装-v2.mp4'), '清单列出当前版本');
  assert.equal(manifestCsv.includes('"测试产品-脚本12-第02份-无包装.mp4"'), false, '清单不列已挪进旧版的上一版');
  assert.equal(manifestCsv.includes('旧版'), false, '清单只描述成片里的文件');
  assert.equal(manifestCsv.trimEnd().split('\r\n').length, 4, '清单是表头加三条成片，不重复列旧版本');
  // 公共预留接口：防重名后缀与脚本内份次独立；旧 J/K 字段不能替代公式身份。
  const naming = { projectId: 'p', batchId, storageRoot: path.join(root, 'storage'), exportDirName: '命名边界', baseName: '产品',
    productCode: 'PS866', planSeq: 99, outputVersion: 1, productionCodes: { scriptCode: 'J99', openingCode: 'VO1', packagingCode: 'f1' },
    formulaIdentity: { version: 1 as const, scriptNumber: '12', copyIndex: 2, packagingCode: 'none' as const } };
  const first = reserveBatchExportTarget(naming), second = reserveBatchExportTarget(naming);
  // 不同批次的同一条：身份相同就接着排版本号，批次不参与命名。
  const third = reserveBatchExportTarget({ ...naming, batchId: 'another-batch' });
  assert.equal(first.videoFilename, '产品-脚本12-第02份-无包装.mp4');
  assert.equal(second.videoFilename, '产品-脚本12-第02份-无包装-v2.mp4', '同一条再导出排 -v2，不再用 -02');
  assert.equal(third.videoFilename, '产品-脚本12-第02份-无包装-v3.mp4', '不同批次的同一条接着排 -v3');
  releaseBatchExportReservation(naming.storageRoot, first);
  releaseBatchExportReservation(naming.storageRoot, second);
  releaseBatchExportReservation(naming.storageRoot, third);
  for (const identity of [{ ...naming.formulaIdentity, scriptNumber: '../12' }, { ...naming.formulaIdentity, copyIndex: 0 },
    { ...naming.formulaIdentity, packagingCode: 'f5' }]) {
    assert.throws(() => reserveBatchExportTarget({ ...naming, formulaIdentity: identity as typeof naming.formulaIdentity }), /原脚本号|份次|包装/);
  }
  console.log('formula export identity: 原脚本 12/141、多份乱序真实发布、错误身份拒绝与重试、旧候选、-v2 归档与任务清单、跨批次版本号及非法字段通过');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
