import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createVideoMotionRow, getVideoMotionRowIssue } from '../components/video-tail-frame-state.ts';
import { materializeShotDrafts, planBulkVideoGeneration, MAX_ROWS_PER_SHOT } from '../components/video-bulk-prompt.ts';
import { videoDurationOptions, normalizeVideoDraftDuration } from '../lib/video-duration.ts';

// Execute production UI functions across draft resets; capture the actual batch POST.
// No local user data or real generation API is used.
const file = 'components/VideoGenerationPanel.tsx';
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['getRowProviderId', 'getRowTailCapability', 'getRowDurationOptions', 'getRowDuration',
  'getRowMultiShotCapability', 'makeEmptyRow', 'materializeAllDrafts', 'applyBulkProvider', 'handleGenerateAll', 'getBulkProviderId'];
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
const drafts = new Map();
const requests = [];
let status;
const ctx = {
  providers, configuredProviders: [...providers], preferredProvider: providers[0], bulkProviderId: '',
  safeShots: [{ id: 'first-shot', indexNum: 1 }], defaultDuration: 5, crypto,
  createVideoMotionRow, materializeShotDrafts, planBulkVideoGeneration, MAX_ROWS_PER_SHOT,
  videoDurationOptions, normalizeVideoDraftDuration, getVideoMotionRowIssue,
  creatingRef: { current: false }, mountedRef: { current: true }, pendingCreationTailIdsRef: { current: new Set() },
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
await ui.handleGenerateAll();
assert.equal(ctx.bulkProviderId, 'q30');
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

// Disabling/removing a selected provider must not silently submit with 2.5.
ctx.configuredProviders = [providers[0]];
assert.equal(ui.getRowProviderId(drafts.get('next-shot')[0]), 'q30');
const before = requests.length;
await ui.handleGenerateAll();
assert.equal(requests.length, before);
assert.match(status, /供应商已不可用/);
console.log('video bulk provider state tests passed');
