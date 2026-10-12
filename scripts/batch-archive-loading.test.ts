// Run: node scripts/batch-archive-loading.test.ts
// Execute the panel's actual load callback against an isolated database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  createBatchProduction, listProjectBatchProductions, setBatchProductionArchived,
  type BatchProductionRow,
} from '../lib/batch-production/versions.ts';

const panelPath = path.resolve('components/batch-production/BatchPreparationPanel.tsx');
const source = ts.createSourceFile(panelPath, fs.readFileSync(panelPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'load'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    callback = node.initializer.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback, 'must execute the real panel load callback');
const compiled = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-archive-loading-'));
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1', '测试项目'), ('p2', '其他项目');");
  assert.equal((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'ready');
  const archivedId = createBatchProduction(db, 'p1', '待恢复批次');
  const activeId = createBatchProduction(db, 'p1', '当前批次');
  createBatchProduction(db, 'p2', '其他项目批次');
  setBatchProductionArchived(db, 'p1', archivedId, true);

  let batches: BatchProductionRow[] = [];
  let selected = '';
  let error = '';
  const noop = () => {};
  const context = {
    projectId: 'p1',
    readJson: (response: Response) => response.json(),
    fetch: async (input: string) => {
      const url = new URL(input, 'http://127.0.0.1');
      let body: unknown;
      switch (url.pathname) {
        case '/api/batch-production/readiness': body = { available: true }; break;
        case '/api/batch-production/prepare': body = {}; break;
        case '/api/batch-production/batches':
          body = { batches: listProjectBatchProductions(db, url.searchParams.get('projectId')!, {
            includeArchived: url.searchParams.get('includeArchived') === '1',
          }) }; break;
        case '/api/providers/script': case '/api/providers/tts': body = []; break;
        default: throw new Error(`Unexpected request: ${url.pathname}`);
      }
      return Response.json(body);
    },
    setBatches: (value: BatchProductionRow[]) => { batches = value; },
    setSelectedBatchId: (update: (current: string) => string) => { selected = update(selected); },
    setError: (value: string) => { error = value; },
    setLoading: noop, setPreparation: noop, setVisionProviders: noop,
    setTtsProviders: noop, setTtsConfigured: noop, setVisionProviderId: noop,
    setOutputPlans: noop, setBatchStatus: noop, setBatchInputState: noop,
    setFrozenScriptSnapshots: noop, setInputConfirmed: noop, setAssetPrepareTasks: noop,
  };
  const load = vm.runInNewContext(compiled, context) as () => Promise<void>;
  await load();
  assert.equal(error, '');
  assert.ok(batches.some(({ id }) => id === archivedId), '显示已归档必须能拿到后端保留的批次');
  assert.equal(batches.length, 2, '不能包含其他项目批次');
  assert.equal(selected, activeId, '首次打开应选择未归档批次');

  selected = archivedId;
  await load();
  assert.equal(selected, archivedId, '显式查看归档批次时刷新应保留选择');

  setBatchProductionArchived(db, 'p1', archivedId, false);
  await load();
  assert.equal(batches.find(({ id }) => id === archivedId)?.archivedAt, null, '恢复后重载应回到未归档列表');

  setBatchProductionArchived(db, 'p1', archivedId, true);
  setBatchProductionArchived(db, 'p1', activeId, true);
  selected = '';
  await load();
  assert.equal(selected, '', '只有归档批次时不自动选中隐藏项');
  assert.equal(batches.length, 2, '全部归档后仍可查看和恢复');
  console.log('batch archive loading tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
