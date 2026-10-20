// Read-only follow-up of a successful desktop run; does not enqueue another render.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const previousFile = path.resolve(process.env.FILM_EDITING_RESULT);
assert.ok(previousFile.includes('2026-10-19-film-editing'));
const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
assert.equal(previous.ok, true);
const { fixture, appRoot } = previous;
const evidence = fs.mkdtempSync(path.join(fixture.root, 'editing-reopen-'));
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.execPath, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete env[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-reopen')}`], cwd: appRoot, env, timeout: 60000 });
const handle = app.process(); let state;
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  state = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  const groupUrl = `${state.origin}/api/final-edit-groups/${fixture.groupId}`;
  const before = await (await page.request.get(groupUrl)).json();
  await page.goto(`${state.origin}/projects/${before.projectId}?tab=final-edit&filmGroup=${fixture.groupId}&filmShotSet=${fixture.shotSetId}`);
  await page.getByTestId('film-editor').waitFor();
  assert.equal(before.variants[0].timeline.clips[0].playbackRate, 2);
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByText('当前修改已导出', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('button', { name: '取消导出任务', exact: true }).count(), 0);
  const after = await (await page.request.get(groupUrl)).json();
  assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.variants, before.variants);
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.restore(); window.showInactive(); } });
  await page.screenshot({ path: path.join(evidence, 'completed.png'), fullPage: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, previousFile, completedStatusVisible: true, noNewRender: true }, null, 2));
} finally {
  if (state) await fetch(state.origin + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (handle.exitCode === null && handle.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 300));
  if (handle.exitCode === null && handle.signalCode === null) handle.kill('SIGKILL');
}
assert.equal(handle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')));
console.log('PASS reopened completed export, no new render', evidence);
