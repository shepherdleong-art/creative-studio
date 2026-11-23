// Run: node scripts/mixcut-context-loading.test.ts
// Execute the real component callback: a fast asset failure must be caught even
// while another context request is still pending.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const panelPath = path.resolve(import.meta.dirname, '../components/mixcut/MixcutPanel.tsx');
const source = ts.createSourceFile(panelPath, fs.readFileSync(panelPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
let readJson: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'readJson') readJson = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'loadContext'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    callback = node.initializer.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback && readJson, 'must execute the real loadContext and readJson');
const compiled = ts.transpileModule(`${readJson.getText(source)}\n(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
// The broken implementation attaches a catch after the rejection has surfaced.
const onHandled = () => {};
process.on('unhandledRejection', onUnhandled);
process.on('rejectionHandled', onHandled);
try {
  for (const failure of ['http', 'network', 'abort'] as const) {
    let message = '';
    let loading = false;
    let releaseGroups!: (response: Response) => void;
    const groups = new Promise<Response>(resolve => { releaseGroups = resolve; });
    const requestRef: { current: { sequence: number; controller: AbortController } | null } = { current: null };
    const load = vm.runInNewContext(compiled, {
      AbortController, DOMException, Error,
      projectId: 'project-test', requestRef,
      setLoading: (value: boolean) => { loading = value; },
      setMessage: (value: string) => { message = value; },
      fetch: async (url: string) => {
        if (url.endsWith('/context')) return Response.json({ currentShotSetId: 'set-test' });
        if (url.endsWith('/external-assets')) {
          if (failure === 'network') throw new Error('network failed');
          if (failure === 'abort') throw new DOMException('cancelled', 'AbortError');
          return new Response('<html>Not Found</html>', { status: 404 });
        }
        if (url.endsWith('/groups')) return groups;
        if (url.startsWith('/api/team/models?')) return Response.json([]);
        throw new Error(`Unexpected request: ${url}`);
      },
    }) as () => Promise<void>;
    const pending = load();
    // A full event-loop turn exposes the unhandled rejection in the old code.
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseGroups(Response.json({ groups: [] }));
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loading, false, 'loading must settle on failure/cancellation');
    assert.equal(message, failure === 'http' ? 'HTTP 404' : failure === 'network' ? 'network failed' : '');
  }
  assert.deepEqual(unhandled, [], 'fast asset failures must not escape as an unhandled rejection');
} finally {
  process.removeListener('unhandledRejection', onUnhandled);
  process.removeListener('rejectionHandled', onHandled);
}
console.log('PASS: mixcut context catches early HTTP/network failures and cancellation');
