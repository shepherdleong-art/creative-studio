import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createVideoMotionRow, getVideoMotionGenerationMode, getVideoMotionRowIssue, getVideoMotionRowTailDraftState } from '../components/video-tail-frame-state.ts';
import { materializeShotDrafts, planBulkVideoGeneration, serializeVideoGenerationFields, MAX_ROWS_PER_SHOT } from '../components/video-bulk-prompt.ts';
import { resolveVideoGenerationSelection } from '../lib/video-generation-options.ts';

// Execute production UI functions across draft resets; capture the actual batch POST.
// No local user data or real generation API is used.
const file = 'components/VideoGenerationPanel.tsx';
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['getRowSelection', 'getRowProviderId', 'getRowTailCapability', 'getRowReferenceCapability', 'getRowDurationOptions', 'getRowDuration',
  'getRowGenerationMode', 'getVideoMotionRowIssue', 'serializeVideoGenerationFields', 'getRowMultiShotCapability', 'makeEmptyRow', 'materializeAllDrafts', 'applyBulkProvider', 'handleGenerateAll', 'getBulkProviderId'];
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
  ts.forEachChild(node, visit);
}
visit(ast);
const providers = [
  { id: 'k25', name: 'kling-2.5', type: 'openai-video', defaultModel: 'kling-2.5', configured: true },
  { id: 'q30', name: '七牛可灵 3.0', type: 'openai-video', defaultModel: 'qiniuyun/kling-3.0', configured: true },
];
for (const provider of providers) provider.capabilities = { durations: provider.id === 'k25' ? [5, 10] : Array.from({ length: 13 }, (_, i) => i + 3), tailFrame: { supported: false }, multiShot: { supported: provider.id === 'q30', defaultEnabled: true } };
providers.push(...['minimax-h3', 'wan-3.0'].map(model => ({
  id: model, name: model, type: 'openai-video', defaultModel: model, configured: true,
  capabilities: { durations: [5, 10], tailFrame: { supported: false }, multiShot: { supported: false }, reference: { supported: true } },
})));
const drafts = new Map();
const requests = [];
let status;
const ctx = {
  providers, configuredProviders: [...providers], preferredProvider: providers[0], bulkProviderId: '',
  safeShots: [{ id: 'first-shot', indexNum: 1 }], defaultDuration: 5, crypto,
  createVideoMotionRow, materializeShotDrafts, planBulkVideoGeneration, MAX_ROWS_PER_SHOT,
  resolveVideoGenerationSelection, validateVideoMotionRow: getVideoMotionRowIssue, getVideoMotionGenerationMode, getVideoMotionRowTailDraftState, serializeDraftGenerationFields: serializeVideoGenerationFields,
  creatingRef: { current: false }, mountedRef: { current: true }, pendingCreationTailIdsRef: { current: new Set() },
  pendingCreationReferenceIdsRef: { current: new Set() },
  getShotRows: id => drafts.get(id) || [], setShotRows: (id, rows) => drafts.set(id, rows),
  setBulkProviderId: id => { ctx.bulkProviderId = id; }, setBulkStatus: value => { status = value; },
  setCreating: () => {}, setBulkProgress: () => {}, setBulkDrawerOpen: () => {},
  refreshJobs: async () => {}, autoFillTailTransitionPrompts: () => {},
  effectiveSetId: 'set-1', videoJobs: [], DISCARDABLE_JOB_STATUSES: new Set(),
  fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ videoJobIds: ['created'] }) };
  },
};
vm.runInNewContext(ts.transpileModule(declarations.join('\n') + `\nglobalThis.handlers = { ${names.filter(name => source.includes(`const ${name} =`)).join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, ctx);
const ui = ctx.handlers;
ui.materializeAllDrafts();
ui.applyBulkProvider('q30');
assert.equal(drafts.get('first-shot')[0].providerId, 'q30');

// Switching groups clears drafts but retains the bulk selection, as in the real UI.
drafts.clear();
ctx.safeShots = [{ id: 'next-shot', indexNum: 1 }];
ui.materializeAllDrafts();
drafts.get('next-shot')[0].prompt = '测试运镜';
drafts.get('next-shot')[0].multiShot = false;
await ui.handleGenerateAll();
assert.equal(ctx.bulkProviderId, 'q30');
assert.equal(requests[0].body.items[0].multiShot, false, 'Explicit false must survive serialization into the batch request');
assert.equal(requests[0].body.items[0].generationMode, 'image-to-video', 'Existing drafts retain the legacy generation mode');
assert.deepEqual(requests[0].body.items[0].referenceAssetIds, [], 'Image-to-video requests never carry reference IDs');
assert.equal(requests[0].body.items[0].providerId, 'q30', 'Header shows 七牛可灵3.0: the batch request must not fall back to kling-2.5 after switching groups');
assert.equal(ui.getBulkProviderId(), 'q30');

// Adding a description / visiting an unvisited shot inherits the last bulk choice.
assert.equal(ui.makeEmptyRow().providerId, 'q30');
ctx.safeShots.push({ id: 'unvisited-shot', indexNum: 2 });
ui.applyBulkProvider('q30');
assert.equal(drafts.get('unvisited-shot')[0].providerId, 'q30');

// Explicit row choices remain valid, but the header must admit mixed providers.
drafts.get('unvisited-shot')[0].providerId = 'k25';
drafts.get('unvisited-shot')[0].prompt = '第二个运镜';
assert.equal(ui.getBulkProviderId(), '__mixed__');
drafts.get('next-shot')[0].providerId = 'k25';
assert.equal(ui.getBulkProviderId(), 'k25', 'Header reflects actual drafts instead of the remembered bulk choice');
ui.applyBulkProvider('q30');
assert.equal(ui.getBulkProviderId(), 'q30');
await ui.handleGenerateAll();
assert.ok(requests.slice(1).every(request => request.body.items.every(item => item.providerId === 'q30')));

// ── 规格 §6：H3/Wan 不再固定全能参考，模式由「模型＋该行尾帧状态」决定 ──
// 旧断言「Automatic reference ignores stale tail drafts」描述的正是本次要取消的
// 行为：悄悄丢掉用户已选的尾帧、退回单图。新合同是：有有效尾帧走首尾帧，
// 尾帧操作未完成时**阻止提交**，绝不降级。
for (const model of ['minimax-h3', 'wan-3.0']) {
  ui.applyBulkProvider(model);

  // 1) 没有尾帧 → 单图参考（自动）
  for (const row of drafts.get('next-shot')) { row.tailImageId = null; row.tailUploadState = 'idle'; }
  let start = requests.length;
  await ui.handleGenerateAll();
  assert.ok(requests.length > start, `${model}: 单图草稿必须提交`);
  for (const request of requests.slice(start)) for (const item of request.body.items) {
    assert.equal(item.generationMode, 'reference-to-video', `${model}: 无尾帧应走单图参考`);
    assert.equal(item.modeIntent, 'auto', `${model}: 自动模式必须带意图标记给服务端核对`);
    assert.equal(item.autoTailState, 'none');
    assert.deepEqual(item.referenceAssetIds, [], '自动模式不携带显式参考素材');
    assert.equal(item.tailImageId, null);
  }

  // 2) 有有效尾帧 → 首尾帧，尾帧 id 必须真的进请求
  for (const shotId of ['next-shot', 'unvisited-shot']) {
    for (const row of drafts.get(shotId)) { row.tailImageId = `tail-${model}`; row.tailUploadState = 'idle'; row.prompt = '转场'; }
  }
  start = requests.length;
  await ui.handleGenerateAll();
  assert.ok(requests.length > start, `${model}: 有效尾帧草稿必须提交`);
  for (const request of requests.slice(start)) for (const item of request.body.items) {
    assert.equal(item.generationMode, 'image-to-video', `${model}: 有有效尾帧必须走首尾帧`);
    assert.equal(item.modeIntent, 'auto');
    assert.equal(item.autoTailState, 'ready');
    assert.equal(item.tailImageId, `tail-${model}`, `${model}: 尾帧不能静默丢弃`);
    assert.deepEqual(item.referenceAssetIds, []);
  }

  // 3) 尾帧上传中/删除中/失败 → 阻止提交（零请求），不退回单图
  for (const state of ['uploading', 'deleting', 'failed']) {
    for (const shotId of ['next-shot', 'unvisited-shot']) {
      for (const row of drafts.get(shotId)) {
        row.tailImageId = state === 'failed' ? null : `tail-${model}`;
        row.tailUploadState = state;
      }
    }
    const blockedStart = requests.length;
    await ui.handleGenerateAll();
    assert.equal(requests.length, blockedStart, `${model}: 尾帧 ${state} 时必须阻止批量提交`);
    assert.match(String(status), /尾帧|上传|移除/, `${model}: 尾帧 ${state} 必须给出可读原因`);
  }
  for (const shotId of ['next-shot', 'unvisited-shot']) {
    for (const row of drafts.get(shotId)) { row.tailImageId = null; row.tailUploadState = 'idle'; }
  }
}

// 4) 批量里混合两个自动模式模型与单图/双图：各行独立分流，互不影响
ui.applyBulkProvider('minimax-h3');
const mixedRows = drafts.get('next-shot');
mixedRows[0].tailImageId = 'mixed-tail';
mixedRows[0].tailUploadState = 'idle';
mixedRows[0].prompt = '首尾帧行';
mixedRows[0].providerId = 'minimax-h3';
// 第二条运镜挂到 wan-3.0，且不带尾帧
mixedRows.push({ ...createVideoMotionRow('row-wan', 5), providerId: 'wan-3.0', prompt: '单图行', tailImageId: null, tailUploadState: 'idle' });
const mixedStart = requests.length;
await ui.handleGenerateAll();
assert.ok(requests.length > mixedStart, '混合批次必须提交');
const mixedItems = requests.slice(mixedStart).flatMap(request => request.body.items);
const h3Item = mixedItems.find(item => item.providerId === 'minimax-h3');
const wanItem = mixedItems.find(item => item.providerId === 'wan-3.0');
assert.ok(h3Item && wanItem, '两个模型的行都必须出现在请求里');
assert.equal(h3Item.generationMode, 'image-to-video', '同一批次里的双图行独立走首尾帧');
assert.equal(h3Item.tailImageId, 'mixed-tail');
assert.equal(wanItem.generationMode, 'reference-to-video', '同一批次里的单图行独立走单图参考');
assert.equal(wanItem.tailImageId, null);
assert.ok(mixedItems.every(item => item.modeIntent === 'auto'), '批量里每一行都带自动意图标记');
mixedRows.pop();
for (const row of drafts.get('next-shot')) { row.tailImageId = null; row.tailUploadState = 'idle'; }

ui.applyBulkProvider('q30');

// Disabling/removing a selected provider must not silently submit with 2.5.
ctx.configuredProviders = [providers[0]];
assert.equal(ui.getRowProviderId(drafts.get('next-shot')[0]), 'q30');
const before = requests.length;
await ui.handleGenerateAll();
assert.equal(requests.length, before);
assert.match(status, /供应商已不可用/);
console.log('video bulk provider state tests passed');
