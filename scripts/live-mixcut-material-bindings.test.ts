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
  const organized = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: noteAfter.revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: async input => {
      const sources = JSON.parse(input.userPrompt).items as Array<{ bindingId: string; filename: string }>;
      return { items: sources.map(item => ({ bindingId: item.bindingId, content: {
        description: item.filename, category: '', sellingPoints: [], actions: [], speech: 'unknown',
        evidence: [{ field: 'description', source: 'filename', quote: item.filename }],
      } })) };
    },
  });
  assert.equal(organized.run?.state, 'completed');
  assert.equal(organized.run?.succeeded, 3, '排除预览文件，并保留已人工整理的一条');
  assert.equal(organized.items.find(item => item.bindingId === binding.id)?.profile?.id, note.id);
  assert.equal(organized.items.find(item => item.logicalCode === 'G10')?.profile?.origin, 'ai');
  assert.equal(organized.items.find(item => item.logicalCode === 'GB9')?.profile, null);
  assert.equal(organized.revision, noteAfter.revision, '素材说明的独立修订不能作废正在预览的工作簿');
  const modelReply = (userPrompt: string) => {
    const sources = JSON.parse(userPrompt).items as Array<{ bindingId: string; filename: string }>;
    return { items: sources.map(item => ({ bindingId: item.bindingId, content: { description: item.filename,
      category: '', sellingPoints: [], actions: [], speech: 'unknown', evidence: [{ field: 'description', source: 'filename', quote: item.filename }] } })) };
  };
  for (let i = 1; i <= 13; i++) registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: `追加/P${1000 + i}_展示.mp4` });
  let calls = 0;
  const partial = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: getFormulaMaterialIndex(db, 'p', batch).revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: async input => {
      calls++; if (calls === 2) throw new Error('上游秘密不得回显'); return modelReply(input.userPrompt);
    },
  });
  assert.equal(partial.run?.state, 'failed');
  assert.equal(partial.run?.total, 13);
  assert.equal(partial.run?.succeeded, 12);
  assert.equal(partial.run?.errors.length, 1);
  assert(!JSON.stringify(partial).includes('上游秘密'));
  const completedIds = partial.items.flatMap(item => item.profile ? [item.profile.id] : []);
  let retriedItems = 0;
  const resumed = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: partial.revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: async input => {
      const result = modelReply(input.userPrompt); retriedItems += result.items.length; return result;
    },
  });
  assert.equal(retriedItems, 1, '不能因最后一组失败而重新调用已成功的 12 项');
  assert.equal(resumed.run?.state, 'completed');
  assert(completedIds.every(id => resumed.items.some(item => item.profile?.id === id)));
  // 资料变化时显示过期，保留人工说明；表格旧路径不进入模型输入。
  sheet.getCell('C1').value = '台词'; sheet.getCell('D1').value = '旧文件路径';
  sheet.addRow(['G1', '产品背面外观', '这是表中台词', 'E:/用户旧盘/原片.mp4']);
  const newTable = await createFormulaImportSession(db, 'p', batch, { kind: 'materials', filename: '素材补充.xlsx', bytes: Buffer.from(await wb.xlsx.writeBuffer()), expectedRevision: resumed.revision });
  confirmFormulaImportSession(db, 'p', batch, newTable.id, { expectedRevision: resumed.revision, excludedKeys: [] });
  const changed = readFormulaMaterialNotes(db, 'p', batch);
  assert.equal(changed.items.find(item => item.bindingId === binding.id)?.stale, true);
  const refreshed = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: changed.revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: async input => {
      assert(!input.userPrompt.includes('E:/用户旧盘'));
      assert(input.userPrompt.includes('产品背面外观'));
      return { items: modelReply(input.userPrompt).items.map(row => ({ ...row, content: { ...row.content,
        conflicts: [{ filenameQuote: '正面', tableQuote: '背面', message: '文件名写正面，表格写背面，需要核对' }],
      } })) };
    },
  });
  assert.equal(refreshed.items.find(item => item.bindingId === binding.id)?.profile?.id, note.id);
  assert.equal(refreshed.items.find(item => item.bindingId === binding.id)?.source.table?.cells['画面描述'], 'B3');
  assert.equal(refreshed.items.find(item => item.logicalCode === 'G1' && item.bindingId !== binding.id)?.profile?.content.conflicts?.length, 1);
  const lateBinding = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '追加/P2000_等待整理.mp4' });
  let finishModel!: (value: unknown) => void;
  let capturedPrompt = '';
  const waiting = new Promise<unknown>(resolve => { finishModel = resolve; });
  const late = organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: getFormulaMaterialIndex(db, 'p', batch).revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: input => { capturedPrompt = input.userPrompt; return waiting; },
  });
  const during = readFormulaMaterialNotes(db, 'p', batch);
  const manualDuring = saveFormulaMaterialNote(db, 'p', batch, lateBinding.id, { expectedRevision: during.revision, expectedProfileId: null, content: note.content });
  finishModel(modelReply(capturedPrompt));
  const lateResult = await late;
  assert.equal(lateResult.items.find(item => item.bindingId === lateBinding.id)?.profile?.id, manualDuring.id, '迟到模型不能盖掉人工保存');
  const badBinding = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '追加/P3000_无证据.mp4' });
  const badResult = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: getFormulaMaterialIndex(db, 'p', batch).revision }, {
    id: 'fixture', name: '命名分析验收', model: 'fixture-model', complete: async input => {
      const result = modelReply(input.userPrompt); result.items[0].content.evidence[0].quote = '来源中没有这句话'; return result;
    },
  });
  assert.equal(badResult.run?.state, 'failed');
  assert.equal(badResult.items.find(item => item.bindingId === badBinding.id)?.profile, null);
  const rollbackBinding = registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: '追加/P3001_写入失败.mp4' });
  db.exec(`CREATE TRIGGER fixture_profile_failure BEFORE INSERT ON live_mixcut_formula_material_profiles
    WHEN NEW.bindingId='${rollbackBinding.id}' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
  const rolledBack = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: getFormulaMaterialIndex(db, 'p', batch).revision }, {
    id: 'fixture', name: '验收', model: 'fixture', complete: async input => modelReply(input.userPrompt),
  });
  assert.equal(rolledBack.run?.state, 'failed');
  assert.equal(rolledBack.run?.succeeded, 0, '同组写入回滚时不能把此前未提交的项计入成功');
  assert.equal(rolledBack.items.find(item => item.bindingId === badBinding.id)?.profile, null);
  db.exec('DROP TRIGGER fixture_profile_failure');
  const cancelController = new AbortController();
  const cancelled = await organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: rolledBack.revision, signal: cancelController.signal }, {
    id: 'fixture', name: '验收', model: 'fixture', complete: async input => { cancelController.abort(); return modelReply(input.userPrompt); },
  });
  assert.equal(cancelled.run?.state, 'cancelled');
  assert.equal(cancelled.run?.succeeded, 0);
  assert.equal(cancelled.items.find(item => item.bindingId === badBinding.id)?.profile, null);
  createBatchProductionVersion(db, batch, { copyCount: 1 });
  updateBatchProductionStatus(db, 'p', batch, 'running');
  assert.throws(() => registerFormulaAssetBinding(db, 'p', batch, { assetId, sourcePath: 'P2.mp4' }), /冻结/);
  assert.throws(() => saveFormulaMaterialNote(db, 'p', batch, binding.id, { expectedRevision: badResult.revision, expectedProfileId: note.id, content: note.content }), /冻结/);
  await assert.rejects(() => organizeFormulaMaterialNotes(db, 'p', batch, { expectedRevision: badResult.revision }, {
    id: 'fixture', name: '验收', model: 'fixture', complete: async () => { throw new Error('不应发起模型调用'); },
  }), /冻结/);
  console.log('formula-material-bindings: 视频/别名隔离、素材说明、AI 分批续做、人工覆盖、引用与差异、回滚/取消/冻结通过');
} finally {
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT; else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
