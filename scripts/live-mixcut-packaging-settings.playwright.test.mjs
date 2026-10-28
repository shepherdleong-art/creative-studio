// Run: node scripts/live-mixcut-packaging-settings.playwright.test.mjs
// Real generation-settings components and parser; in-memory HTTP fixture, no user data or providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium, expect } from '@playwright/test';
import { parseFormulaSettings } from '../lib/live-mixcut/formula/settings.ts';
const root = process.cwd();
const modules = new Map();
const styles = [];
function bundle(filename) {
  if (modules.has(filename)) return modules.get(filename).id;
  const entry = { id: modules.size, source: '', deps: {} };
  modules.set(filename, entry);
  const raw = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.css')) {
    styles.push(raw.replace(/:global\(([^)]+)\)/g, '$1'));
    entry.source = 'module.exports = ' + JSON.stringify(Object.fromEntries(
      [...raw.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => [match[1], match[1]]),
    ));
    return entry.id;
  }
  entry.source = /\.tsx?$/.test(filename) ? ts.transpileModule(raw, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText : raw;
  const require = createRequire(filename);
  for (const [, request] of entry.source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const local = request.startsWith('@/') ? path.join(root, request.slice(2))
      : request.startsWith('.') ? path.resolve(path.dirname(filename), request) : null;
    const resolved = local && ['', '.ts', '.tsx', '.js'].map(ext => local + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    entry.deps[request] = bundle(resolved || require.resolve(request));
  }
  return entry.id;
}


const panelId = bundle(path.join(root, 'components/live-mixcut/formula/FormulaGenerationSettings.tsx'));
const require = createRequire(import.meta.url);
const reactId = bundle(require.resolve('react'));
const domId = bundle(require.resolve('react-dom/client'));
const script = `
const process={env:{NODE_ENV:'production'}};
const modules={${[...modules.values()].map(m=>`${m.id}:[function(require,module,exports){${m.source}\n},${JSON.stringify(m.deps)}]`).join(',')}};
const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};const [fn,deps]=modules[id];fn(r=>load(deps[r]),m,m.exports);return m.exports;}
const React=load(${reactId});
load(${domId}).createRoot(document.getElementById('root')).render(React.createElement(load(${panelId}).default,{projectId:'p',batchId:'b',inputRevision:1,pendingImport:false,disabled:false,onEdit:()=>{},onGenerated:async()=>{}}));
`;
const templates = ['poster','journal','minimal','variety'].map((name, i) => ({ id: `overlay-${name}`, name: `f${i + 1} 模板` }));
let saved = null;
const requests = [];
const view = () => ({ inputRevision: 1, scriptsSessionId: 'scripts', scripts: [{ key: 's1', scriptNumber: '1', platform: '抖音', codes: ['G1'], bodyText: '测试文案', targetDurationSec: 10, shotCount: 1, source: { sheet: '脚本', row: 2 } }],
  hasPendingScripts: false, editable: true, stale: false, saved, tracks: [], productionOptions: { voices: [], templates, coverPresets: [] } });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.includes('/formula/settings?')) {
      if (req.method === 'PUT') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body.settings.production.packaging);
        const settings = parseFormulaSettings(body.settings, ['s1']);
        saved = { id: 'settings', revision: (saved?.revision ?? 0) + 1, scriptsSessionId: 'scripts', settings, totalCopies: 1, createdAt: 'fixture' };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(view()));
    } else if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(script);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
    }
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ message: error.message })); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const random = page.getByRole('radio', { name: '随机分配包装', exact: true });
  const save = page.getByRole('button', { name: '保存生成设置', exact: true });
  const checkSaved = async count => {
    await save.click();
    await expect(page.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
    await expect(random).toBeChecked();
    assert.equal(saved.settings.production.packaging.mode, 'random');
    assert.equal(saved.settings.production.packaging.templateIds.length, count);
    await page.getByRole('button', { name: '重新读取设置', exact: true }).click();
    await expect(save).toBeEnabled();
    await expect(random).toBeChecked();
  };
  await random.check();
  for (const template of templates) await expect(page.getByRole('checkbox', { name: template.name, exact: true })).toBeChecked();
  await checkSaved(4);
  await page.getByRole('checkbox', { name: 'f4 模板', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'f3 模板', exact: true }).uncheck();
  await checkSaved(2);
  await page.getByRole('checkbox', { name: 'f2 模板', exact: true }).uncheck();
  await checkSaved(1);
  await page.reload();
  await expect(random).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'f1 模板', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'f1 模板', exact: true }).uncheck();
  await expect(save).toBeDisabled();
  await page.getByRole('radio', { name: '不加包装', exact: true }).check();
  await save.click();
  await expect(page.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  assert.deepEqual(saved.settings.production.packaging, { mode: 'none', templateIds: [] });
  await random.check();
  await checkSaved(4);
  await page.getByRole('radio', { name: '整批统一包装', exact: true }).check();
  await page.getByRole('radio', { name: 'f3 模板', exact: true }).check();
  await save.click();
  await expect(page.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  assert.deepEqual(saved.settings.production.packaging, { mode: 'uniform', templateIds: ['overlay-minimal'] });
  assert.equal(requests.length, 6);
  assert.deepEqual(errors, []);
  console.log('PASS 随机默认全选；保存/读取/刷新保留四选/两选/单选；空候选禁存；关闭与统一模式正常');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
