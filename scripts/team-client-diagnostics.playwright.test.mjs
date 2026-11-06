// Real browser React effect + storage; no app service, user DB or paid provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const modules = new Map();
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText : fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map((extension) => local + extension)
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    entry.deps[request] = bundle(resolved || localRequire.resolve(request));
  }
  return entry.id;
}
const componentId = bundle(path.resolve('components/team/ClientDiagnostics.tsx'));
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map((m) => `${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId}), Diagnostics=load(${componentId}).default;
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(Diagnostics));
window.fixtureLoaded = true;
`;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(script);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<html data-deployment-mode="server"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.userId = 'alice';
    window.sent = [];
    window.offline = (window.initializations || 0) === 0;
    window.initializations = (window.initializations || 0) + 1;
    window.offline = window.initializations === 1;
    window.failure = new Error('private source https://example.test/?signature=secret');
    window.calls = [];
    window.fetch = async (url, options) => {
      window.calls.push({ url, offline: window.offline });
      if (url === '/api/team/auth/session') return Response.json(window.userId
        ? { authenticated: true, user: { id: window.userId } } : { authenticated: false });
      if (url === '/api/team/errors/report') {
        if (window.offline) throw new Error('network_offline');
        window.sent.push(JSON.parse(options.body));
        return Response.json({ errorId: 'server-event' }, { status: 201 });
      }
      throw new Error('unexpected network request');
    };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => window.userId === 'alice' && localStorage.length === 0);
  const reason = new Error('private source https://example.test/?signature=secret');
  await page.evaluate(() => {
    const rejection = new PromiseRejectionEvent('unhandledrejection', { reason: window.failure, promise: Promise.reject(window.failure) });
    rejection.preventDefault();
    window.dispatchEvent(rejection);
    window.dispatchEvent(new ErrorEvent('error', { error: window.failure, message: window.failure.message }));
    const cancelled = new PromiseRejectionEvent('unhandledrejection', { reason: new DOMException('Aborted', 'AbortError'), promise: Promise.resolve() });
    cancelled.preventDefault();
    window.dispatchEvent(cancelled);
  });
  await page.waitForFunction(() => localStorage.getItem('creative-studio-client-diagnostics-v1') !== null);
  const stored = await page.evaluate(() => localStorage.getItem('creative-studio-client-diagnostics-v1'));
  const state = JSON.parse(stored);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].userId, 'alice');
  assert.equal(state.accounts[0].events.length, 1, '同一原始异常不得从两个监听器重复上报');
  assert.equal(state.accounts[0].events[0].stage, 'client_ui');
  assert.equal(stored.includes('secret'), false);
  await page.evaluate(() => { window.offline = false; });
  await page.close();
  const reopened = await context.newPage();
  await reopened.addInitScript(() => {
    window.userId = 'alice';
    window.offline = false;
    window.sent = [];
    window.fetch = async (url, options) => {
      if (url === '/api/team/auth/session') return Response.json({ authenticated: true, user: { id: window.userId } });
      if (url === '/api/team/errors/report') {
        window.sent.push(JSON.parse(options.body));
        return Response.json({ errorId: 'server-event' }, { status: 201 });
      }
      throw new Error('unexpected network request');
    };
  });
  await reopened.goto(origin);
  await reopened.waitForFunction(() => window.sent.length === 1);
  const sent = await reopened.evaluate(() => window.sent);
  assert.equal(sent[0].clientEventId, state.accounts[0].events[0].clientEventId, '重载后保留同一稳定事件身份');
  await reopened.waitForFunction(() => localStorage.getItem('creative-studio-client-diagnostics-v1') === null);
  await reopened.evaluate(() => { window.userId = 'bob'; });
  await reopened.evaluate(() => window.dispatchEvent(new Event('online')));
  await reopened.waitForTimeout(100);  assert.equal(await reopened.evaluate(() => window.sent.length), 1, '换账号不得补报旧账号记录');
  assert.deepEqual(errors, []);
  console.log('PASS real browser UI capture, offline persistence, stable retry and account isolation');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
