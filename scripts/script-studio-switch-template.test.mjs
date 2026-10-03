import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { parseScriptProductionMode, parseScriptStudioRequestedCount, parseScriptStudioTargetDuration, parseTemplateRewriteEntryIds } from '../lib/script-studio/generation-contract.ts';

// Run the actual UI callback with controlled React setters and transport.
// No user database, scheduler or paid provider calls.
function callback(name, context, file = 'components/script-studio/ScriptStudioPanel.tsx') {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, `Missing callback: ${name}`);
  const code = ts.transpileModule(`const ${declaration.getText(ast)}; globalThis.handler = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = { useCallback: fn => fn, ...context };
  vm.runInNewContext(code, sandbox);
  return sandbox.handler;
}

const requests = [];
const state = {};
const context = {
  projectId: 'project-1', libraryRevisionId: 'library-1', providerId: 'provider-1',
  taskRunning: false, submitting: false,
  setError: value => { state.error = value; },
  setTemplateSwitchScript: value => { state.script = value; },
  setTask: value => { state.task = value; },
  setStep: value => { state.step = value; },
  startPolling: () => {},
  fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ task: { id: 'task-1' } }) };
  },
};
const switchRecommendation = callback('switchRecommendation', context);
await switchRecommendation({ id: 'script-1', currentRevision: { targetDurationSec: 15 } }, {
  productionMode: 'template_rewrite', templateRewrite: { entryId: 'old-template' },
});
assert.equal(requests.length, 0, 'Changing a viral template must open the picker, not POST an ordinary generation task');
assert.equal(state.script.scriptId, 'script-1');
assert.equal(state.script.targetDurationSec, 15);

await switchRecommendation({ id: 'ordinary-script', currentRevision: { targetDurationSec: 20 } }, {
  recommendation: { framework: { stableKey: 'old-framework' } },
});
assert.equal(requests.length, 1, 'Ordinary scripts retain the framework switching action');
assert.equal(requests[0].body.targetScriptId, 'ordinary-script');
assert.deepEqual(requests[0].body.exclusions, { frameworkKeys: ['old-framework'] });

// Submit the real dialog callback through the same request validators as the API.
const dialogFile = 'components/script-studio/ScriptTemplateSwitchDialog.tsx';
const submitted = [];
let status = 503;
const dialog = {
  projectId: 'project-1', scriptId: 'script-1', targetDurationSec: 15,
  libraryRevisionId: 'library-1', providerId: 'provider-1', selectedIds: ['new-template'],
  inFlight: { current: false }, pendingAction: { current: null }, crypto,
  setError: value => { state.error = value; },
  setSubmitting: () => {}, setPending: () => {},
  onCreated: task => { state.created = task; },
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    submitted.push(body);
    assert.equal(parseScriptProductionMode(body.productionMode, parseScriptStudioTargetDuration(body.targetDurationSec)), 'template_rewrite');
    assert.deepEqual(parseTemplateRewriteEntryIds(body.templateEntryIds, parseScriptStudioRequestedCount(body.requestedCount)), ['new-template']);
    return { ok: status === 202, status, json: async () => ({ task: { id: 'new-task' }, message: 'fixture failure' }) };
  },
};
await callback('submit', { ...dialog, selectedIds: [] }, dialogFile)();
assert.equal(submitted.length, 0, 'No request before choosing a template');
await callback('submit', dialog, dialogFile)();
assert.ok(dialog.pendingAction.current, 'Unknown result retains frozen action');
assert.equal(submitted[0].targetScriptId, 'script-1', 'Save a new revision of the original script');
status = 202;
await callback('submit', { ...dialog, providerId: 'changed-provider', selectedIds: ['changed-template'] }, dialogFile)();
assert.deepEqual(submitted[1], submitted[0], 'Retry freezes key, template, provider and target script');
assert.equal(dialog.pendingAction.current, null);
assert.equal(state.created.id, 'new-task');
status = 400;
await callback('submit', dialog, dialogFile)();
assert.equal(dialog.pendingAction.current, null, 'Definitive rejection lets the user correct selection');
assert.equal(state.error, 'fixture failure');
const before = submitted.length;
await callback('submit', { ...dialog, inFlight: { current: true } }, dialogFile)();
assert.equal(submitted.length, before, 'Double click must not submit twice');

const pickerFile = 'components/script-studio/TemplateRewritePicker.tsx';
let selection;
const picker = { disabled: false, maxCount: 1, selectedIds: ['old-template'], onChange: ids => { selection = [...ids]; } };
callback('toggle', picker, pickerFile)('new-template');
assert.deepEqual(selection, ['new-template'], 'Single-script switching replaces selection instead of accumulating templates');
callback('toggle', { ...picker, maxCount: 6 }, pickerFile)('new-template');
assert.deepEqual(selection, ['old-template', 'new-template'], 'Group generation still supports multiple templates');
callback('toggle', { ...picker, disabled: true }, pickerFile)('another-template');
assert.deepEqual(selection, ['old-template', 'new-template'], 'Pending submission locks selection');
console.log('script-studio switch-template tests passed');
