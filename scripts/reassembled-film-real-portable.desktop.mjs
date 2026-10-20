// Reopen the final real handoff in the newly assembled portable desktop, without regeneration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const fixture=read(process.env.FILM_REAL_FIXTURE),{root,dataRoot}=fixture;
assert.ok(root.includes('2026-10-19-real-handoff'));
const final=read(path.join(root,'final-rework/result.json')),expected=read(path.join(root,'final-rework/before-export.json')),handoff=read(path.join(root,'handoff-result.json'));
const appRoot=path.resolve(process.env.FILM_DESKTOP_APP_ROOT);assert.ok(appRoot.includes('免安装 最终联动 QA'));
const evidence=fs.mkdtempSync(path.join(root,'portable-final-'));
const db=new Database(path.join(dataRoot,'data/workbench.db'));db.prepare('UPDATE providers SET enabled=0').run();db.prepare('UPDATE video_providers SET enabled=0').run();
const generated=read(path.join(root,'real-generation/video-result.json'));
assert.equal(db.prepare('SELECT multiShot FROM video_jobs WHERE id=?').get(generated.jobId).multiShot,0);
const count=()=>({images:db.prepare('SELECT COUNT(*) n FROM jobs').get().n,videos:db.prepare('SELECT COUNT(*) n FROM video_jobs').get().n});const initialCount=count();
const node=path.join(appRoot,'node-runtime/node.exe'),env={...process.env,CREATIVE_STUDIO_DATA_ROOT:dataRoot,CREATIVE_STUDIO_NODE:node,CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER:'0',CREATIVE_STUDIO_CANVAS_ENABLE:'0'};
for(const k of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE'])delete env[k];
const exec=promisify(execFile),cli=async(...args)=>JSON.parse((await exec(node,[path.join(appRoot,'scripts/reassembled-workbench.mjs'),...args],{env,windowsHide:true,timeout:300000,maxBuffer:8*1024*1024})).stdout);
const wait=async(fn,t=90000)=>{const end=Date.now()+t;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,500));}throw new Error('Portable acceptance timeout');};
const app=await electron.launch({executablePath:path.join(appRoot,'node_modules/electron/dist/electron.exe'),args:[appRoot,`--user-data-dir=${path.join(evidence,'electron')}`],cwd:appRoot,env,timeout:60000});
const handle=app.process();let state,result;
try{
  const page=await app.firstWindow();await page.waitForURL(/127\.0\.0\.1/,{timeout:60000});state=read(path.join(dataRoot,'storage/run/electron-service.json'));
  const current=await cli('current',dataRoot,handoff.groupId);assert.equal(current.revision,3);assert.equal(current.deliveryVersion,4);assert.deepEqual(current.content,expected.content);assert.deepEqual(current.clips,expected.clips);
  await page.goto(`${state.origin}/projects/${handoff.production.projectId}?tab=final-edit&filmGroup=${handoff.groupId}&filmShotSet=${handoff.shotSetId}`);await page.getByTestId('film-editor').waitFor({timeout:60000});
  await page.getByLabel('选择镜头',{exact:true}).selectOption('v01-Q2-D01');
  assert.equal(current.clips.find(c=>c.id==='v01-Q2-D01').videoJobId,generated.jobId);
  // The candidate picker is a replacement draft, not the persisted timeline selection.
  await page.getByLabel('已有候选',{exact:true}).selectOption(generated.jobId);
  assert.equal(await page.getByLabel('已有候选',{exact:true}).inputValue(),generated.jobId);
  await page.getByRole('button',{name:'编辑包装、字幕与音乐',exact:true}).click();assert.equal(await page.getByLabel('主标题',{exact:true}).inputValue(),'卧室梳妆日常');assert.equal(await page.getByLabel('副标题',{exact:true}).inputValue(),'六斗收纳的梳妆角');
  await page.getByRole('button',{name:'字幕',exact:true}).click();assert.equal(await page.getByLabel('字幕 1',{exact:true}).inputValue(),'卧室不大，');
  await page.getByRole('button',{name:'音乐',exact:true}).click();assert.equal(await page.getByLabel('音乐音量（dB）',{exact:true}).inputValue(),'-16');
  await page.getByRole('button',{name:'取消修改',exact:true}).click();await page.screenshot({path:path.join(evidence,'portable-editor-v4.png')});
  await page.goto(`${state.origin}/api/reassembled-films/${handoff.bindingId}/review`);await page.locator('[data-delivery-version="4"]').waitFor();const player=page.locator('video');await wait(()=>player.evaluate(v=>v.readyState>=2&&v.videoWidth>0));
  const src=await player.evaluate(async v=>{v.muted=true;await v.play();return v.currentSrc;});await wait(()=>player.evaluate(v=>v.currentTime>.5));await player.evaluate(v=>v.pause());
  const response=await page.request.get(src);assert.ok(response.ok());assert.equal(createHash('sha256').update(await response.body()).digest('hex'),final.videoSha256);
  assert.deepEqual(await cli('current',dataRoot,handoff.groupId),current);assert.deepEqual(count(),initialCount);
  await page.screenshot({path:path.join(evidence,'portable-review-v4.png')});result={ok:true,paidCalls:0,appRoot,evidence,revision:3,deliveryVersion:4,contentPreserved:true,clipsPreserved:true,jobCountsUnchanged:initialCount,storedMultiShot:0,videoSha256:final.videoSha256};
}finally{
  if(state){const health=await fetch(state.origin+'/api/desktop/health').then(r=>r.json()).catch(()=>null);if(health?.instanceId===state.instanceId)await fetch(state.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>{});}
  await wait(()=>handle.exitCode!==null||handle.signalCode!==null,30000).catch(()=>handle.kill('SIGKILL'));db.close();
}
assert.equal(handle.exitCode,0);assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/electron-service.json')));fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log('PASS portable real final state and v4 playback:',evidence);
