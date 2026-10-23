/** Real PS866 acceptance. Sources are read-only; all application data stays in a separate output directory.
 * node scripts/formula-ps866-import.playwright.mjs --source <目录> --audit <审计目录> --model <已配置脚本供应商ID>
 * --resume <state.json> reuses the same isolated project and batch after an interrupted run.
 * --local-only uses exact local workbook headers and disables all text/TTS providers; it makes no model calls.
 * --gateway-state <stack.json> temporarily attaches the actual running company gateway to the isolated data root.
 * The app resolves script credentials only from SQLite. The isolated row is populated while running,
 * then cleared with secure_delete and a WAL checkpoint after the isolated server stops.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';

const args = process.argv.slice(2), arg = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const localOnly = args.includes('--local-only');
assert(!(localOnly && arg('--model')), '本地核查不能同时选择外部模型');
const repository = fs.realpathSync(process.cwd());
const source = fs.realpathSync(arg('--source')), audit = fs.realpathSync(arg('--audit'));
const baseline = JSON.parse(fs.readFileSync(path.join(audit, 'summary.json'), 'utf8'));
assert.equal(baseline.scripts, 300); assert.equal(baseline.videoFiles, 257); assert.equal(baseline.source, source);
const expectedFiles = JSON.parse(fs.readFileSync(path.join(audit, 'files.json'), 'utf8'));
const resume = arg('--resume');
const root = resume ? path.dirname(fs.realpathSync(resume)) : path.join(repository, 'outputs', 'formula-ps866', `acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`);
assert(root.startsWith(path.join(repository, 'outputs', 'formula-ps866') + path.sep));
fs.mkdirSync(root, { recursive: true });
const stateFile = path.join(root, 'state.json');
const state = resume ? JSON.parse(fs.readFileSync(resume, 'utf8')) : { root, source, audit, projectId: 'ps866-real-acceptance', batchId: null, phase: 'initializing' };
assert.equal(state.root, root); assert.equal(state.source, source);
const checkpoint = (phase, more = {}) => { Object.assign(state, more, { phase }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); console.log(JSON.stringify({ phase, ...more })); };
const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const childEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_FORMULA_MIXCUT: '1' };
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(repository, false, { info() {}, error() {} });
let model;
if (!localOnly) {
  const originalDb = new Database(path.join(repository, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
  try { model = originalDb.prepare('SELECT * FROM script_providers WHERE id=? AND enabled=1').get(arg('--model')); }
  finally { originalDb.close(); }
  assert(model, '请选择已有配置的脚本模型');
}
const credential = model?.apiKey?.trim() || (model?.keyEnv ? process.env[model.keyEnv]?.trim() : '');
assert(localOnly || credential, '所选脚本模型尚未配置密钥');
const importedModel = model ? { ...model, apiKey: credential, keyEnv: '',
  baseUrl: model.baseUrl?.trim() || process.env[model.baseUrlEnv] || model.defaultBaseUrl,
  model: model.model?.trim() || process.env[model.modelEnv] || model.defaultModel, baseUrlEnv: '', modelEnv: '' } : undefined;
let server, browser, db, page; const logs = [];
const temporaryRuntimeFiles = [];
const safe = value => credential ? String(value).replaceAll(credential, '[REDACTED]') : String(value);
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离服务未退出')), 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
async function start() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [standalone], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...childEnv, HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
  server.stdout.on('data', chunk => logs.push(String(chunk))); server.stderr.on('data', chunk => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    const response = await fetch(`${base}/api/batch-production/readiness`).catch(() => null);
    if (response?.ok && (await response.json()).formula?.available) return base;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离服务启动超时');
}
async function fingerprint(filename) {
  const digest = createHash('sha256'); for await (const bytes of fs.createReadStream(filename)) digest.update(bytes); return digest.digest('hex');
}
try {
  if (model?.executionScope === 'company') {
    const gatewayState = fs.realpathSync(arg('--gateway-state'));
    assert(gatewayState.startsWith(path.join(repository, 'outputs', 'formula-ps866') + path.sep));
    const running = JSON.parse(fs.readFileSync(gatewayState, 'utf8'));
    assert.equal(new URL(importedModel.baseUrl).origin, `http://127.0.0.1:${running.proxyPort}`);
    process.kill(running.litellmPid, 0);
    assert((await fetch(`http://127.0.0.1:${running.proxyPort}/health/liveliness`, { signal: AbortSignal.timeout(5000) })).ok);
    fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
    for (const [from, to] of [[path.join(repository, 'config.yaml'), path.join(root, 'config.yaml')],
      [gatewayState, path.join(root, 'storage', 'run', 'stack.json')]]) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); temporaryRuntimeFiles.push(to);
    }
  }
  checkpoint('initializing'); await start(); await stop();
  db = new Database(path.join(root, 'data', 'workbench.db')); db.pragma('foreign_keys=ON');
  db.exec("UPDATE script_providers SET enabled=0,apiKey=''; UPDATE final_edit_tts_providers SET enabled=0,apiKey='',keyEnv='';");
  if (importedModel) {
    const columns = db.prepare('PRAGMA table_info(script_providers)').all().map(item => item.name).filter(name => Object.hasOwn(importedModel, name));
    db.prepare(`INSERT INTO script_providers (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${columns.filter(name => name !== 'id').map(name => `"${name}"=excluded."${name}"`).join(',')}`)
      .run(...columns.map(name => importedModel[name]));
  }
  db.prepare("INSERT OR IGNORE INTO providers (id,name,baseUrl,model,type) VALUES ('acceptance-images','验收占位（不调用）','http://127.0.0.1:1','unused','openai-compatible')").run();
  db.prepare("INSERT OR IGNORE INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES (?,'PS866 实拍验收','acceptance-images','unused','','complex_product','PS866')").run(state.projectId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE projectId=?').get(state.projectId).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shot_sets WHERE projectId=?').get(state.projectId).n, 0);
  db.close(); db = undefined;
  let base = await start(); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' }); page.setDefaultTimeout(30_000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(safe(error.message)));
  const pageUrl = () => `${base}/projects/${state.projectId}?tab=final-edit&mixcut=batch${state.batchId ? `&batch=${state.batchId}` : ''}`;
  const endpoint = suffix => `${base}/api/batch-production/batches/${state.batchId}/formula/${suffix}?projectId=${state.projectId}`;
  await page.goto(pageUrl());
  if (!state.batchId) {
    await page.getByLabel('新批次名称').fill('PS866 首批 8 条');
    await page.getByRole('radio', { name: /^实拍公式混剪/ }).check();
    const created = page.waitForResponse(response => response.url().includes('/api/batch-production/batches') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    const response = await created; assert.equal(response.status(), 201, await response.text());
    const body = await response.json(); checkpoint('batch_created', { batchId: body.batch?.id ?? body.id ?? body.batchId });
    assert(state.batchId); await expect(page.getByLabel('选择实拍文件夹')).toBeEnabled();
  }
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  let index = await (await fetch(endpoint('materials'))).json();
  if (index.bindings?.length !== 257) {
    checkpoint('uploading_real_videos', { existingBindings: index.bindings?.length ?? 0 });
    await page.getByLabel('选择实拍文件夹').setInputFiles(path.join(source, '预处理'));
    let last = -1;
    await expect.poll(async () => {
      index = await (await fetch(endpoint('materials'))).json();
      const count = index.bindings?.length ?? 0; if (count !== last) { console.log(`已导入真实视频 ${count}/257`); last = count; }
      return count;
    }, { timeout: 300_000, intervals: [1000, 2000, 5000] }).toBe(257);
    await expect(page.getByLabel('选择实拍文件夹')).toBeEnabled({ timeout: 30_000 });
  }
  checkpoint('videos_imported', { bindings: index.bindings.length });
  for (const entry of expectedFiles) {
    const original = path.join(source, '预处理', entry.relativePath), stat = fs.statSync(original);
    assert.equal(stat.size, entry.bytes); assert.equal(stat.mtime.toISOString(), entry.modifiedAt);
    const binding = index.bindings.find(item => item.sourcePath === `预处理/${entry.relativePath}` || item.sourcePath === entry.relativePath);
    assert(binding, `未保留来源：${entry.relativePath}`); assert.equal(binding.available, true);
    assert.equal(binding.contentFingerprint.replace(/^sha256:/, ''), await fingerprint(original));
  }
  assert.equal(index.bindings.filter(item => item.excludedReason === 'preview').length, 1);
  assert.equal(index.bindings.filter(item => !item.logicalCode).length, 1);
  fs.writeFileSync(path.join(root, 'imported-media.json'), JSON.stringify(index, null, 2));
  await page.getByRole('heading', { name: '导入实拍视频', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'materials-light.png') });
  async function importBook(kind, name, count) {
    const inputs = await (await fetch(endpoint('imports'))).json();
    if (inputs[kind]?.rows?.length === count) {
      if (localOnly) return;
      // A previous local-header import is not evidence that the real model ran.
      const check = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true });
      try {
        const row = check.prepare("SELECT extractionJson FROM batch_formula_import_sessions WHERE id=? AND state='confirmed'").get(inputs[kind].sessionId);
        const extraction = row?.extractionJson ? JSON.parse(row.extractionJson) : null;
        if (extraction?.state === 'completed' && extraction.providerId === model.id && extraction.model === importedModel.model) return;
      } finally { check.close(); }
    }
    checkpoint(`importing_${kind}`);
    const label = kind === 'materials' ? '素材命名表' : '脚本表';
    const picker = page.getByLabel(`选择${label}`, { exact: true });
    await expect(picker).toBeEnabled();
    const uploaded = page.waitForResponse(response => response.url().includes('/formula/imports?') && response.request().method() === 'POST');
    await picker.setInputFiles(path.join(source, name));
    const uploadResult = await uploaded;
    assert.equal(uploadResult.status(), 201);
    const opened = (await (await fetch(endpoint('imports'))).json()).drafts.find(item => item.kind === kind);
    assert(opened);
    if (!localOnly && opened.extraction?.state === 'failed') {
      await page.getByRole('button', { name: '重新用 AI 识别', exact: true }).click();
    }
    const confirm = page.getByRole('button', { name: `确认导入 ${count} 条`, exact: true });
    await expect(confirm).toBeEnabled({ timeout: 240_000 });
    const draft = (await (await fetch(endpoint('imports'))).json()).drafts.find(item => item.kind === kind);
    assert(draft); assert.equal(draft.preview.rowCount, count); assert.equal(draft.preview.rows.length, count);
    fs.writeFileSync(path.join(root, `${kind}-preview.json`), JSON.stringify(draft, null, 2));
    if (localOnly) assert.equal(draft.preview.extraction, 'local_headers');
    else assert.equal(draft.extraction?.state, 'completed', `真实模型未完成 ${kind} 表头识别；已保留预览，请检查后继续`);
    await confirm.click();
    await expect.poll(async () => (await (await fetch(endpoint('imports'))).json())[kind]?.sessionId).toBe(draft.id);
    assert.equal((await (await fetch(endpoint('imports'))).json())[kind]?.rows?.length, count);
  }
  await importBook('materials', 'PS866素材命名表格.xlsx', 268);
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  await importBook('scripts', 'PS866-300条视频脚本.xlsx', 300);
  const settings = page.getByRole('region', { name: '生成设置', exact: true });
  await settings.getByRole('button', { name: '取消全选', exact: true }).click();
  const sampleNumbers = ['1', '2', '141', '142', '241', '242', '291', '292'];
  const show = settings.getByRole('button', { name: /查看全部/ }); if (await show.count()) await show.click();
  for (const number of sampleNumbers) await settings.getByRole('checkbox', { name: `选择脚本 ${number}`, exact: true }).check();
  await settings.getByRole('radio', { name: '不加音乐', exact: true }).check();
  await settings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  const selected = await (await fetch(endpoint('settings'))).json(); assert.equal(selected.saved.totalCopies, 8);
  fs.writeFileSync(path.join(root, 'selected-settings.json'), JSON.stringify(selected, null, 2));
  const collapse = settings.getByRole('button', { name: '收起', exact: true }); if (await collapse.count()) await collapse.click();
  await settings.getByText('已选 8 条脚本，共 8 份', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'scripts-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(root, 'scripts-dark.png') });
  await page.reload(); await expect(page.getByRole('button', { name: '脚本与口播', exact: true })).toBeVisible();
  const frozenBefore = await (await fetch(endpoint('settings'))).json();
  await stop(); base = await start(); await page.goto(pageUrl());
  assert.deepEqual((await (await fetch(endpoint('settings'))).json()).saved, frozenBefore.saved);
  const finalInputs = await (await fetch(endpoint('imports'))).json(); assert.equal(finalInputs.scripts.rows.length, 300);
  fs.writeFileSync(path.join(root, 'confirmed-inputs.json'), JSON.stringify(finalInputs, null, 2));
  assert.deepEqual(pageErrors, []);
  checkpoint('inputs_ready_voice_service_pending', { sampleNumbers, importedVideos: 257, materialRows: 268, scriptRows: 300,
    provider: model ? { id: model.id, name: model.name, model: importedModel.model } : null,
    extractionMode: localOnly ? 'local_headers' : 'real_model', error: null, sourceFingerprintsChecked: 257, restartPassed: true });
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(root, 'attention.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(root, 'attention.txt'), safe(await page.locator('body').innerText().catch(() => '页面已关闭')));
  }
  checkpoint('needs_attention', { error: safe(error instanceof Error ? error.message : error) });
  process.exitCode = 1;
} finally {
  await browser?.close(); await stop(); db?.close();
  for (const filename of temporaryRuntimeFiles) fs.unlinkSync(filename);
  const proofDb = path.join(root, 'data', 'workbench.db');
  if (fs.existsSync(proofDb)) {
    const cleanup = new Database(proofDb);
    try {
      cleanup.pragma('secure_delete=ON');
      cleanup.prepare("UPDATE script_providers SET apiKey='' WHERE trim(apiKey)<>''").run();
      cleanup.pragma('wal_checkpoint(TRUNCATE)');
      assert.equal(cleanup.prepare("SELECT count(*) AS n FROM script_providers WHERE trim(apiKey)<>''").get().n, 0);
    } finally { cleanup.close(); }
  }
  fs.writeFileSync(path.join(root, 'server.log'), safe(logs.join('')));
  console.log(`验收数据保留：${root}`);
}
