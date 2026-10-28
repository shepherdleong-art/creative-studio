import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./typescript-extension-loader.mjs', pathToFileURL('./scripts/'));
register('data:text/javascript,export async function resolve(s,c,n){if(s===%27next/server%27)return n(%27next/server.js%27,c);return n(s,c);}', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-batches-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createLiveMixcutProject } = await import('../lib/live-mixcut/projects.ts');
  const { createLiveMixcutBatch } = await import('../lib/live-mixcut/batches.ts');
  const { listProjectBatchProductions, setBatchProductionArchived } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession, readFormulaInputs } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { readFormulaSettings, saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const task = createLiveMixcutProject(db, { storeCode: 'K店', productCode: 'XQ9A', editorName: '张三' }, new Date('2026-10-24T01:02:03.000Z'));
  const video = path.join(root, 'VO1.mp4');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  const assetId = await registerManagedCopy(db, task.id, { sourcePath: video });
  registerFormulaAssetBinding(db, task.id, task.batchId, { assetId, sourcePath: 'VO1_口播.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 15, 'VO1', '待修正的文案']]);
  const imported = await createFormulaImportSession(db, task.id, task.batchId, {
    kind: 'scripts', filename: '脚本.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1,
  });
  confirmFormulaImportSession(db, task.id, task.batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const materialBook = new ExcelJS.Workbook();
  materialBook.addWorksheet('素材').addRows([['逻辑编号', '画面描述'], ['VO1', '客厅口播，手持产品讲解']]);
  const materialImport = await createFormulaImportSession(db, task.id, task.batchId, {
    kind: 'materials', filename: '素材表.xlsx', bytes: Buffer.from(await materialBook.xlsx.writeBuffer()), expectedRevision: 2,
  });
  confirmFormulaImportSession(db, task.id, task.batchId, materialImport.id, { expectedRevision: 2, excludedKeys: [] });
  await saveFormulaSettings(db, task.id, task.batchId, {
    expectedInputRevision: 3, expectedSettingsRevision: 0, scriptsSessionId: imported.id,
    settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } },
  });

  const { readFormulaMaterialNotes, saveFormulaMaterialNote } = await import('../lib/live-mixcut/formula/material-notes.ts');
  const noteView = readFormulaMaterialNotes(db, task.id, task.batchId);
  saveFormulaMaterialNote(db, task.id, task.batchId, noteView.items[0].bindingId, {
    expectedRevision: noteView.revision, expectedProfileId: null,
    content: { description: '人工确认的口播素材', category: '口播', sellingPoints: [], actions: [], speech: 'yes',
      evidence: [{ field: 'description', source: 'material_table', quote: '手持产品讲解' }] },
  });
  const { saveFormulaManualSpeech, readFormulaManualSpeech } = await import('../lib/live-mixcut/formula/manual-speech.ts');
  await saveFormulaManualSpeech(db, task.id, task.batchId, {
    assetId, contentFingerprint: noteView.items[0].source.contentFingerprint, expectedInputRevision: 3, expectedSpeechRevision: 0,
    confirmed: true, mode: 'no_speech', segments: [],
  });
  const currentNote = readFormulaMaterialNotes(db, task.id, task.batchId);
  saveFormulaMaterialNote(db, task.id, task.batchId, currentNote.items[0].bindingId, {
    expectedRevision: currentNote.revision, expectedProfileId: currentNote.items[0].profile!.id,
    content: { description: '最新人工修订，必须复制这一条', category: '口播', sellingPoints: [], actions: [], speech: 'yes',
      evidence: [{ field: 'description', source: 'material_table', quote: '手持产品讲解' }] },
  });
  const { readFormulaExternalNarrations } = await import('../lib/live-mixcut/formula/external-narration.ts');
  const { saveFormulaAssetRanges, readFormulaAssetRanges } = await import('../lib/live-mixcut/formula/asset-ranges.ts');
  await saveFormulaAssetRanges(db, task.id, task.batchId, {
    assetId, contentFingerprint: noteView.items[0].source.contentFingerprint, expectedInputRevision: 4, expectedRangeRevision: 0,
    confirmed: true, ranges: [{ label: '人工保留区间', inUs: 0, outUs: 800_000, protected: null }],
  });
  const copied = createLiveMixcutBatch(db, task.id, { name: '第二组方案', sourceBatchId: task.batchId, copyInputs: true });
  const copiedInputs = readFormulaInputs(db, task.id, copied.id);
  const originalInputs = readFormulaInputs(db, task.id, task.batchId);
  assert.equal(copiedInputs.videoSourceCount, 1);
  assert.deepEqual(copiedInputs.scripts?.rows, originalInputs.scripts?.rows, '复制批次保留已确认脚本内容');
  assert.notEqual(copiedInputs.scripts?.sessionId, originalInputs.scripts?.sessionId, '复制后的脚本表独立修改');
  const copiedSettings = readFormulaSettings(db, task.id, copied.id);
  assert.deepEqual(copiedSettings.saved?.settings, readFormulaSettings(db, task.id, task.batchId).saved?.settings, '复制批次保留份数与生成设置');
  assert.equal(copiedSettings.editable, true);
  const copiedNote = readFormulaMaterialNotes(db, task.id, copied.id).items[0];
  assert.equal(copiedNote.profile?.content.description, '最新人工修订，必须复制这一条', '复制最新素材说明，而非旧 AI 草稿');
  if (copiedNote.stale) console.log('copied material source mismatch', JSON.stringify({ before: noteView.items[0].source, after: copiedNote.source }, null, 2));
  assert.equal(copiedNote.stale, false, '新批次的素材说明必须绑定新身份，不能显示为失效');
  assert.equal(copiedNote.profile?.content.evidence[0]?.quote, '手持产品讲解', '保留素材表原文依据');
  assert.equal(copiedNote.source.table?.fields['画面描述'], '客厅口播，手持产品讲解', '保留原表内容供继续编辑和核验');
  assert.equal(readFormulaManualSpeech(db, task.id, copied.id).items[0].saved?.mode, 'no_speech', '复制当前人工原声核对');
  const copiedRanges = readFormulaAssetRanges(db, task.id, copied.id).items[0].saved;
  const originalRanges = readFormulaAssetRanges(db, task.id, task.batchId).items[0].saved;
  assert.equal(copiedRanges?.ranges[0].label, '人工保留区间', '复制人工确认的可用区间');
  assert.notEqual(copiedRanges?.ranges[0].id, originalRanges?.ranges[0].id, '新区间不引用旧批次记录');
  await saveFormulaSettings(db, task.id, copied.id, {
    expectedInputRevision: copiedInputs.revision, expectedSettingsRevision: copiedSettings.saved!.revision,
    scriptsSessionId: copiedInputs.scripts!.sessionId,
    settings: { selections: [{ key: '1:2', copies: 3 }], bgm: { mode: 'none', trackIds: [] } },
  });
  assert.equal(readFormulaSettings(db, task.id, task.batchId).saved?.settings.selections[0].copies, 1, '修改新批次不改变原批次');
  assert.equal(listProjectBatchProductions(db, task.id).length, 2);
  setBatchProductionArchived(db, task.id, copied.id, true);
  assert.deepEqual(listProjectBatchProductions(db, task.id).map(batch => batch.id), [task.batchId]);
  assert.equal(listProjectBatchProductions(db, task.id, { includeArchived: true }).length, 2);
  setBatchProductionArchived(db, task.id, copied.id, false);
  assert.equal(listProjectBatchProductions(db, task.id).length, 2);

  const narrationRow = db.prepare('SELECT contentJson FROM live_mixcut_formula_external_narrations WHERE collectionId=(SELECT id FROM live_mixcut_formula_collections WHERE batchId=?)')
    .get(copied.id) as { contentJson: string } | undefined;
  if (narrationRow) {
    const saved = readFormulaExternalNarrations(db, task.id, copied.id).items[0].saved;
    const audio = JSON.parse(narrationRow.contentJson) as { audio?: { externalNarrationId?: string } };
    assert.equal(audio.audio?.externalNarrationId, saved?.id, '外部配音音频身份必须属于复制后的批次');
  }
  const empty = createLiveMixcutBatch(db, task.id, { name: '空白方案', copyInputs: false });
  assert.equal(readFormulaInputs(db, task.id, empty.id).videoSourceCount, 0);
  assert.equal(readFormulaSettings(db, task.id, empty.id).saved, null);
  assert.throws(() => createLiveMixcutBatch(db, 'other-task', { sourceBatchId: task.batchId }), /不存在/);

  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { reserveBatchExportTarget, releaseBatchExportReservation } = await import('../lib/live-mixcut/batch-export.ts');
  const { writeFormulaExportFolderManifest } = await import('../lib/live-mixcut/formula/export-manifest.ts');
  assert.equal(getBatchWorkspace(db, task.id, task.batchId).exportDirName, task.exportDirName, '首批使用任务目录');
  assert.equal(getBatchWorkspace(db, task.id, copied.id).exportDirName, task.exportDirName, '一个任务只有一个成片文件夹，不再按批次分目录');
  // 清单写在任务级「成片」里；再写一次仍只更新这一份，不产生批次子目录。
  writeFormulaExportFolderManifest(db, task.id);
  writeFormulaExportFolderManifest(db, task.id);
  const manifestPath = path.join(root, 'storage', 'live-mixcut', 'exports', task.exportDirName, '成片', '清单.csv');
  assert.ok(fs.existsSync(manifestPath), '清单在任务级成片文件夹里');
  assert.ok(fs.readFileSync(manifestPath, 'utf8').startsWith('﻿"原脚本号",'));
  assert.equal(fs.readdirSync(path.join(root, 'storage', 'live-mixcut', 'exports', task.exportDirName))
    .some(name => name.startsWith('批次-')), false, '不再生成批次子目录');
  const target = reserveBatchExportTarget({
    projectId: task.id, batchId: copied.id, storageRoot: path.join(root, 'storage'),
    exportDirName: task.exportDirName,
    productCode: task.productName, planSeq: 1, outputVersion: 1,
  });
  assert.equal(path.dirname(target.videoAbsolutePath), path.join(root, 'storage', 'live-mixcut', 'exports', task.exportDirName, '成片'));
  assert.equal(path.dirname(path.dirname(target.videoAbsolutePath)),
    path.join(root, 'storage', 'live-mixcut', 'exports', task.exportDirName), '成片直接挂在任务导出目录下');
  releaseBatchExportReservation(path.join(root, 'storage'), target);

  // REST 契约与真实本地数据库使用同一个临时数据根，不走界面内存或伪造响应。
  const { getDb, closeDb } = await import('../lib/db.ts');
  const routeDb = getDb();
  assert.equal((await checkBatchProductionReadiness({ db: routeDb, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const routeTask = createLiveMixcutProject(routeDb, { storeCode: 'K店', productCode: 'XQ9A', editorName: '张三' }, new Date('2026-10-24T01:02:03.000Z'));
  const { GET, POST } = await import('../app/api/live-mixcut/batches/route.ts');
  const archiveRoute = await import('../app/api/live-mixcut/batches/[id]/archive/route.ts');
  const { NextRequest } = await import('next/server.js');
  const request = (method: string, url: string, body?: unknown) => new NextRequest(url, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  const listed = await GET(request('GET', `http://localhost/api/live-mixcut/batches?projectId=${routeTask.id}&includeArchived=1`));
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as { batches: unknown[] }).batches.length, 1);
  const created = await POST(request('POST', 'http://localhost/api/live-mixcut/batches', {
    projectId: routeTask.id, name: '接口复制批次', sourceBatchId: routeTask.batchId,
  }));
  const createdBody = await created.json() as { batch: { id: string; name: string }; message?: string };
  assert.equal(created.status, 201, createdBody.message);
  assert.equal(createdBody.batch.name, '接口复制批次');
  const archived = await archiveRoute.POST(request('POST', `http://localhost/api/live-mixcut/batches/${createdBody.batch.id}/archive?projectId=${routeTask.id}`, { archived: true }),
    { params: Promise.resolve({ id: createdBody.batch.id }) });
  assert.equal(archived.status, 200);
  const restored = await archiveRoute.POST(request('POST', `http://localhost/api/live-mixcut/batches/${createdBody.batch.id}/archive?projectId=${routeTask.id}`, { archived: false }),
    { params: Promise.resolve({ id: createdBody.batch.id }) });
  assert.equal(restored.status, 200);
  const rejected = await POST(request('POST', 'http://localhost/api/live-mixcut/batches', {
    projectId: 'not-this-task', sourceBatchId: task.batchId,
  }));
  assert.equal(rejected.status, 404, '不能跨任务复制');
  closeDb();
  console.log('live mixcut batches: copy, independent settings, blank batch, archive, shared export folder and task manifest passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
