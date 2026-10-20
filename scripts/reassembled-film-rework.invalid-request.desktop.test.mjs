// Final-build negative acceptance. Reuses an isolated fixture read-only except its private run state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_P2_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-p2') && fixture.root.includes('reassembled-P1-'));
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const db = new Database(path.join(fixture.root, 'data/workbench.db'), { readonly: true });
const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId);
const clipId = JSON.parse(binding.candidatesJson)[0].clipId;
const counts = () => ['jobs', 'video_jobs', 'final_edit_film_reworks'].map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
const before = counts();
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE']) delete env[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-p2-negative')}`], cwd: appRoot, env, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const processHandle = app.process(); let state;
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.minimize(); });
  state = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  const endpoint = `/api/final-edit-groups/${binding.groupId}/rework/${clipId}`;
  const current = await (await page.request.get(state.origin + endpoint)).json();
  for (const identity of [{}, { requestId: null }, { requestId: 123456789 }, { requestId: {} }]) {
    const result = await page.evaluate(async ({ endpoint, body }) => {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    }, { endpoint, body: { ...identity, expectedRevision: current.revision, type: 'generate_image', providerId: 'p1-fixture', model: 'synthetic-image', prompt: 'invalid identity must prevent submission', inputImageId: current.sourceImageId, referenceImageIds: [], size: '1024x1024', quality: 'standard' } });
    assert.equal(result.status, 400); assert.equal(result.body.error, 'film_rework_invalid');
  }
  assert.deepEqual(counts(), before);
  assert.equal((await (await page.request.get(state.origin + endpoint)).json()).revision, current.revision);
  fs.writeFileSync(path.join(fixture.root, 'p2-invalid-request-result.json'), JSON.stringify({ ok: true, appRoot, rejected: 4, noJobCreated: true, revisionUnchanged: true }, null, 2));
  console.log('PASS actual desktop rejects missing/non-string request identity without creating any job');
} finally {
  if (state) await fetch(state.origin + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  const deadline = Date.now() + 25000;
  while (processHandle.exitCode === null && processHandle.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
  db.close();
}
assert.equal(processHandle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')));
