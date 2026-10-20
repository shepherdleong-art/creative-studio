// Real historical material, human UI content edit + local render; all generation providers disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const save = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2));
const fixture = read(process.env.FILM_REAL_FIXTURE), { dataRoot, root } = fixture;
assert.ok(root.includes('2026-10-19-real-handoff') && fixture.historicalReuse);
const handoff = read(path.join(root, 'handoff-result.json'));
assert.ok(!fs.existsSync(path.join(root, 'manual-edit-result.json')), 'Never replay a completed manual edit');
const evidence = fs.mkdtempSync(path.join(root, 'manual-edit-'));
const resume = process.env.FILM_REAL_EDIT_RESUME && path.resolve(process.env.FILM_REAL_EDIT_RESUME);
if(resume)assert.ok(resume.startsWith(path.resolve(root)+path.sep));
const db = new Database(path.join(dataRoot, 'data/workbench.db'));
db.prepare('UPDATE providers SET enabled=0').run();
db.prepare('UPDATE video_providers SET enabled=0').run();
assert.equal(db.prepare('SELECT COUNT(*) n FROM providers WHERE enabled=1').get().n, 0);
assert.equal(db.prepare('SELECT COUNT(*) n FROM video_providers WHERE enabled=1').get().n, 0);
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const node = process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath;
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot, CREATIVE_STUDIO_NODE: node, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE']) delete env[key];
const exec = promisify(execFile);
const cli = async (...args) => JSON.parse((await exec(node, [path.join(appRoot, 'scripts/reassembled-workbench.mjs'), ...args], { env, windowsHide: true, timeout: 30000, maxBuffer: 8*1024*1024 })).stdout);
const wait = async (fn, timeout=90000) => { const end=Date.now()+timeout; while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,500));}throw new Error('Timeout'); };
const app = await electron.launch({ args:[appRoot,`--user-data-dir=${path.join(evidence,'electron')}`],cwd:appRoot,env,timeout:60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? {executablePath:path.join(appRoot,'node_modules/electron/dist/electron.exe')} : {}) });
const handle=app.process();let state,result;
try {
  const page=await app.firstWindow();await page.waitForURL(/127\.0\.0\.1/,{timeout:60000});
  state=read(path.join(dataRoot,'storage/run/electron-service.json'));
  const get=async url=>(await page.request.get(state.origin+url)).json();
  const live=await cli('current',dataRoot,handoff.groupId);
  const before=resume?read(path.join(resume,'before.json')):live;save(path.join(evidence,'before.json'),before);
  assert.equal(before.revision,0,'Expected the untouched accepted baseline');
  if(resume){const saved=read(path.join(resume,'manual-content.json'));assert.equal(live.revision,1);assert.deepEqual(live.content,saved.content);assert.deepEqual(live.clips,saved.clips);}
  await page.goto(`${state.origin}/projects/${handoff.production.projectId}?tab=final-edit&filmGroup=${handoff.groupId}&filmShotSet=${handoff.shotSetId}`);
  await page.getByTestId('film-editor').waitFor({timeout:60000});
  if(!resume){
  await page.getByRole('button',{name:'编辑包装、字幕与音乐',exact:true}).click();
  await page.getByLabel('副标题',{exact:true}).fill('六斗收纳的梳妆角');
  for(let n=1;n<=3;n++) {
    const section=page.getByText(`卖点 ${n}版式（画布百分比）`,{exact:true}).locator('..');
    if(await section.getByRole('button',{name:'自定义位置',exact:true}).count())await section.getByRole('button',{name:'自定义位置',exact:true}).click();
    await page.getByLabel(`卖点 ${n} X`,{exact:true}).fill('50');
    await page.getByLabel(`卖点 ${n} Y`,{exact:true}).fill('14');
  }
  await page.getByRole('button',{name:'字幕',exact:true}).click();
  await page.getByLabel('字幕 1',{exact:true}).fill('卧室不大，');
  await page.getByRole('button',{name:'音乐',exact:true}).click();
  await page.getByLabel('音乐音量（dB）',{exact:true}).fill('-16');
  await page.getByRole('button',{name:'保存成片内容',exact:true}).click();
  await page.getByRole('region',{name:'成片内容编辑',exact:true}).waitFor({state:'hidden'});
  }
  const edited=await cli('current',dataRoot,handoff.groupId);
  assert.equal(edited.revision,1);assert.deepEqual(edited.clips,before.clips);assert.deepEqual(edited.candidates,before.candidates);
  assert.equal(edited.content.decoration.packaging.varsOverrides.subtitle,'六斗收纳的梳妆角');
  assert.equal(edited.content.subtitles[0].text,'卧室不大，');assert.equal(edited.content.music.gainDb,-16);
  for(const id of ['detail','top','storage'])assert.deepEqual(edited.content.decoration.packaging.layouts['overlay-poster'].cues[id],{x:50,y:14,scale:1});
  save(path.join(evidence,'manual-content.json'),edited);
  await page.getByRole('button',{name:'导出新版本',exact:true}).click();
  await page.getByRole('button',{name:'导出新版本（含当前包装）',exact:true}).click();
  const job=await wait(async()=>{const jobs=(await get(`/api/final-edit-groups/${handoff.groupId}`)).jobs.filter(j=>j.kind==='render'&&j.renderRevision?.variantRevision===1);const failed=jobs.find(j=>j.status==='failed');assert.ok(!failed,failed?.errorMessage);return jobs.find(j=>j.status==='succeeded');},900000);
  const output=(await get(`/api/final-edit-jobs/${job.id}`)).output;
  const run=path.dirname(path.join(dataRoot,'storage',output.videoRelativePath));assert.ok(read(path.join(run,'checks.json')).ok);
  const after=await cli('current',dataRoot,handoff.groupId);assert.equal(after.deliveredRevision,1);assert.equal(after.deliveryVersion,3);
  assert.deepEqual(after.content,edited.content);assert.deepEqual(after.clips,before.clips);
  const v2=path.join(root,'客户交付','旧版',handoff.output.videoFilename);
  const oldHash=createHash('sha256').update(fs.readFileSync(v2)).digest('hex');
  assert.equal(oldHash,read(path.join(handoff.workbenchRun,'render-manifest.json')).outputs.videoSha256);
  await page.getByText('当前修改已导出',{exact:true}).waitFor();await page.screenshot({path:path.join(evidence,'manual-v3-delivery.png')});
  result={ok:true,paidCalls:0,root,dataRoot,appRoot,evidence,run,output,revision:1,deliveryVersion:3,oldV2Hash:oldHash,allClipSelectionsPreserved:true,content:after.content,visualReviewPending:true};
} finally {
  if(state){const health=await fetch(state.origin+'/api/desktop/health').then(r=>r.json()).catch(()=>null);if(health?.instanceId===state.instanceId)await fetch(state.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>{});}
  await wait(()=>handle.exitCode!==null||handle.signalCode!==null,30000).catch(()=>handle.kill('SIGKILL'));db.close();
}
assert.equal(handle.exitCode,0);assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/electron-service.json')));
save(path.join(root,'manual-edit-result.json'),result);console.log('PASS actual manual layout/subtitle/music v3 export:',evidence);
