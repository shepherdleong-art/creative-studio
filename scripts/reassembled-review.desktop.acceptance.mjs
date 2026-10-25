// Fresh synthetic fixture from reassembled-film.integration.acceptance.ts, under
// outputs/2026-10-19-review-handoff. Never uses a user's database or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_REVIEW_FIXTURE, 'utf8'));
const root = fs.realpathSync(fixture.root), appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
assert.ok(root.startsWith(path.resolve('outputs/2026-10-19-review-handoff') + path.sep) && path.basename(root).startsWith('reassembled-P1-'));
const evidence = fs.mkdtempSync(path.join(root, 'review-desktop-'));
const db = new Database(path.join(root, 'data/workbench.db'));
db.prepare("UPDATE providers SET enabled=0,apiKey=''").run();
db.prepare("UPDATE video_providers SET enabled=0,apiKey=''").run();
db.prepare("UPDATE final_edit_jobs SET status='cancelled' WHERE status IN ('queued','running')").run();
db.prepare("DELETE FROM final_edit_film_deliveries WHERE status='reserved'").run();
const initialDb = db.prepare('SELECT candidatesJson,specJson,deliveryVersion FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId);
db.close();
const dataHash = createHash('sha256').update(root).digest('hex');
const key = `HKCU\\Software\\Classes\\creative-studio-film-${dataHash.slice(0,16)}`;
assert.equal(spawnSync('reg.exe', ['query', key], { windowsHide: true, stdio: 'pipe' }).status, 1);
const node = process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath;
const cli = (...args) => JSON.parse(execFileSync(node, [path.join(appRoot, 'scripts/reassembled-workbench.mjs'), ...args], { cwd: appRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore','pipe','pipe'] }));
const stateFile = path.join(root, 'storage/run/electron-service.json');
const statusFile = path.join(root, 'storage/run/reassembled-launch-status.json');
const wait = async (fn, timeout=60000) => { const until=Date.now()+timeout; while(Date.now()<until) { const result=await fn(); if(result) return result; await new Promise(r=>setTimeout(r,200)); } throw new Error('Review acceptance timed out'); };
const readState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : null;
const appEnv = {...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_NODE: node, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER:'0', CREATIVE_STUDIO_CANVAS_ENABLE:'0', CREATIVE_STUDIO_LAUNCH_NO_DIALOG:'1'};
for(const name of Object.keys(appEnv)) if(name.startsWith('CREATIVE_STUDIO_COS_')) appEnv[name]='';
for(const name of ['ELECTRON_RUN_AS_NODE','CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE']) delete appEnv[name];
let registered=false, state, app, handle;
const shutdown = async () => {
  const current=readState(); if(!current) return;
  const identity=await (await fetch(current.origin+'/api/reassembled-films/capabilities')).json();
  assert.equal(identity.dataIdentity,dataHash); assert.equal(identity.instanceId,current.instanceId);
  await fetch(current.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)});
  await wait(()=>!fs.existsSync(stateFile),30000);
};
const dispatch = uri => execFileSync('powershell.exe',['-NoProfile','-Command','Start-Process -FilePath $env:CREATIVE_STUDIO_TEST_REVIEW_URI -WindowStyle Hidden'],{cwd:appRoot,env:{...appEnv,CREATIVE_STUDIO_TEST_REVIEW_URI:uri},windowsHide:true,stdio:'pipe',timeout:15000});
try {
  app=await electron.launch({args:[appRoot,`--user-data-dir=${path.join(root,'electron-review')}`],cwd:appRoot,env:appEnv,timeout:60000,...(process.env.FILM_DESKTOP_APP_ROOT?{executablePath:path.join(appRoot,'node_modules/electron/dist/electron.exe')}:{})});
  handle=app.process();
  const page=await app.firstWindow(); await page.waitForURL(/127\.0\.0\.1/,{timeout:60000});
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()) window.minimize();});
  state=readState(); registered=true; const connected=cli('connect',root);
  assert.equal(connected.dataIdentity,dataHash);
  cli('review',root,fixture.bindingId);
  const htmlFile=fs.readdirSync(fixture.delivery).find(name=>name.endsWith('.html'));
  const html=fs.readFileSync(path.join(fixture.delivery,htmlFile),'utf8');
  const uri=html.match(/href="(creative-studio-film-[^"]+)"/)[1].replaceAll('&amp;','&');
  const served=await fetch(`${state.origin}/api/reassembled-films/${fixture.bindingId}/review`);
  assert.equal(served.status,200); const markup=await served.text();
  const poster=markup.match(/poster="([^"]+)"/)[1].replaceAll('&amp;','&');
  assert.equal(poster,`/api/reassembled-films/${fixture.bindingId}/cover?version=1`);
  const cover=await fetch(state.origin+poster); assert.equal(cover.status,200); assert.match(cover.headers.get('content-type'),/image\/jpeg/);
  const image=Buffer.from(await cover.arrayBuffer()), meta=await sharp(image).metadata();
  assert.ok(meta.width>0&&meta.height>0); fs.writeFileSync(path.join(evidence,'served-cover.jpg'),image);
  assert.equal((await fetch(`${state.origin}/api/reassembled-films/${fixture.bindingId}/cover?version=999`)).status,404);
  let hot;
  try { hot=JSON.parse(execFileSync(node,[path.join(appRoot,'scripts/reassembled-launch.mjs'),'open',root,uri],{cwd:appRoot,env:appEnv,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:90000})); }
  catch(error) { throw new Error(`Review helper failed: ${error.stderr?.toString() || error.code || 'unknown error'}`); } // Never print argv containing the review token.
  assert.equal(hot.navigationConfirmed,true); assert.equal(hot.instanceId,state.instanceId);
  await page.getByTestId('film-editor').waitFor({timeout:60000});
  const target=new URL(page.url()); assert.equal(target.searchParams.get('filmGroup'),fixture.groupId); assert.equal(target.searchParams.get('filmShotSet'),fixture.shotSetId);
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()) {window.restore();window.showInactive();}});
  const preview=page.getByTestId('film-editor').locator('video').first();
  await wait(()=>preview.evaluate(video=>video.readyState>=2&&video.videoWidth>0));
  await preview.evaluate(async video=>{video.muted=true;await video.play();});
  await wait(()=>preview.evaluate(video=>video.currentTime>0.1)); await preview.evaluate(video=>video.pause());
  await page.screenshot({path:path.join(evidence,'hot-editor.png'),timeout:15000});
  console.log('PASS served JPEG decode and actual hot editor navigation');
  await shutdown(); await wait(()=>handle.exitCode!==null,30000); assert.equal(handle.exitCode,0);
  fs.unlinkSync(statusFile);
  const launchErrorFile=path.join(root,'storage/logs/reassembled-launch-error.json'); fs.rmSync(launchErrorFile,{force:true});
  dispatch(uri);
  const cold=await wait(()=>{
    if(fs.existsSync(launchErrorFile)) throw new Error(fs.readFileSync(launchErrorFile,'utf8'));
    return fs.existsSync(statusFile)&&JSON.parse(fs.readFileSync(statusFile,'utf8'));
  },240000);
  assert.equal(cold.navigationConfirmed,true); assert.equal(cold.bindingId,fixture.bindingId); assert.equal(cold.version,1); assert.notEqual(cold.instanceId,state.instanceId);
  const coldState=readState(); assert.equal(coldState.instanceId,cold.instanceId);
  const identity=await (await fetch(coldState.origin+'/api/reassembled-films/capabilities')).json(); assert.equal(identity.dataIdentity,dataHash); assert.equal(fs.realpathSync(identity.applicationRoot),fs.realpathSync(appRoot));
  if(process.env.FILM_REVIEW_EXPECT_SIDECAR==='1') {
    const stack=JSON.parse(fs.readFileSync(path.join(root,'storage/run/stack.json'),'utf8'));
    assert.ok(stack.litellmPid>0); assert.equal((await fetch('http://127.0.0.1:4000/health/liveliness')).status,200);
  }
  console.log('PASS Windows protocol dispatch cold start and desktop load acknowledgement');
  fs.unlinkSync(statusFile); dispatch(uri);
  const repeat=await wait(()=>fs.existsSync(statusFile)&&JSON.parse(fs.readFileSync(statusFile,'utf8')));
  assert.equal(repeat.navigationConfirmed,true); assert.equal(repeat.instanceId,cold.instanceId,'Hot OS protocol must reuse the existing desktop');
  const finalDb=new Database(path.join(root,'data/workbench.db'),{readonly:true});
  assert.deepEqual(finalDb.prepare('SELECT candidatesJson,specJson,deliveryVersion FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId),initialDb);
  assert.equal(finalDb.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','running','retrying')").get().n,0); finalDb.close();
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({ok:true,root,appRoot,paidCalls:0,cover:{width:meta.width,height:meta.height},hot,cold,repeat,checks:['served-jpeg-decoded','invalid-cover-version-denied','hot-editor-visible','preview-video-plays','cold-os-protocol-dispatch','new-instance-identity','desktop-load-confirmed','repeated-open-reuses-desktop','film-data-unchanged']},null,2));
} finally {
  await shutdown();
  if(registered) cli('disconnect',root);
}
assert.equal(spawnSync('reg.exe',['query',key],{windowsHide:true,stdio:'pipe'}).status,1);
assert.ok(!fs.existsSync(stateFile));
await wait(()=>!fs.existsSync(path.join(root,'storage/run/stack.json')),30000);
console.log(`PASS actual Windows review handoff: ${evidence}`);
