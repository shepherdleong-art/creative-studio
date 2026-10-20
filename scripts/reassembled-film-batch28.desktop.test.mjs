// Actual selection from a 28-film overview; all source media are synthetic reused test fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_BATCH_FIXTURE, 'utf8'));
assert.ok(fixture.ok && fixture.paidCalls === 0 && fixture.root.includes('2026-10-19-film-batch28'));
const { root, production } = fixture;
assert.equal(production.films.length, 28);
const target = production.films.find(f => f.key === '17'), foreign = production.films.find(f => f.key === '18');
assert.ok(target && foreign);
const evidence = fs.mkdtempSync(path.join(root, 'batch28-desktop-'));
const db = new Database(path.join(root, 'data/workbench.db'), { readonly: true });
const protectedSnapshot = () => JSON.stringify({
  variants: db.prepare('SELECT * FROM final_edit_variants WHERE id<>? ORDER BY id').all(target.variantId),
  revisions: db.prepare('SELECT * FROM final_edit_revisions WHERE scopeId<>? ORDER BY scopeKind,scopeId,revision').all(target.variantId),
  groups: db.prepare('SELECT * FROM final_edit_groups ORDER BY id').all(),
  shots: db.prepare('SELECT * FROM shots ORDER BY id').all(),
  images: db.prepare('SELECT * FROM image_assets ORDER BY id').all(),
  jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
  videos: db.prepare('SELECT * FROM video_jobs ORDER BY id').all(),
  bindings: db.prepare('SELECT * FROM final_edit_film_bindings ORDER BY id').all(),
  deliveries: db.prepare('SELECT * FROM final_edit_film_deliveries ORDER BY bindingId,version').all(),
});
const beforeProtected = protectedSnapshot();
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_NODE: process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath,
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete env[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(evidence, 'electron')}`], cwd: appRoot, env, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const handle = app.process();
const wait = async (predicate, timeout = 90000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('Acceptance timed out'); };
let state, result;
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  state = JSON.parse(fs.readFileSync(path.join(root, 'storage/run/electron-service.json'), 'utf8'));
  const get = async url => { const response = await page.request.get(state.origin + url); assert.ok(response.ok()); return response.json(); };
  const groupUrl = `/api/final-edit-groups/${target.groupId}`;
  const before = await get(groupUrl), foreignGroup = await get(`/api/final-edit-groups/${foreign.groupId}`);
  await page.goto(`${state.origin}/projects/${production.projectId}?tab=final-edit`);
  const overview = page.getByRole('region', { name: '实拍重组制作进度', exact: true });
  await overview.waitFor({ timeout: 60000 });
  assert.equal(await overview.locator('details').count(), 28);
  assert.equal(await overview.locator('summary').filter({ hasText: '成片可编辑' }).count(), 28);
  const card = overview.getByTestId('production-17');
  await card.locator('summary').click();
  assert.match(await card.locator('summary').innerText(), /17.*第 17 条/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => { w.restore(); w.showInactive(); }));
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'overview-17.png'), timeout: 15000 });
  await card.getByRole('link', { name: '编辑这条成片', exact: true }).click();
  await page.getByTestId('film-editor').waitFor({ timeout: 60000 });
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('filmGroup'), target.groupId);
  assert.equal(url.searchParams.get('filmShotSet'), target.shotSetId);
  assert.equal(url.pathname, `/projects/${production.projectId}`);
  assert.ok(await page.getByRole('heading', { name: `实拍成片 · ${target.title}`, exact: true }).isVisible());
  await page.getByRole('link', { name: '返回成片总览（28 条）', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '实拍重组制作进度', exact: true }).count(), 0);
  const editorInViewport = await page.getByTestId('film-editor').evaluate(element => {
    const box = element.getBoundingClientRect(); return box.top < window.innerHeight && box.bottom > 0;
  });
  assert.ok(editorInViewport, 'Selecting film 17 must reveal its editor without scrolling past 28 overview cards');
  const expectedIds = new Set(before.reassembled.candidates.map(c => c.videoJobId));
  assert.deepEqual(new Set(before.assets.map(a => a.videoJobId)), expectedIds);
  assert.ok(foreignGroup.assets.every(a => !expectedIds.has(a.videoJobId)), 'Other film assets must not enter the selected film');
  const clip = before.variants[0].timeline.clips[0], foreignClip = foreignGroup.variants[0].timeline.clips[0];
  const rejected = await page.evaluate(async ({ id, command }) => {
    const response = await fetch(`/api/final-edit-variants/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  }, { id: target.variantId, command: { type: 'replace_clip', expectedRevision: before.variants[0].revision, clipId: clip.id,
    videoJobId: foreignClip.videoJobId, sourceFingerprint: foreignClip.sourceFingerprint, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame } });
  assert.ok([400, 409].includes(rejected.status));
  assert.deepEqual((await get(groupUrl)).variants, before.variants);
  await page.getByRole('button', { name: '编辑包装、字幕与音乐', exact: true }).click();
  const title = process.env.FILM_DESKTOP_APP_ROOT ? '第17条免安装人工修改' : '第17条源码人工修改';
  await page.getByLabel('主标题', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存成片内容', exact: true }).click();
  await page.getByRole('region', { name: '成片内容编辑', exact: true }).waitFor({ state: 'hidden' });
  const alternative = before.reassembled.candidates.find(c => c.clipId === clip.id && c.videoJobId !== clip.videoJobId);
  assert.ok(alternative);
  await page.getByLabel('已有候选', { exact: true }).selectOption(alternative.videoJobId);
  await page.getByRole('button', { name: '替换镜头', exact: true }).click();
  await wait(async () => (await get(groupUrl)).variants[0].timeline.clips[0].videoJobId === alternative.videoJobId);
  const after = await get(groupUrl);
  assert.equal(after.variants[0].revision, before.variants[0].revision + 2);
  assert.equal(after.reassembled.content.decoration.packaging.varsOverrides.title, title);
  assert.deepEqual(after.variants[0].timeline.clips.slice(1), before.variants[0].timeline.clips.slice(1));
  assert.equal(protectedSnapshot(), beforeProtected, 'Other 27 films, all source records and deliveries remain byte-for-byte unchanged');
  await page.reload(); await page.getByTestId('film-editor').waitFor();
  assert.deepEqual((await get(groupUrl)).variants, after.variants);
  await page.screenshot({ path: path.join(evidence, 'editor-17.png'), timeout: 15000 });
  await page.getByRole('link', { name: '返工这个镜头', exact: true }).click();
  for (const step of ['storyboard', 'video']) {
    if (step === 'video') await page.getByRole('link', { name: '生成该镜头视频', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('tab') === step);
    await page.getByTestId('film-rework').waitFor();
    await page.getByRole('link', { name: '返回成片总览（28 条）', exact: true }).waitFor();
    const location = new URL(page.url());
    assert.equal(location.searchParams.get('filmGroup'), target.groupId);
    assert.equal(location.searchParams.get('filmClip'), clip.id);
    assert.equal(location.searchParams.get('tab'), step);
    assert.equal(await page.getByRole('region', { name: '实拍重组制作进度', exact: true }).count(), 0);
    assert.ok(await page.getByTestId('film-rework').evaluate(element => { const box = element.getBoundingClientRect(); return box.top < window.innerHeight && box.bottom > 0; }), 'Target upstream panel must be visible');
  }
  await page.getByRole('link', { name: '返回第五步替换镜头', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('tab') === 'final-edit');
  await page.getByTestId('film-editor').waitFor();
  assert.equal(protectedSnapshot(), beforeProtected);
  assert.deepEqual((await get(groupUrl)).variants, after.variants);
  result = { ok: true, paidCalls: 0, root, appRoot, filmCount: 28, selectedKey: '17', targetGroupId: target.groupId, targetShotSetId: target.shotSetId,
    selectedFromOverview: true, editorInViewport: true, upstreamPanelsInViewport: true, wrongFilmAssetRejected: true, onlyTargetChanged: true, other27Protected: true,
    protectedStateSha256: createHash('sha256').update(beforeProtected).digest('hex'), oldRevision: before.variants[0].revision, newRevision: after.variants[0].revision,
    syntheticMediaReusedForNavigationTest: true, newRenders: 0 };
} catch (error) {
  const page = app.windows()[0]; if (page) { fs.writeFileSync(path.join(evidence, 'failure-ui.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {}); }
  throw error;
} finally {
  if (state) {
    const health = await fetch(state.origin + '/api/desktop/health').then(r => r.json()).catch(() => null);
    if (health?.instanceId === state.instanceId) await fetch(state.origin + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  await wait(() => handle.exitCode !== null || handle.signalCode !== null, 30000).catch(() => handle.kill('SIGKILL'));
  db.close();
}
assert.equal(handle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(root, 'storage/run/electron-service.json')));
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log('PASS 28-film overview, actual card 17 navigation, isolated manual edit and protected other 27', evidence);
