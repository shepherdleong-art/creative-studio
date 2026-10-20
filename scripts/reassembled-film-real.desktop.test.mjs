// Real historical media, fresh project/data and actual CLI/Electron. No supplier requests.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture = read(process.env.FILM_REAL_FIXTURE);
const { root, project, dataRoot } = fixture;
assert.ok(root.includes('2026-10-19-real-handoff') && fixture.historicalReuse && fixture.paidCalls === 0);
assert.ok(!fs.existsSync(path.join(root, 'handoff-result.json')));
const beginFile = path.join(root, 'begin.json'), syncFile = path.join(root, 'sync.json'), sync = read(syncFile);
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const { getDb, closeDb } = await import('../lib/db.ts');
const setup = getDb();
for (const task of sync.snapshot.tasks) {
  if (task.kind === 'scene' || task.kind === 'shot') setup.prepare("INSERT OR IGNORE INTO providers(id,name,type,baseUrl,apiKey,model,enabled) VALUES (?,?,'openai','http://127.0.0.1:1','',?,0)").run(task.providerId, '历史真实来源（本轮禁用提交）', task.model);
  if (task.kind === 'video') setup.prepare("INSERT OR IGNORE INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled) VALUES (?,?,'openai-video','','','',?,0)").run(task.providerId, '历史真实来源（本轮禁用提交）', task.model);
}
closeDb();
const db = new Database(path.join(dataRoot, 'data/workbench.db'), { readonly: true });
const exec = promisify(execFile), appRoot = path.resolve('.');
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot, CREATIVE_STUDIO_NODE: process.execPath, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE']) delete env[key];
const cli = async (...args) => JSON.parse((await exec(process.execPath, ['scripts/reassembled-workbench.mjs', ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 })).stdout);
const offline = await cli('doctor', dataRoot).then(() => null, error => error);
assert.ok(offline && offline.code === 1 && /请先安装或启动桌面版/.test(offline.stderr));
save(path.join(root, 'doctor-offline.json'), { ok: true, rejected: true, message: offline.stderr.trim() });
const wait = async (predicate, timeout = 90000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('Acceptance timed out'); };
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(root, 'electron')}`], cwd: appRoot, env, timeout: 60000 });
const handle = app.process(); let state, result;
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  state = read(path.join(dataRoot, 'storage/run/electron-service.json'));
  const identity = await cli('doctor', dataRoot); assert.ok(identity.capabilities.includes('film-production-sync/1'));
  save(path.join(root, 'doctor-connected.json'), identity);
  const wrong = path.join(root, 'wrong-data'); fs.mkdirSync(path.join(wrong, 'storage/run'), { recursive: true });
  save(path.join(wrong, 'storage/run/electron-service.json'), state);
  const wrongResult = await cli('doctor', wrong).then(() => null, error => error);
  assert.ok(wrongResult && /实例或数据目录身份不匹配/.test(wrongResult.stderr));
  save(path.join(root, 'doctor-wrong-data.json'), { ok: true, rejected: true, message: wrongResult.stderr.trim() });
  const production = await cli('begin', dataRoot, beginFile); assert.deepEqual(await cli('begin', dataRoot, beginFile), production);
  save(path.join(root, 'production.json'), production);
  const film = production.films[0];
  assert.equal((await cli('sync', dataRoot, film.id, syncFile)).revision, 1);
  assert.deepEqual(await cli('sync', dataRoot, film.id, syncFile), { itemId: film.id, revision: 1 });
  console.log('PASS real CLI begin/sync, shared historical scene identity and replay');
  const counts = () => Object.fromEntries(['projects','shot_sets','shots','jobs','video_jobs','script_drafts'].map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  const initialCounts = counts(); assert.equal(initialCounts.jobs, 7); assert.equal(initialCounts.video_jobs, 8);
  const go = async tab => { await page.goto(`${state.origin}/projects/${production.projectId}?tab=${tab}`); const card = page.getByTestId('production-01'); await card.waitFor(); return card; };
  await go('scene'); await wait(() => page.getByTestId('production-01').locator('img').evaluateAll(images => images.length === 1 && images.every(img => img.complete && img.naturalWidth > 0)));
  const shots = await go('storyboard'); assert.equal(await shots.locator('img').count(), 6);
  await wait(() => shots.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0)));
  const script = await go('script'); await script.getByText(sync.snapshot.script.narration, { exact: true }).waitFor();
  const videos = await go('video'); assert.equal(await videos.locator('video').count(), 8);
  await wait(() => videos.locator('video').first().evaluate(v => v.readyState >= 1 && v.videoWidth > 0));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => { w.restore(); w.showInactive(); }));
  await page.screenshot({ path: path.join(root, 'production-real-videos.png') });
  console.log('PASS actual five-step historical image/script/video sources, starting local baseline render');
  const rendered = await exec(process.execPath, ['scripts/film-render.ts', 'render', path.join(project, 'render-spec.json'), '--run-id', 'baseline', '--progress-json'], { env, windowsHide: true, encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(root, 'baseline-render.log'), rendered.stdout + rendered.stderr);
  const run = path.join(project, 'variants/01/renders/baseline'), manifest = read(path.join(run, 'render-manifest.json'));
  assert.ok(manifest.ok && manifest.checks.ok);
  const gate = await exec(process.execPath, ['scripts/film-render.ts', 'gate', project, '01'], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  save(path.join(root, 'opening-gate.json'), JSON.parse(gate.stdout));
  console.log('PASS local real baseline render and historical opening gate');
  const delivery = path.join(root, '客户交付'); fs.mkdirSync(delivery);
  const spec = read(path.join(run, 'spec.json')), baseName = spec.project.baseName;
  for (const [kind, suffix] of [['video','.mp4'],['cover','-封面.jpg']]) fs.copyFileSync(manifest.outputs[kind], path.join(delivery, baseName + suffix), fs.constants.COPYFILE_EXCL);
  const files = { ...sync.snapshot.files };
  for (const file of [path.join(run,'spec.json'),path.join(run,'render-manifest.json'),manifest.outputs.video,manifest.outputs.cover]) files[path.relative(project,file).split(path.sep).join('/')] = sha(file);
  const scene = sync.snapshot.tasks.find(t => t.kind === 'scene');
  const importedManifest = { schemaVersion: 1, importKey: film.importKey, projectId: production.projectId, root: project, title: film.title,
    sceneImage: sync.snapshot.sceneImage, sceneProvenance: { provider: scene.providerId, model: scene.model, prompt: scene.prompt, localTaskId: scene.id, remoteTaskId: scene.remoteTaskId },
    specFile: path.relative(project,path.join(run,'spec.json')).split(path.sep).join('/'), renderManifestFile: path.relative(project,path.join(run,'render-manifest.json')).split(path.sep).join('/'), files,
    shots: sync.snapshot.shots.map(({ id,selectedCandidateId,candidates }) => ({ id,selectedCandidateId,candidates })), production: { itemId: film.id, expectedRevision: 1 }, delivery: { directory: delivery, baseName } };
  const importFile = path.join(root, 'import.json'); save(importFile, importedManifest);
  const binding = await cli('import', dataRoot, importFile);
  assert.equal(binding.groupId,film.groupId); assert.equal(binding.shotSetId,film.shotSetId); assert.equal(binding.variantId,film.variantId); assert.deepEqual(counts(),initialCounts);
  save(path.join(root, 'binding.json'), binding);
  const card = await go('final-edit'); await card.getByRole('link',{name:'编辑这条成片',exact:true}).click();
  await page.getByTestId('film-editor').waitFor();
  const before = await cli('current',dataRoot,film.groupId); assert.equal(before.revision,0);
  await page.getByRole('button',{name:'导出新版本',exact:true}).click();
  await page.getByRole('button',{name:'导出新版本（含原包装）',exact:true}).click();
  console.log('Unmodified workbench v2 render submitted');
  const get = async endpoint => (await page.request.get(state.origin+endpoint)).json();
  const job = await wait(async () => { const jobs=(await get(`/api/final-edit-groups/${film.groupId}`)).jobs.filter(j=>j.kind==='render'); const failed=jobs.find(j=>j.status==='failed'); assert.ok(!failed,failed?.errorMessage); return jobs.find(j=>j.status==='succeeded'); },900000);
  const output=(await get(`/api/final-edit-jobs/${job.id}`)).output;
  const workbenchRun=path.dirname(path.join(dataRoot,'storage',output.videoRelativePath));
  assert.ok(read(path.join(workbenchRun,'checks.json')).ok);
  const after = await cli('current',dataRoot,film.groupId);
  for (const key of ['revision','clips','content','originalContent','history','proposals','candidates']) assert.deepEqual(after[key],before[key],key);
  assert.equal(after.deliveryVersion,2); assert.equal(after.deliveredRevision,0);
  for (const [kind,suffix] of [['video','.mp4'],['cover','-封面.jpg']]) assert.equal(sha(path.join(delivery,'旧版',baseName+suffix)),manifest.outputs[kind+'Sha256']);
  await page.getByText('当前修改已导出',{exact:true}).waitFor({timeout:30000});
  await page.screenshot({path:path.join(root,'unmodified-delivery.png')});
  const originalFiles=read(path.join(root,'original-files.json'));
  for (const entry of Object.values(originalFiles)) assert.equal(sha(entry.source),entry.sha256);
  assert.equal(sha(fixture.originalVideo),fixture.originalVideoSha256); assert.equal(sha(fixture.originalCover),fixture.originalCoverSha256);
  result={ok:true,paidCalls:0,historicalReuse:true,root,project,dataRoot,production,bindingId:binding.id,groupId:film.groupId,shotSetId:film.shotSetId,variantId:film.variantId,baselineRun:run,workbenchRun,output,counts:counts(),sharedScenePreserved:true,originalFilesPreserved:true,unmodifiedRevision:0};
} catch(error) {
  const page=app.windows()[0];if(page){fs.writeFileSync(path.join(root,'failure-ui.txt'),await page.locator('body').ariaSnapshot().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png'),timeout:3000}).catch(()=>{});}throw error;
} finally {
  if(state){const health=await fetch(state.origin+'/api/desktop/health').then(r=>r.json()).catch(()=>null);if(health?.instanceId===state.instanceId)await fetch(state.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>{});}
  await wait(()=>handle.exitCode!==null||handle.signalCode!==null,30000).catch(()=>handle.kill('SIGKILL'));db.close();
}
assert.equal(handle.exitCode,0);assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/electron-service.json')));
save(path.join(root,'handoff-result.json'),result);console.log('PASS real historical material CLI-to-workbench handoff and unmodified export:',root);
