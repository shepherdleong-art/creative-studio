import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// 内存里的数据库 + 假的视觉服务：不调用任何真实模型。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-analysis-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','画面分析');");
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { readLiveMixcutAppliedVersions } = await import('../lib/live-mixcut/schema.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { readFormulaMaterialNotes, organizeFormulaMaterialNotes } = await import('../lib/live-mixcut/formula/material-notes.ts');
  const { formulaMaterialAnalysisGap, listFormulaMaterialAnalyses, pickFormulaUsableRange, saveFormulaMaterialAnalysis } = await import('../lib/live-mixcut/formula/material-analysis.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, []);
  assert(readLiveMixcutAppliedVersions(db).includes(3), '画面分析表走追加迁移');

  async function video(name: string, color: string, seconds = 1) {
    const file = path.join(root, name);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    return registerManagedCopy(db, 'p', { sourcePath: file });
  }

  const batchA = createBatchProduction(db, 'p', '第一批', undefined, { planningMode: 'formula' });
  const red = await video('red.mp4', 'red');
  const orange = await video('orange.mp4', 'orange');
  const green = await video('green.mp4', 'green');
  const purple = await video('purple.mp4', 'purple');
  registerFormulaAssetBinding(db, 'p', batchA, { assetId: red, sourcePath: '素材/G1_正面.mp4' });
  registerFormulaAssetBinding(db, 'p', batchA, { assetId: orange, sourcePath: '素材/G1_另一份.mp4' });
  registerFormulaAssetBinding(db, 'p', batchA, { assetId: green, sourcePath: '素材/P2_细节.mp4' });
  registerFormulaAssetBinding(db, 'p', batchA, { assetId: purple, sourcePath: '素材/VO1_口播_“这款真舒服。”.mp4' });
  const calls: string[] = [];
  const vision = { id: 'fake-vision', name: '假视觉', model: 'fake-vision/1', analyze: async (input: { assetId: string }) => {
    calls.push(input.assetId);
    return {
      summary: input.assetId === green ? '金属脚细节' : '沙发正面全景',
      sellingPoints: ['易清洁'], semanticTags: [], qualityIssues: [], coverFrameTimesUs: [],
      usableRanges: [{ startUs: 0, endUs: 500_000, qualityScore: 0.3 }, { startUs: 600_000, endUs: 2_500_000, qualityScore: 0.9 }],
      scenes: [{ startUs: 0, endUs: 1_000_000, description: '客厅里的沙发', labels: [], qualityScore: 0.8 }],
    };
  } };
  let notes = readFormulaMaterialNotes(db, 'p', batchA);
  notes = await organizeFormulaMaterialNotes(db, 'p', batchA, { expectedRevision: notes.revision }, vision);
  // 三段非口播素材各分析一次；口播镜头不看画面。
  assert.deepEqual([...calls].sort(), [red, orange, green].sort(), '每段非口播素材只分析一次，口播镜头不分析');
  assert.equal(notes.run?.succeeded, 3);
  assert.equal(notes.items.find(item => item.voiceOver)?.analysis, null);
  const first = notes.items.find(item => item.source.assetId === red && item.logicalCode === 'G1')!;
  assert.equal(first.analysis?.usableInUs, 600_000);
  assert.equal(first.analysis?.usableOutUs, 2_500_000);
  assert.equal(first.analysis?.description, '沙发正面全景');
  assert.equal(first.profile?.provenance.analysisId, first.analysis?.id, '说明记录用的是哪次画面分析');
  assert.equal(listFormulaMaterialAnalyses(db, 'p').size, 3);

  // 同一任务新建批次：同一段素材按内容指纹复用，一次模型都不调。
  const batchB = createBatchProduction(db, 'p', '第二批', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', batchB, { assetId: red, sourcePath: '素材/G1_正面.mp4' });
  registerFormulaAssetBinding(db, 'p', batchB, { assetId: green, sourcePath: '素材/P2_细节.mp4' });
  let notesB = readFormulaMaterialNotes(db, 'p', batchB);
  notesB = await organizeFormulaMaterialNotes(db, 'p', batchB, { expectedRevision: notesB.revision }, vision);
  assert.equal(calls.length, 3, '换批次不重复分析同一段素材');
  assert.equal(notesB.run?.succeeded, 2, '复用的分析照样写成这一批的说明');
  assert(notesB.items.every(item => item.profile && item.analysis));
  assert.equal(formulaMaterialAnalysisGap(db, 'p', batchB).missingSources, 0);

  // 文件内容变了就是新素材，要重新分析；生成前检查拦在这里，并写明还差几段。
  const batchC = createBatchProduction(db, 'p', '第三批', undefined, { planningMode: 'formula' });
  const blue = await video('blue.mp4', 'blue');
  const bindingC = registerFormulaAssetBinding(db, 'p', batchC, { assetId: blue, sourcePath: '素材/G1_新版本.mp4' });
  registerFormulaAssetBinding(db, 'p', batchC, { assetId: red, sourcePath: '素材/VO1_口播_“这款真舒服。”.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [1, '抖音', 2, 6, 'G1 VO1', '这款真舒服。'],
  ]);
  const scriptsRevision = readFormulaMaterialNotes(db, 'p', batchC).revision;
  const scripts = await createFormulaImportSession(db, 'p', batchC, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: scriptsRevision });
  confirmFormulaImportSession(db, 'p', batchC, scripts.id, { expectedRevision: scriptsRevision, excludedKeys: [] });
  const gap = formulaMaterialAnalysisGap(db, 'p', batchC);
  assert.deepEqual(gap.missingCodes, ['G1'], '口播镜头不算没分析');
  assert.equal(gap.missingSources, 1);
  const revision = readFormulaMaterialNotes(db, 'p', batchC).revision;
  const settings = await saveFormulaSettings(db, 'p', batchC, { expectedInputRevision: revision, expectedSettingsRevision: 0,
    scriptsSessionId: scripts.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  await assert.rejects(() => createFormulaGenerationRequest(db, 'p', batchC, { requestKey: 'blocked', settingsId: settings.saved!.id,
    expectedInputRevision: revision }), /还有 1 段素材没分析画面（G1）.*分析画面/);
  saveFormulaMaterialAnalysis(db, 'p', { contentFingerprint: bindingC.contentFingerprint, analysis: await vision.analyze({ assetId: blue }),
    provider: { id: 'fake-vision', name: '假视觉', model: 'fake-vision/1' } });
  assert.equal(formulaMaterialAnalysisGap(db, 'p', batchC).missingSources, 0);
  const request = await createFormulaGenerationRequest(db, 'p', batchC, { requestKey: 'ready', settingsId: settings.saved!.id,
    expectedInputRevision: revision });
  assert.equal(request.outputs.length, 1, '分析齐了才能生成');

  // 有效片段取画质最好的一段；分数一样取更长的一段。
  const rangesOf = (list: Array<{ startUs: number; endUs: number; qualityScore: number }>) => ({ summary: '', sellingPoints: [],
    semanticTags: [], qualityIssues: [], coverFrameTimesUs: [], usableRanges: list, scenes: [] });
  assert.deepEqual(pickFormulaUsableRange(await vision.analyze({ assetId: red })), { inUs: 600_000, outUs: 2_500_000 });
  assert.deepEqual(pickFormulaUsableRange(rangesOf([{ startUs: 0, endUs: 1_000_000, qualityScore: 0.5 },
    { startUs: 2_000_000, endUs: 4_000_000, qualityScore: 0.5 }])), { inUs: 2_000_000, outUs: 4_000_000 });
  assert.deepEqual(pickFormulaUsableRange(rangesOf([])), { inUs: 0, outUs: 0 });
  console.log('formula-material-analysis: 每段只分析一次、换批次复用、口播跳过、生成前检查通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
