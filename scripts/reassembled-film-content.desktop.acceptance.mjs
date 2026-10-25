// Uses only an isolated synthetic fixture. Real Electron UI and fixed-render export; no providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_CONTENT_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-complete') && fixture.root.includes('reassembled-P1-'));
const evidence = path.join(fixture.root, process.env.FILM_CONTENT_EVIDENCE || 'content-desktop'); fs.mkdirSync(evidence);
const db = new Database(path.join(fixture.root, 'data/workbench.db'));
db.prepare("UPDATE final_edit_jobs SET status='cancelled' WHERE status IN ('queued','running')").run();
db.prepare("DELETE FROM final_edit_film_deliveries WHERE status='reserved'").run();
const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const oldHashes = fs.readdirSync(fixture.delivery).filter(name => /\.(mp4|jpg)$/.test(name)).map(name => [name, hash(path.join(fixture.delivery, name))]);
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const appEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath,
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete appEnv[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-content')}`], cwd: appRoot, env: appEnv, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const processHandle = app.process();
let ownedState;
const waitFor = async (predicate, timeout = 90000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('Acceptance timed out'); };
try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.minimize(); });
  ownedState = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  const get = async url => (await page.request.get(ownedState.origin + url)).json();
  const groupUrl = `/api/final-edit-groups/${binding.groupId}`;
  const url = `${ownedState.origin}/projects/${binding.projectId}?tab=final-edit&filmGroup=${binding.groupId}&filmShotSet=${binding.shotSetId}`;
  await page.goto(url); await page.getByTestId('film-editor').waitFor({ timeout: 60000 });
  const before = await get(groupUrl);
  const classic = before.reassembled.template === 'classic';
  const titleLabel = classic ? '封面标题 1' : '主标题', subtitleLabel = classic ? '封面标题 2' : '副标题';
  const targetTemplate = classic ? 'classic' : 'overlay-minimal';
  const titleOf = content => content.decoration.template === 'classic' ? content.decoration.cover.title[0] : content.decoration.packaging.varsOverrides.title;
  const setTitle = (content, title) => { if (content.decoration.template === 'classic') content.decoration.cover.title[0] = title; else content.decoration.packaging.varsOverrides.title = title; };
  if (process.env.FILM_CONTENT_PROPOSALS === '1') {
    const cli = (...args) => JSON.parse(execFileSync(appEnv.CREATIVE_STUDIO_NODE, [path.join(appRoot, 'scripts/reassembled-workbench.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
    const state = cli('current', fixture.root, binding.groupId);
    assert.equal(state.revision, before.variants[0].revision);
    const content = structuredClone(state.content); setTitle(content, '来自对话的标题提案');
    const request = { requestId: randomUUID(), expectedRevision: state.revision, summary: '只修改标题，保留当前镜头和字幕', content };
    const file = path.join(evidence, 'proposal.json'); fs.writeFileSync(file, JSON.stringify(request));
    const proposed = cli('propose', fixture.root, binding.groupId, file);
    assert.deepEqual(cli('propose', fixture.root, binding.groupId, file), proposed);
    assert.equal(cli('current', fixture.root, binding.groupId).revision, state.revision);
    const capability = await get('/api/reassembled-films/capabilities');
    const denied = await page.request.patch(`${ownedState.origin}/api/final-edit-variants/${binding.variantId}`, { headers: { 'x-reassembled-token': fs.readFileSync(path.join(fixture.root, 'storage/run/reassembled-agent-token'), 'utf8').trim(), 'x-desktop-instance': capability.instanceId, 'x-data-identity': capability.dataIdentity }, data: { type: 'set_film_content', expectedRevision: state.revision, content } });
    assert.equal(denied.status(), 409);
    await page.reload(); await page.getByTestId('film-editor').waitFor();
    await page.getByRole('button', { name: '查看并编辑提案', exact: true, disabled: false }).click();
    assert.equal(await page.getByLabel(titleLabel, { exact: true }).inputValue(), '来自对话的标题提案');
    await page.getByRole('button', { name: '保存成片内容', exact: true }).click();
    await page.getByRole('region', { name: '成片内容编辑', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(cli('current', fixture.root, binding.groupId).proposals.find(p => p.id === proposed.id).status, 'applied');
    // Continue ordinary UI acceptance from the adopted revision.
    Object.assign(before, await get(groupUrl));
  }
  const open = () => page.getByRole('button', { name: '编辑包装、字幕与音乐', exact: true }).click();
  await open(); await page.getByLabel(titleLabel, { exact: true }).fill('应被取消');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  assert.equal((await get(groupUrl)).variants[0].revision, before.variants[0].revision);
  await open(); await page.getByLabel(titleLabel, { exact: true }).fill('未保存的人工草稿');
  // Another human tab saves while this draft remains open.
  const otherContent = structuredClone(before.reassembled.content); setTitle(otherContent, '另一窗口已保存');
  const concurrent = await page.evaluate(async ({ variantId, revision, content }) => { const response = await fetch(`/api/final-edit-variants/${variantId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'set_film_content', expectedRevision: revision, content }) }); return response.status; }, { variantId: binding.variantId, revision: before.variants[0].revision, content: otherContent });
  assert.equal(concurrent, 200);
  await page.getByRole('button', { name: '保存成片内容', exact: true }).click();
  await page.getByTestId('film-message').filter({ hasText: '草稿已被其他操作更新' }).waitFor();
  assert.equal(await page.getByLabel(titleLabel, { exact: true }).inputValue(), '未保存的人工草稿');
  assert.equal(titleOf((await get(groupUrl)).reassembled.content), '另一窗口已保存');
  await page.getByRole('button', { name: '取消修改', exact: true }).click(); await open();
  await page.getByLabel(titleLabel, { exact: true }).fill('桌面内容编辑验收');
  await page.getByLabel(subtitleLabel, { exact: true }).fill('保留人工修改与其他镜头');
  if (!classic) await page.getByLabel('包装模板', { exact: true }).selectOption(targetTemplate);
  const tracked = classic ? before.reassembled.content.decoration.callouts.findIndex(c => c.dotKeyframes?.length) : -1;
  if (tracked >= 0) {
    const cue = before.reassembled.content.decoration.callouts[tracked];
    await page.getByLabel(`标注 ${tracked + 1} 圆点 X`, { exact: true }).fill(String(cue.dot[0] + 10));
    await page.getByLabel(`标注 ${tracked + 1} 开始帧`, { exact: true }).fill(String(cue.startFrame + 2));
    await page.getByLabel(`标注 ${tracked + 1} 结束帧`, { exact: true }).fill(String(cue.endFrame - 2));
  }
  await page.getByRole('button', { name: '字幕', exact: true }).click();
  await page.getByLabel('字幕 1', { exact: true }).fill('桌面保存的新字幕');
  await page.getByRole('button', { name: '音乐', exact: true }).click();
  await page.getByLabel('音乐音量（dB）', { exact: true }).fill('-18');
  await page.screenshot({ path: path.join(evidence, 'content-draft.png'), fullPage: true });
  await page.getByRole('button', { name: '保存成片内容', exact: true }).click();
  await page.getByRole('region', { name: '成片内容编辑', exact: true }).waitFor({ state: 'hidden' });
  const edited = await get(groupUrl);
  assert.deepEqual(edited.variants[0].timeline.clips, before.variants[0].timeline.clips);
  assert.equal(edited.subtitleCues[0].text, '桌面保存的新字幕');
  assert.equal(edited.reassembled.template, targetTemplate);
  if (tracked >= 0) {
    const original = before.reassembled.content.decoration.callouts[tracked];
    const changed = edited.reassembled.content.decoration.callouts[tracked];
    assert.equal(changed.startFrame, original.startFrame + 2);
    assert.equal(changed.endFrame, original.endFrame - 2);
    assert.deepEqual(changed.dot, changed.dotKeyframes[0].dot);
    assert.equal(changed.dotKeyframes.at(-1).frame, changed.endFrame - 1);
    assert.deepEqual(changed.pill, original.pill);
    assert.ok(changed.dot[0] >= original.dot[0] + 10);
  }
  await page.reload(); await page.getByTestId('film-editor').waitFor(); await open();
  assert.equal(await page.getByLabel(classic ? titleLabel : '主标题', { exact: true }).inputValue(), '桌面内容编辑验收');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本（含当前包装）', exact: true }).click();
  const completed = await waitFor(async () => { const jobs = (await get(groupUrl)).jobs.filter(j => j.kind === 'render' && j.renderRevision?.variantRevision === edited.variants[0].revision); const failed = jobs.find(j => j.status === 'failed'); assert.ok(!failed, failed?.errorMessage); return jobs.find(j => j.status === 'succeeded'); }, 600000);
  const output = await get(`/api/final-edit-jobs/${completed.id}`);
  const runDir = path.join(fixture.root, 'storage', path.dirname(output.output.videoRelativePath));
  const rendered = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
  assert.equal(rendered.template.id, targetTemplate);
  assert.equal(classic ? rendered.classic.cover.title[0] : rendered.packaging.varsOverrides.title, '桌面内容编辑验收');
  assert.equal(rendered.subtitles[0].text, '桌面保存的新字幕');
  assert.equal(rendered.audio.music.gainDb, -18);
  if (tracked >= 0) {
    const saved = structuredClone(edited.reassembled.content.decoration.callouts[tracked]);
    const imported = JSON.parse(binding.specJson);
    const delta = rendered.shots.find(s => s.id === saved.shot).startFrame - imported.shots.find(s => s.id === saved.shot).startFrame;
    saved.startFrame += delta; saved.endFrame += delta;
    saved.dotKeyframes.forEach(k => { k.frame += delta; });
    assert.deepEqual(rendered.classic.callouts[tracked], saved);
  }
  const checks = JSON.parse(fs.readFileSync(path.join(runDir, 'checks.json'), 'utf8')); assert.equal(checks.ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'render-manifest.json'), 'utf8'));
  for (const file of [manifest.tools.runtime.packagingDir, manifest.tools.runtime.node, manifest.tools.runtime.chrome, ...Object.values(manifest.tools.paths)]) {
    const relative = path.relative(appRoot, file); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Tool must belong to tested application: ${file}`);
  }
  for (const [name, fingerprint] of oldHashes) assert.equal(hash(path.join(fixture.delivery, '旧版', name)), fingerprint);
  assert.equal(hash(path.join(fixture.delivery, output.output.videoFilename)), manifest.outputs.videoSha256);
  await page.getByRole('button', { name: '取消导出任务', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  // Minimized Electron can finish every business assertion yet stall capturing
  // the compositor. Record this evidence limitation without reclassifying a
  // verified delivery as failed; media/checks/hash assertions above remain hard.
  const screenshotError = await page.screenshot({ path: path.join(evidence, 'delivery.png'), fullPage: true, timeout: 10000 }).then(() => null, error => String(error));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, fixture, appRoot, template: targetTemplate, trackingEdited: tracked >= 0, proposalProtocol: process.env.FILM_CONTENT_PROPOSALS === '1', oldHashes, runtimeToolsOwned: true, paidCalls: 0, cancelledDraftPreserved: true, staleDraftPreserved: true, reopenPersists: true, otherClipsUnchanged: true, screenshotError, checks: checks.checks, output: output.output }, null, 2));
  console.log('PASS actual content UI, cancel, concurrent draft conflict, reload, template switch, subtitle/music edits and packaged delivery');
} catch (error) {
  const page = app.windows()[0]; if (page) { console.log((await page.locator('body').innerText().catch(() => '')).slice(-5000)); await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {}); } throw error;
} finally {
  if (ownedState) await fetch(`${ownedState.origin}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  await waitFor(() => processHandle.exitCode !== null || processHandle.signalCode !== null, 25000).catch(() => processHandle.kill('SIGKILL'));
  db.close();
}
assert.equal(processHandle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')));
