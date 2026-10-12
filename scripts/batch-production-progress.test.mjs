import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = process.cwd();
function load(relative) {
  const filename = path.join(root, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => name.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), name))) : require(name) });
  return exports;
}
// Exercise the component's actual derivation and rendered card, not a copy of the predicate.
const filename = path.join(root, 'components/batch-production/BatchPreparationPanel.tsx');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'progressView') callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const js = ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const task = (workType, status, extra = {}) => ({ workType, status, attemptCount: 1, createdAt: '2026-10-12T00:00:00Z', attempts: [{ finishedAt: '2026-10-12T00:30:05Z', errorCode: 'semantic_fallback' }], ...extra });
const evaluate = (tasks, cards, allocationReport = null) => vm.runInNewContext(js, {
  ...load('lib/batch-production/progress-summary.ts'), batchStatus: 'draft', batchTasks: tasks,
  workspace: { allocationReport, cards }, hasActiveBatchTask: tasks.some(t => ['queued', 'running'].includes(t.status)), nowMs: Date.parse('2026-10-12T00:30:05Z'),
})();
const Card = load('components/batch-production/BatchProductionProgressCard.tsx').default;
const render = progress => require('react-dom/server').renderToStaticMarkup(require('react').createElement(Card, { progress }));
for (const status of ['cancelled', 'failed', 'succeeded']) {
  const p = evaluate([task('semantic_score', status)], [{ versionId: null }]);
  assert.equal(p.finished, false, '只有语义任务结束、没有实际版本时，不得报生产完成');
  assert.notEqual(p.stages.at(-1).status, 'done', '计划卡不代表完成分配');
  assert.ok(!render(p).includes('aria-valuenow="100"'));
  assert.ok(!render(p).includes('已完成 · 总用时'));
}
const completed = [task('semantic_score', 'succeeded'), task('narration', 'succeeded'), task('render', 'succeeded', { targetKind: 'output_version_cover' })];
assert.equal(evaluate(completed, [{ versionId: 'v1' }], { status: 'completed' }).finished, true);
assert.equal(evaluate(completed, [{ versionId: 'v1' }, { versionId: null }], { status: 'partial' }).finished, false);
assert.equal(evaluate([...completed, task('render', 'failed', { targetKind: 'output_version' })], [{ versionId: 'v1' }], { status: 'completed' }).finished, false);
console.log('PASS: actual production progress and rendered completion states');
