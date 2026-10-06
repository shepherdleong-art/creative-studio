import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real route guard without touching user files, SQLite or providers.
const calls = [];
const exports = {};
const source = ts.transpileModule(fs.readFileSync('app/api/projects/[id]/script-studio/import-directory/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(source, {
  exports, URL,
  require: name => {
    if (name === 'next/server') return { NextResponse: Response };
    if (name === '@/lib/db') return { getDb: () => null };
    if (name === '@/lib/script-studio/http') return {
      assertScriptStudioApiReady: async () => {},
      jsonOrNull: request => request.json(),
      errorResponse: error => ({ status: 400, body: { message: error.message } }),
    };
    if (name === '@/lib/script-studio/errors') return { ScriptStudioError: class extends Error {} };
    if (name === '@/lib/script-studio/import-directory') return {
      importImageDirectory: async (_db, projectId, directoryPath) => {
        calls.push({ projectId, directoryPath });
        return { files: [], totalBytes: 0 };
      },
    };
    throw new Error(`Unexpected import: ${name}`);
  },
});

async function check(label, headers, status, url = 'http://localhost:8298/api/projects/p1/script-studio/import-directory') {
  const before = calls.length;
  const directoryPath = String.raw`Q:\共享盘\详情页`;
  const request = new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ directoryPath }),
  });
  const response = await exports.POST(request, { params: Promise.resolve({ id: 'p1' }) });
  assert.equal(response.status, status, `${label}: ${await response.text()}`);
  assert.equal(calls.length - before, status === 200 ? 1 : 0, `${label}: rejected requests must not read files`);
  if (status === 200) assert.equal(calls.at(-1).directoryPath, directoryPath);
}

await check('desktop: Next internal localhost differs from browser Host', {
  host: '127.0.0.1:8298', origin: 'http://127.0.0.1:8298', 'sec-fetch-site': 'same-origin',
}, 200);
await check('browser localhost', { host: 'localhost:8298', origin: 'http://localhost:8298' }, 200);
await check('Host absent uses request URL', { origin: 'http://localhost:8298' }, 200);
await check('native JSON caller without Origin', { host: '127.0.0.1:8298' }, 200);
await check('external site', { host: '127.0.0.1:8298', origin: 'https://example.com' }, 403);
await check('different port', { host: '127.0.0.1:8298', origin: 'http://127.0.0.1:8299' }, 403);
await check('different scheme', { host: '127.0.0.1:8298', origin: 'https://127.0.0.1:8298' }, 403);
await check('loopback aliases are still different browser origins', { host: '127.0.0.1:8298', origin: 'http://localhost:8298' }, 403);
await check('opaque origin', { host: '127.0.0.1:8298', origin: 'null' }, 403);
await check('cross-site metadata', { host: '127.0.0.1:8298', origin: 'http://127.0.0.1:8298', 'sec-fetch-site': 'cross-site' }, 403);
await check('cross-site metadata without Origin', { 'sec-fetch-site': 'cross-site' }, 403);
await check('forwarded Host cannot grant access', { host: '127.0.0.1:8298', origin: 'https://example.com', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' }, 403);
console.log('script-studio-import-directory-route.test.mjs: ok');
