import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-materials-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const db = new Database(path.join(root, 'workbench.db'));
try {
  // dataRoot 在首次导入时固定，必须先设置临时根，再加载任何业务模块。
  const { dataRoot } = await import('../lib/data-root.ts');
  assert.equal(dataRoot(), root);
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy, computeFileSha256, listAssetSources, resolveSourceFilePath, verifyAssetSources } = await import('../lib/live-mixcut/media-catalog.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { registerFormulaAssetBinding, getFormulaMaterialIndex, mapFormulaAssetBinding, refreshFormulaMaterialIndex } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { readFormulaMaterialNotes, saveFormulaMaterialNote, organizeFormulaMaterialNotes } = await import('../lib/live-mixcut/formula/material-notes.ts');
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','其他');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  const baseReadiness = await checkBatchProductionReadiness(options);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal(baseReadiness.available, true, JSON.stringify(baseReadiness));
  const formulaReadiness = await checkBatchProductionReadiness(options);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal(formulaReadiness.available, true, JSON.stringify(formulaReadiness));
  const batch = createBatchProduction(db, 'p', '实拍', undefined, { planningMode: 'formula' });
  const otherBatch = createBatchProduction(db, 'p', '另一个集合', undefined, { planningMode: 'formula' });
  const source = path.join(root, 'original.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
  const beforeHash = await computeFileSha256(source);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source, displayName: 'G1_正面.mp4' });
  const binding = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/G1_正面.mp4' });
  assert.equal(binding.logicalCode, 'G1');
  assert.equal(registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/G1_正面.mp4' }).id, binding.id);
  const sameAsset = await registerManagedCopy(db, 'p', { sourcePath: source, displayName: 'G10_别名.mp4' });
  assert.equal(sameAsset, assetId);
  registerFormulaAssetBinding(db, 'p', batch, { assetId: sameAsset, sourcePath: '素材/G10_别名.mp4' });
  registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/GB9.preview.mp4' });
  const unmapped = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/定格布置.mp4' });
  assert.equal(unmapped.logicalCode, null);
  const secondSource = path.join(root, 'second.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', secondSource]);
  const secondAsset = await registerManagedCopy(db, 'p', { sourcePath: secondSource });
  registerFormulaAssetBinding(db, 'p', batch, { assetId: secondAsset, sourcePath: '其他/G1_正面.mp4' });
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('素材');
  sheet.addRow(['逻辑编号', '画面描述']);
  sheet.addRow(['S76', '3cm 金属脚']);
  let index = getFormulaMaterialIndex(db, 'p', batch);
  const session = await createFormulaImportSession(db, 'p', batch, { kind: 'materials', filename: '素材.xlsx', bytes: Buffer.from(await wb.xlsx.writeBuffer()), expectedRevision: index.revision });
  confirmFormulaImportSession(db, 'p', batch, session.id, { expectedRevision: index.revision, excludedKeys: [] });
  index = getFormulaMaterialIndex(db, 'p', batch);
  assert.equal(index.bindings.length, 5);
  assert.deepEqual(index.codes.find(row => row.logicalCode === 'G1')?.candidateAssetIds.sort(), [assetId, secondAsset].sort());
  assert.deepEqual(index.codes.find(row => row.logicalCode === 'G10')?.candidateAssetIds, [assetId]);
  assert.deepEqual(index.codes.find(row => row.logicalCode === 'GB9')?.candidateAssetIds, []);
  assert.equal(index.codes.find(row => row.logicalCode === 'S76')?.status, 'missing_file');
  // 编号、口播台词和全景标记直接从文件名读出，不用再点整理。
  const wide = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/S3_整体外观_无人出镜.mp4' });
  assert.deepEqual([wide.wide, wide.wideExperience, wide.voLine], [true, false, null]);
  const wideExperience = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/P3_全景_整体外观_有人出镜.mp4' });
  assert.deepEqual([wideExperience.wide, wideExperience.wideExperience], [false, true]);
  const talking = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/VO7_口播_单人出镜_“这款坐着真舒服。”.mp4' });
  assert.equal(talking.voLine, '这款坐着真舒服。');
  index = getFormulaMaterialIndex(db, 'p', batch);
  assert.deepEqual(index.bindings.find(item => item.id === wide.id)?.wide, true);
  assert.deepEqual(index.bindings.find(item => item.id === talking.id)?.voLine, '这款坐着真舒服。');
  assert.equal(getFormulaMaterialIndex(db, 'p', otherBatch).bindings.length, 0, '集合不能借用另一批次同号素材');
  assert.throws(() => getFormulaMaterialIndex(db, 'other', batch), /不存在/);
  assert.throws(() => registerFormulaAssetBinding(db, 'other', batch, { assetId, sourcePath: 'G1.mp4' }), /不存在/);
  assert.throws(() => registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '../G1.mp4' }), /相对路径/);
  mapFormulaAssetBinding(db, 'p', batch, unmapped.id, { logicalCode: 'p100', expectedRevision: index.revision });
  assert.equal(getFormulaMaterialIndex(db, 'p', batch).bindings.find(item => item.id === unmapped.id)?.logicalCode, 'P100');
  assert.throws(() => mapFormulaAssetBinding(db, 'p', batch, unmapped.id, { logicalCode: 'S1', expectedRevision: index.revision }), /刷新/);
  assert.equal(await computeFileSha256(source), beforeHash, '原片不可改写');
  const managedSource = listAssetSources(db, assetId).find(item => item.sourceKind === 'managed')!;
  const managedPath = resolveSourceFilePath(managedSource.locationJson);
  const managedRelative = path.relative(path.resolve(root), path.resolve(managedPath));
  assert(managedRelative && managedRelative !== '..' && !managedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(managedRelative), '只可移除本测试临时根内的受控副本');
  fs.unlinkSync(managedPath);
  const missingCopy = await refreshFormulaMaterialIndex(db, 'p', batch);
  assert.equal(missingCopy.bindings.find(item => item.id === binding.id)?.available, false, '副本丢失不能显示已完成核验或跳过补传');
  assert.deepEqual(missingCopy.codes.find(item => item.logicalCode === 'G1')?.candidateAssetIds, [secondAsset]);
  assert.equal(await registerManagedCopy(db, 'p', { sourcePath: source }), assetId);
  await verifyAssetSources(db, assetId);
  assert.equal(registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '素材/G1_正面.mp4' }).id, binding.id);
  assert.equal((await refreshFormulaMaterialIndex(db, 'p', batch)).bindings.find(item => item.id === binding.id)?.available, true);
  const noteInputs = readFormulaMaterialNotes(db, 'p', batch);
  const note = saveFormulaMaterialNote(db, 'p', batch, binding.id, {
    expectedRevision: noteInputs.revision, expectedProfileId: null,
    content: { description: '产品正面展示', category: '外观展示', sellingPoints: [], actions: ['正面展示'], speech: 'unknown', evidence: [] },
  });
  const noteAfter = readFormulaMaterialNotes(db, 'p', batch);
  assert.equal(noteAfter.items.find(item => item.bindingId === binding.id)?.profile?.id, note.id);
  assert.equal(noteAfter.items.find(item => item.bindingId === binding.id)?.profile?.origin, 'manual');
  assert.equal(noteAfter.items.find(item => item.logicalCode === 'G10')?.profile, null, '同内容不同编号的描述不能串改');
  assert.throws(() => saveFormulaMaterialNote(db, 'p', otherBatch, binding.id, {
    expectedRevision: 0, expectedProfileId: null, content: note.content,
  }), /不存在/);
  assert.throws(() => saveFormulaMaterialNote(db, 'p', batch, binding.id, {
    expectedRevision: noteInputs.revision, expectedProfileId: null, content: note.content,
  }), /更新/);
  // 资料变化后人工说明显示过期，但原说明保留；表格里的旧文件路径不进入对外展示。
  sheet.getCell('C1').value = '台词'; sheet.getCell('D1').value = '旧文件路径';
  sheet.addRow(['G1', '产品背面外观', '这是表中台词', 'E:/用户旧盘/原片.mp4']);
  const newTable = await createFormulaImportSession(db, 'p', batch, { kind: 'materials', filename: '素材补充.xlsx',
    bytes: Buffer.from(await wb.xlsx.writeBuffer()), expectedRevision: noteAfter.revision });
  confirmFormulaImportSession(db, 'p', batch, newTable.id, { expectedRevision: noteAfter.revision, excludedKeys: [] });
  const changed = readFormulaMaterialNotes(db, 'p', batch);
  assert.equal(changed.items.find(item => item.bindingId === binding.id)?.stale, true);
  assert.equal(changed.items.find(item => item.bindingId === binding.id)?.profile?.id, note.id, '资料变化不删除人工说明');
  assert.equal(changed.items.find(item => item.bindingId === binding.id)?.source.table?.cells['画面描述'], 'B3');
  createBatchProductionVersion(db, batch, { copyCount: 1 });
  updateBatchProductionStatus(db, 'p', batch, 'running');
  assert.throws(() => registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: 'P2.mp4' }), /冻结/);
  assert.throws(() => saveFormulaMaterialNote(db, 'p', batch, binding.id, { expectedRevision: changed.revision, expectedProfileId: note.id, content: note.content }), /冻结/);
  await assert.rejects(() => organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: changed.revision }, {
    id: 'fixture', name: '验收', model: 'fixture', analyze: async () => { throw new Error('不应发起模型调用'); },
  }), /冻结/);
  console.log('formula-material-bindings: 视频/别名隔离、文件名解析、素材说明、人工覆盖、过期与冻结通过');
} finally {
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT; else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
